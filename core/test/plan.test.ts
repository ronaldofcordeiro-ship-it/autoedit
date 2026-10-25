import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, buildXml, DEFAULT_OPTIONS, findFillers, findRepetitions, heuristicDecisions, parsePremiereTranscript, pathUrl, transcriptWords, type Word } from '../src/index.ts';

const W = (spec: string, start = 0, gap = 0.05, len = 0.3): Word[] => {
  // "a b | c" : "|" is a 1 s pause
  const out: Word[] = [];
  let t = start;
  for (const tok of spec.split(' ')) {
    if (tok === '|') { t += 1; continue; }
    out.push({ text: tok, start: t, end: t + len });
    t += len + gap;
  }
  return out;
};

test('fillers: sounds always, take phrases only between pauses', () => {
  const w = W('então ahn eu acho | ok valendo | o valendo é bom');
  const cuts = findFillers(w);
  assert.deepEqual(cuts.map((c) => w.slice(c.from, c.to + 1).map((x) => x.text).join(' ')), ['ahn', 'ok valendo']);
});

test('repetitions keep the last take', () => {
  const w = W('esse cara não existe | esse cara não existe de verdade | e eu criei ele');
  const cuts = findRepetitions(w);
  assert.equal(cuts.length, 1);
  assert.equal(w.slice(cuts[0].from, cuts[0].to + 1).map((x) => x.text).join(' '), 'esse cara não existe');
});

test('plan cuts pauses, fillers and repeats', () => {
  const w = W('esse cara não existe | esse cara não existe de verdade | ahn | e eu criei ele');
  const duration = w[w.length - 1].end + 2;
  const plan = buildPlan({ words: w, silences: [], duration, decisions: heuristicDecisions(w, { repetitions: true, fillers: true }), options: DEFAULT_OPTIONS });
  const kept = w.filter((x) => plan.segments.some((s) => x.start >= s.start - 1e-6 && x.end <= s.end + 1e-6)).map((x) => x.text).join(' ');
  assert.equal(kept, 'esse cara não existe de verdade e eu criei ele');
  assert.ok(plan.after < plan.before - 3);
  assert.ok(plan.cuts.some((c) => c.kind === 'repeticao'));
  assert.ok(plan.cuts.some((c) => c.kind === 'vicio'));
});

test('fluent narration is left almost whole', () => {
  const words: Word[] = JSON.parse(readFileSync(new URL('./fixtures/demo_words.json', import.meta.url), 'utf8'));
  const plan = buildPlan({ words, silences: [], duration: 46.48, decisions: heuristicDecisions(words, { repetitions: true, fillers: true }), options: DEFAULT_OPTIONS });
  assert.ok(plan.after > 44, `kept ${plan.after}`);
});

test('loudness gain respects the true peak', () => {
  const w = W('oi tudo bem');
  const plan = buildPlan({ words: w, silences: [], duration: 2, decisions: { cuts: [], highlights: [] }, options: DEFAULT_OPTIONS, loudness: { integrated: -24, truePeak: -4 } });
  assert.equal(plan.gainDb, 3);
});

test('xml: windows path, j-cut and zoom', () => {
  assert.equal(pathUrl('D:\\Vídeos\\take 1.mp4'), 'file://localhost/D%3a/V%C3%ADdeos/take%201.mp4');
  assert.equal(pathUrl('/Users/ana/a b.mov'), 'file://localhost/Users/ana/a%20b.mov');
  const seq = { name: 'S', fps: 30, width: 1920, height: 1080, audioRate: 48000,
    clips: [{ path: 'D:\\a.mp4', name: 'a.mp4', start: 0, end: 10, srcIn: 0, mediaDuration: 10 }] };
  const plan = { segments: [{ start: 0, end: 2, zoom: 1 }, { start: 3, end: 5, zoom: 1.15 }], cuts: [], gainDb: 0, before: 10, after: 4, highlights: [] };
  const xml = buildXml(plan, seq, { name: 'S (AutoEdit)', jcutFrames: 4 });
  // audio: 0-60, 60-120; video edge moves 4 frames later
  assert.match(xml, /<clipitem id="v-1">.*?<start>0<\/start><end>64<\/end><in>0<\/in><out>64<\/out>/);
  assert.match(xml, /<clipitem id="v-2">.*?<start>64<\/start><end>120<\/end><in>94<\/in><out>150<\/out>/);
  assert.match(xml, /<clipitem id="a1-2" premiereChannelType="mono">.*?<start>60<\/start><end>120<\/end><in>90<\/in><out>150<\/out>/);
  assert.match(xml, /<clipitem id="a2-2" premiereChannelType="mono">.*?<trackindex>2<\/trackindex><\/sourcetrack>/);
  assert.match(xml, /<parameterid>scale<\/parameterid>.*?<value>115<\/value>/);
  assert.equal((xml.match(/<pathurl>/g) || []).length, 1);
});

