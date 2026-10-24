import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, buildXml, DEFAULT_OPTIONS, findFillers, findRepetitions, heuristicDecisions, pathUrl, type Word } from '../src/index.ts';

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
