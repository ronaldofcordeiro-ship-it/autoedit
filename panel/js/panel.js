// AutoEdit panel: options → progress → review → done.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const KINDS = { silencio: 'PAUSA', repeticao: 'REPETIÇÃO', vicio: 'VÍCIO', falso_inicio: 'FALSO INÍCIO' };
const STEPS = [
  { id: 'probe', now: 'lendo a sua sequência', done: 'Li a sua sequência' },
  { id: 'voice', now: 'separando a sua voz', done: 'Separei a sua voz' },
  { id: 'listen', now: 'ouvindo o que você falou', done: 'Ouvi tudo que você falou' },
  { id: 'decide', now: 'decidindo os cortes', done: 'Decidi os cortes' },
  { id: 'build', now: 'montando a sequência nova', done: 'Montei a sequência nova' },
];

// ------------------------------------------------------------ settings
const DEFAULT_SETTINGS = { name: '', license: '', language: 'pt', brain: '', engine: 'http://127.0.0.1:47380' };
const DEFAULT_OPTIONS = {
  silences: true, silenceMode: 'dinamico', repetitions: true, fillers: true, jcut: true,
  levelVoice: true, zoom: false, zoomStrength: 'medio', zoomWhere: 'cuts',
};

function load(key, fallback) {
  try { return Object.assign({}, fallback, JSON.parse(localStorage.getItem(key) || '{}')); } catch (e) { return Object.assign({}, fallback); }
}
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } }

let settings = load('autoedit.settings', DEFAULT_SETTINGS);
let options = load('autoedit.options', DEFAULT_OPTIONS);
Engine.setBase(settings.engine);

