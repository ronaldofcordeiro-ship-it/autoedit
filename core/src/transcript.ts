// Turns Premiere's own transcript (Transcript.exportToJSON, one per source
// clip) into timeline words. Adobe doesn't document the JSON, so the reader
// looks for any list of {text, start, end|duration} and works out the time unit.

import type { SourceClip, Word } from './types.ts';

const TEXT = ['text', 'word', 'value', 'content', 'token'];
const START = ['start', 'startTime', 'start_time', 'begin', 'offset', 'from'];
const END = ['end', 'endTime', 'end_time', 'to'];
const DUR = ['duration', 'length', 'dur'];

const pick = (o: any, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const num = (v: any): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (v && typeof v === 'object') return num(pick(v, ['seconds', 'value', 'ticks']));
  return NaN;
};

interface Raw { text: string; start: number; end: number }

/** Every word-shaped object anywhere in the JSON. The deepest lists win (words beat sentences). */
function collect(node: any, depth = 0, out: { depth: number; items: Raw[] }[] = []) {
  if (Array.isArray(node)) {
    const items: Raw[] = [];
    for (const o of node) {
      if (!o || typeof o !== 'object') continue;
      const text = pick(o, TEXT), start = num(pick(o, START));
      if (typeof text !== 'string' || !Number.isFinite(start)) continue;
      let end = num(pick(o, END));
      if (!Number.isFinite(end)) end = start + num(pick(o, DUR));
      if (Number.isFinite(end)) items.push({ text, start, end });
    }
    if (items.length) out.push({ depth, items });
    node.forEach((x) => collect(x, depth + 1, out));
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collect(v, depth + 1, out);
  }
  return out;
}

export function parsePremiereTranscript(json: string, mediaDuration?: number): Raw[] {
  let data: any;
  try { data = JSON.parse(json); } catch { return []; }
  const lists = collect(data);
  if (!lists.length) return [];
  const deepest = Math.max(...lists.map((l) => l.depth));
  const raw = lists.filter((l) => l.depth === deepest).flatMap((l) => l.items)
    .filter((w) => w.text.trim()).sort((a, b) => a.start - b.start);
  if (!raw.length) return [];
  // Seconds, milliseconds or Premiere ticks: the unit that fits the clip.
  const last = Math.max(...raw.map((w) => w.end));
  const limit = (mediaDuration ?? last) * 1.05 + 1;
  const scale = [1, 1 / 1000, 1 / 254016000000].find((s) => last * s <= limit) ?? 1;
  return raw.map((w) => ({ text: w.text.trim(), start: w.start * scale, end: w.end * scale }));
}

/** Places each clip's words on the timeline, keeping only what the clip actually shows. */
export function transcriptWords(clips: SourceClip[], transcripts: { clip: number; json: string }[]): Word[] {
  const words: Word[] = [];
  for (const t of transcripts) {
    const c = clips[t.clip];
    if (!c) continue;
    const len = c.end - c.start;
    for (const w of parsePremiereTranscript(t.json, c.mediaDuration)) {
      const mid = (w.start + w.end) / 2;
      if (mid < c.srcIn || mid > c.srcIn + len) continue;
      const at = (s: number) => Math.min(c.end, Math.max(c.start, c.start + s - c.srcIn));
      words.push({ text: w.text, start: at(w.start), end: at(w.end) });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}