test('review: a cut the editor keeps comes back', () => {
  const w = W('esse cara não existe | esse cara não existe de verdade');
  const duration = w[w.length - 1].end + 1;
  const decisions = heuristicDecisions(w, { repetitions: true, fillers: true });
  const first = buildPlan({ words: w, silences: [], duration, decisions, options: DEFAULT_OPTIONS });
  const rep = first.cuts.find((c) => c.kind === 'repeticao')!;
  const again = buildPlan({ words: w, silences: [], duration, decisions, options: DEFAULT_OPTIONS, keep: [rep] });
  assert.ok(again.after > first.after + 1);
  assert.ok(!again.cuts.some((c) => c.kind === 'repeticao'));
});

test('silences: audio wins when whisper puts words inside an empty pause', () => {
  // Real phone take: whisper starts at 0.08 s, the audio is silent until 1.03 s,
  // and "café." is stretched over the 6.86–7.38 pause.
  const words: Word[] = [
    { text: 'Eu', start: 0.08, end: 0.18 }, { text: 'mesmo', start: 0.18, end: 0.64 }, { text: 'não', start: 0.64, end: 0.92 },
    { text: 'abro', start: 0.92, end: 1.28 }, { text: 'mão', start: 1.37, end: 4.2 }, { text: 'meu', start: 6.37, end: 6.46 },
    { text: 'café.', start: 6.46, end: 7.0 }, { text: 'E', start: 7.0, end: 7.1 }, { text: 'você', start: 7.1, end: 8.8 },
    { text: 'café?', start: 8.46, end: 9.24 }, { text: 'Conta', start: 9.24, end: 9.7 }, { text: 'experiência.', start: 10.57, end: 11.04 },
  ];
  const silences = [{ start: 0, end: 1.03175 }, { start: 1.03744, end: 1.25419 }, { start: 6.86431, end: 7.37956 }, { start: 8.90831, end: 9.76988 }, { start: 11.1474, end: 15.03 }];
  const plan = buildPlan({ words, silences, duration: 15.03, decisions: { cuts: [], highlights: [] }, options: DEFAULT_OPTIONS });
  const q = plan.cuts.filter((c) => c.kind === 'silencio').map((c) => [Math.round(c.start * 10) / 10, Math.round(c.end * 10) / 10]);
  assert.deepEqual(q[0][0], 0);
  assert.ok(q[0][1] >= 1.1, 'leading silence cut up to the voice');
  assert.ok(q.some(([s, e]) => s <= 7.0 && e >= 7.2), 'pause inside the take is cut');
  assert.ok(q.some(([s, e]) => s <= 9.0 && e >= 9.6), 'second pause is cut');
});

test('premiere transcript: words in any unit land on the timeline', () => {
  const json = JSON.stringify({ language: 'pt-br', segments: [{ start: 0, duration: 5, text: 'olá tudo bem', words: [
    { text: 'olá', start: 1.0, duration: 0.4 }, { text: 'tudo', start: 1.5, duration: 0.3 }, { text: 'bem', start: 6.2, duration: 0.3 },
  ] }] });
  const clips = [{ path: 'a.mp4', name: 'a', start: 10, end: 15, srcIn: 1, mediaDuration: 20 }];
  const w = transcriptWords(clips, [{ clip: 0, json }]);
  assert.deepEqual(w.map((x) => x.text), ['olá', 'tudo']);   // "bem" is past the clip's out point
  assert.equal(w[0].start, 10);
  assert.ok(Math.abs(w[1].start - 10.5) < 1e-9);
  const ticks = JSON.stringify([{ word: 'oi', startTime: 254016000000, endTime: 2 * 254016000000 }]);
  assert.deepEqual(parsePremiereTranscript(ticks, 10).map((x) => [x.start, x.end]), [[1, 2]]);
});