// ------------------------------------------------------------ helpers
const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
};
const firstName = () => (settings.name ? ', ' + settings.name.split(' ')[0] : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(text, isError) {
  const m = $('#message');
  m.textContent = text || '';
  m.className = 'message' + (isError ? ' err' : '');
}

function show(screen) {
  $$('.screen').forEach((s) => s.classList.add('hidden'));
  $('#screen-' + screen).classList.remove('hidden');
  $('#dock').classList.toggle('hidden', screen !== 'home');
  $('#scroll').scrollTop = 0;
}

// ------------------------------------------------------------ options screen
function paintOptions() {
  // Premiere's UXP doesn't always restyle children when a parent class changes,
  // so the on/off pieces are shown and hidden directly.
  $$('.card[data-opt]').forEach((card) => {
    const on = !!options[card.dataset.opt];
    card.classList.toggle('on', on);
    card.querySelectorAll('.b-on').forEach((el) => { el.style.display = on ? 'inline-flex' : 'none'; });
    card.querySelectorAll('.b-off').forEach((el) => { el.style.display = on ? 'none' : 'inline-flex'; });
    card.querySelectorAll('.seg').forEach((el) => { el.style.display = on ? 'flex' : 'none'; });
  });
  $$('.seg[data-seg]').forEach((seg) => {
    const v = options[seg.dataset.seg];
    Array.from(seg.children).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  const cuts = ['silences', 'repetitions', 'fillers', 'jcut'].filter((k) => options[k]).length;
  const voice = ['levelVoice', 'zoom'].filter((k) => options[k]).length;
  $('#countCuts').textContent = cuts + ' de 4';
  $('#countVoice').textContent = voice + ' de 2';
}

$$('.card[data-opt]').forEach((card) => card.addEventListener('click', (e) => {
  if (e.target.closest('.seg')) return;
  options[card.dataset.opt] = !options[card.dataset.opt];
  save('autoedit.options', options);
  paintOptions();
}));
$$('.seg[data-seg] .btn').forEach((b) => b.addEventListener('click', () => {
  options[b.parentElement.dataset.seg] = b.dataset.v;
  save('autoedit.options', options);
  paintOptions();
}));

function engineOptions() {
  return {
    silences: { on: options.silences, mode: options.silenceMode },
    repetitions: options.repetitions,
    fillers: options.fillers,
    jcut: { on: options.jcut, frames: 4 },
    levelVoice: { on: options.levelVoice, targetLufs: -14 },
    zoom: { on: options.zoom, strength: options.zoomStrength, alsoWithoutCut: options.zoomWhere === 'also' },
    language: settings.language,
  };
}

// ------------------------------------------------------------ header
async function refreshHeader() {
  try {
    const s = await Premiere.summary();
    $('#seqName').textContent = s.name;
    $('#seqDur').textContent = fmt(s.duration);
    $('#seqFps').textContent = String(s.fps).replace('.', ',');
    const r = s.width / s.height;
    $('#seqFmt').textContent = r > 1.5 ? '16:9' : r < 0.7 ? '9:16' : r > 0.95 && r < 1.05 ? '1:1' : '4:5';
    // Same rule as the done screen: about 4x the raw length by hand.
    $('#heroSaved').textContent = '~' + Math.max(1, Math.round((s.duration * 4) / 60)) + ' min';
  } catch (e) {
    $('#seqName').textContent = 'Abra uma sequência';
    $('#seqDur').textContent = '--:--';
  }
  $('#heroName').textContent = firstName();
  $('#avatarInitial').textContent = (settings.name || 'A').charAt(0).toUpperCase();
  try {
    await Engine.health();
    $('#engineLed').className = 'dot ok';
  } catch (e) {
    $('#engineLed').className = 'dot on';
  }
}

// ------------------------------------------------------------ run
let job = null;       // engine job
let kept = new Set(); // indices of cuts the editor un-ticked
let edited = null;    // the sequence we created, for undo
let cancelled = false;

function paintSteps(step, progress, nowText) {
  const at = STEPS.findIndex((s) => s.id === step);
  $('#runSteps').innerHTML = STEPS.map((s, i) => {
    const cls = i < at ? 'done' : i === at ? 'now' : '';
    const label = i < at ? s.done : i === at ? 'Agora: ' + (nowText || s.now) : 'Depois: ' + s.now;
    return `<div class="step ${cls}"><span class="mark">${i < at ? '✓' : ''}</span>${label}</div>`;
  }).join('');
  $('#runPct').textContent = Math.round(progress) + '%';
  $('#runNow').textContent = at >= 0 ? (nowText || STEPS[at].now) : '';
  $('#runBar').style.width = progress + '%';
}

async function go() {
  say('');
  let sequence;
  try {
    sequence = await Premiere.readSequence();
  } catch (e) { return say(e.message, true); }
  if (!sequence.clips.length) return say('Não achei clipes de vídeo na trilha V1.', true);

  cancelled = false;
  $('#runName').textContent = firstName();
  paintSteps('probe', 0);
  show('run');
  try {
    // Premiere's own transcription is much faster than the engine's (GPU);
    // if this Premiere can't, the engine transcribes with whisper instead.
    let transcripts = [];
    try {
      paintSteps('listen', 4, 'pedindo a transcrição ao Premiere');
      const status = (text) => { if (!cancelled) paintSteps('listen', 10, text); };
      status.cancelled = () => cancelled;
      transcripts = await Premiere.transcripts(settings.language, status);
    } catch (e) { transcripts = []; }
    if (cancelled) return;
    job = await Engine.start({
      sequence,
      transcripts,
      options: engineOptions(),
      brain: settings.brain ? { url: settings.brain, license: settings.license } : undefined,
    });
    // Smooth the bar between engine updates so it never looks stuck.
    let shown = 0;
    while (job.status === 'rodando') {
      await sleep(400);
      if (cancelled) return;
      job = await Engine.status(job.id);
      shown = Math.max(shown, Math.min(job.progress + 8, shown + 0.6));
      paintSteps(job.step, Math.max(job.progress, shown));
    }
    if (job.status === 'erro') throw new Error(job.error);
    if (job.status !== 'pronto') return;
    kept = new Set();
    paintReview();
    show('review');
  } catch (e) {
    show('home');
    say(e.message || String(e), true);
  }
}

// ------------------------------------------------------------ review
function paintReview() {
  const r = job.result, plan = r.plan;
  $('#revBefore').textContent = fmt(plan.before);
  $('#revAfter').textContent = fmt(plan.after);
  $('#revInfo').textContent = r.brain === 'nuvem' ? 'cortes decididos pela IA' : 'modo offline';
  $('#revCount').textContent = plan.cuts.length + (plan.cuts.length === 1 ? ' corte' : ' cortes');
  const longest = Math.max(1, ...plan.cuts.map((c) => c.end - c.start));
  $('#revList').innerHTML = plan.cuts.map((c, i) => `
    <div class="cut" data-i="${i}">
      <div class="cut-top"><span class="kind">${KINDS[c.kind] || c.kind}</span><span class="dur">${(c.end - c.start).toFixed(1).replace('.', ',')} s</span></div>
      <div class="text">${c.text ? escapeHtml(c.text) : 'silêncio'}</div>
      <div class="line"><div style="width:${Math.round(((c.end - c.start) / longest) * 100)}%"></div></div>
    </div>`).join('') || '<div class="cut"><div class="text dim">Nada para cortar. O vídeo já está limpo.</div></div>';
  $$('#revList .cut[data-i]').forEach((el) => el.addEventListener('click', () => toggleCut(Number(el.dataset.i), el)));
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function toggleCut(i, el) {
  if (kept.has(i)) kept.delete(i); else kept.add(i);
  el.classList.toggle('kept', kept.has(i));
  const plan = job.result.plan;
  const saved = plan.cuts.reduce((s, c, k) => s + (kept.has(k) ? 0 : c.end - c.start), 0);
  $('#revAfter').textContent = fmt(plan.before - saved);
}

async function apply() {
  if ($('#applyBtn').classList.contains('disabled')) return;
  say('');
  $('#applyBtn').classList.add('disabled');
  try {
    const plan = job.result.plan;
    if (kept.size) {
      const keep = plan.cuts.filter((_, i) => kept.has(i)).map((c) => ({ start: c.start, end: c.end }));
      job = await Engine.rebuild(job.id, keep);
    }
    edited = await Premiere.importEdit(job.result.xmlPath, job.result.sequenceName);
    paintDone();
    show('done');
  } catch (e) {
    say(e.message || String(e), true);
  } finally {
    $('#applyBtn').classList.remove('disabled');
  }
}

// ------------------------------------------------------------ done
function paintDone() {
  const r = job.result, plan = r.plan;
  $('#doneName').textContent = firstName();
  $('#doneSeq').textContent = r.sequenceName;
  $('#doneBefore').textContent = fmt(plan.before);
  $('#doneAfter').textContent = fmt(plan.after);
  $('#doneTime').textContent = 'feito em ' + Math.max(1, Math.round(r.seconds)) + ' s';
  const count = (k) => plan.cuts.filter((c) => c.kind === k).length;
  const pills = [];
  const pill = (n, label) => pills.push(`<span class="pill"><b>${n}</b> ${label}</span>`);
  if (count('silencio')) pill(count('silencio'), 'pausas');
  if (count('repeticao') + count('falso_inicio')) pill(count('repeticao') + count('falso_inicio'), 'repetições');
  if (count('vicio')) pill(count('vicio'), 'vícios');
  const zooms = plan.segments.filter((s) => s.zoom > 1).length;
  if (zooms) pill(zooms, 'zooms');
  if (plan.gainDb) pill((plan.gainDb > 0 ? '+' : '') + String(plan.gainDb).replace('.', ',') + ' dB', 'na voz');
  $('#donePills').innerHTML = pills.join('');
  // A careful editor spends about 4x the raw length plus ~15 s per cut on this.
  const minutes = Math.round((plan.before * 4 + plan.cuts.length * 15) / 60);
  $('#doneSaved').textContent = minutes >= 1 ? `~${minutes} min economizados` : '';
}

async function undo() {
  if (!edited) return;
  try {
    await Premiere.removeEdit(edited);
    edited = null;
    show('home');
    say('Edição desfeita. A sua sequência original continua lá.');
  } catch (e) { say(e.message, true); }
}

// ------------------------------------------------------------ settings screen
function openSettings() {
  $('#setName').value = settings.name;
  $('#setLicense').value = settings.license;
  $('#setLang').value = settings.language;
  $('#setBrain').value = settings.brain;
  $('#setEngine').value = settings.engine;
  show('settings');
}
function saveSettings() {
  settings = {
    name: $('#setName').value.trim(),
    license: $('#setLicense').value.trim(),
    language: $('#setLang').value,
    brain: $('#setBrain').value.trim(),
    engine: $('#setEngine').value.trim() || DEFAULT_SETTINGS.engine,
  };
  save('autoedit.settings', settings);
  Engine.setBase(settings.engine);
  show('home');
  refreshHeader();
}

// ------------------------------------------------------------ wiring
$('#goBtn').addEventListener('click', go);
$('#cancelBtn').addEventListener('click', async () => {
  cancelled = true;
  if (job) Engine.cancel(job.id).catch(() => {});
  show('home');
  say('Cancelado. Nada mudou na sua sequência.');
});
$('#applyBtn').addEventListener('click', apply);
$('#backBtn').addEventListener('click', () => show('home'));
$('#againBtn').addEventListener('click', () => { show('home'); refreshHeader(); });
$('#undoBtn').addEventListener('click', undo);
$('#settingsBtn').addEventListener('click', () => ($('#screen-settings').classList.contains('hidden') ? openSettings() : show('home')));
$('#saveSettings').addEventListener('click', saveSettings);

paintOptions();
refreshHeader();
setInterval(refreshHeader, 4000);
