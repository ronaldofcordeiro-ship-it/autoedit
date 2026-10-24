// Offline decisions: fillers and repeated takes found from the words alone.
// The cloud brain does better (it understands meaning), but this keeps the
// plugin useful without internet and is the fallback when the brain fails.

import type { Decisions, Word } from './types.ts';

export function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1')
    .trim();
}

// Sounds that are never real words in that language ("um" is an article in Portuguese).
const FILLER_SOUNDS: Record<string, Set<string>> = {
  pt: new Set(['ahn', 'ah', 'aa', 'han', 'hum', 'hm', 'hmm', 'mm', 'eh', 'ee', 'aham']),
  en: new Set(['ahn', 'ah', 'uh', 'um', 'uhm', 'hm', 'hmm', 'mm', 'er', 'erm']),
  es: new Set(['ahn', 'ah', 'eh', 'ee', 'mm', 'hm', 'este']),
};
// Phrases editors say between takes. Only cut when isolated by pauses.
const TAKE_PHRASES = [['ok', 'valendo'], ['valendo'], ['gravando'], ['corta'], ['de', 'novo'], ['vou', 'de', 'novo'], ['de', 'novo', 'de', 'novo']];

const gapBefore = (w: Word[], i: number) => (i === 0 ? Infinity : w[i].start - w[i - 1].end);
const gapAfter = (w: Word[], i: number) => (i === w.length - 1 ? Infinity : w[i + 1].start - w[i].end);

export function findFillers(words: Word[], language = 'pt'): Decisions['cuts'] {
  const sounds = FILLER_SOUNDS[language.slice(0, 2)] ?? FILLER_SOUNDS.pt;
  const cuts: Decisions['cuts'] = [];
  const n = words.map((w) => norm(w.text));
  for (let i = 0; i < words.length; i++) {
    if (sounds.has(n[i])) { cuts.push({ from: i, to: i, kind: 'vicio' }); continue; }
    for (const phrase of TAKE_PHRASES) {
      const end = i + phrase.length - 1;
      if (end >= words.length) continue;
      if (!phrase.every((p, k) => n[i + k] === p)) continue;
      if (gapBefore(words, i) < 0.25 || gapAfter(words, end) < 0.25) continue;
      cuts.push({ from: i, to: end, kind: 'vicio' });
      i = end;
      break;
    }
  }
  return cuts;
}

/** Splits the words into phrases at pauses and sentence ends. Returns [from, to] index pairs. */
export function phrases(words: Word[], pause = 0.45): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    const stop = /[.!?]$/.test(words[i].text.trim()) || gapAfter(words, i) >= pause;
    if (last || stop) { out.push([from, i]); from = i + 1; }
  }
  return out;
}

function similarity(a: string[], b: string[]): { prefix: number; jaccard: number } {
  const k = Math.min(a.length, b.length);
  let same = 0;
  while (same < k && a[same] === b[same]) same++;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return { prefix: k ? same / k : 0, jaccard: inter / (sa.size + sb.size - inter || 1) };
}

/** Earlier takes of a phrase that is said again soon after: keep only the last take. */
export function findRepetitions(words: Word[], lookahead = 3): Decisions['cuts'] {
  const ps = phrases(words);
  const tokens = ps.map(([f, t]) => words.slice(f, t + 1).map((w) => norm(w.text)).filter(Boolean));
  const cuts: Decisions['cuts'] = [];
  for (let i = 0; i < ps.length; i++) {
    if (tokens[i].length < 2) continue;
    for (let j = i + 1; j <= Math.min(ps.length - 1, i + lookahead); j++) {
      const s = similarity(tokens[i], tokens[j]);
      if ((s.prefix >= 0.6 && Math.min(tokens[i].length, tokens[j].length) >= 2) || s.jaccard >= 0.7) {
        const kind = tokens[i].length < tokens[j].length * 0.5 ? 'falso_inicio' : 'repeticao';
        cuts.push({ from: ps[i][0], to: ps[i][1], kind });
        break;
      }
    }
  }
  return cuts;
}

/** Words that carry the meaning of a phrase: the longest non-trivial word of each phrase. */
export function findHighlights(words: Word[]): number[] {
  const out: number[] = [];
  for (const [f, t] of phrases(words)) {
    let best = -1;
    for (let i = f; i <= t; i++) {
      const n = norm(words[i].text);
      if (n.length < 5) continue;
      if (best < 0 || n.length > norm(words[best].text).length) best = i;
    }
    if (best >= 0) out.push(best);
  }
  return out;
}

export function heuristicDecisions(words: Word[], opts: { repetitions: boolean; fillers: boolean; language?: string }): Decisions {
  const cuts = [
    ...(opts.fillers ? findFillers(words, opts.language) : []),
    ...(opts.repetitions ? findRepetitions(words) : []),
  ].sort((a, b) => a.from - b.from);
  return { cuts, highlights: findHighlights(words) };
}
