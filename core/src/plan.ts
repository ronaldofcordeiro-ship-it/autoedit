// Turns words, silences and decisions into the list of timeline ranges that
// stay. Everything here is pure so it can be tested without Premiere.

import type { Cut, Decisions, EditOptions, EditPlan, Range, Segment, Word } from './types.ts';

const SILENCE = {
  dinamico: { minGap: 0.35, pad: 0.08 },
  suave: { minGap: 0.7, pad: 0.18 },
} as const;

const ZOOM = { suave: 1.08, medio: 1.15, forte: 1.25 } as const;

const MIN_SEGMENT = 0.25;

export function mergeRanges(ranges: Range[], join = 0): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + join) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Pauses between words (and before the first / after the last) that are long enough to cut. */
export function wordGaps(words: Word[], duration: number, minGap: number, pad: number): Range[] {
  const out: Range[] = [];
  let prev = 0;
  for (const w of words) {
    if (w.start - prev >= minGap) out.push({ start: prev === 0 ? 0 : prev + pad, end: w.start - pad });
    prev = Math.max(prev, w.end);
  }
  if (duration - prev >= minGap) out.push({ start: prev + pad, end: duration });
  return out;
}

/**
 * Audio silences (from ffmpeg), padded so word edges are never clipped.
 * Whisper's word times drift (it stretches words over the pause after them
 * and places words inside pauses the audio shows are empty), so the audio is
 * trusted over the transcript here; the threshold is set per recording.
 */
export function quietRanges(silences: Range[], minGap: number, pad: number): Range[] {
  const out: Range[] = [];
  for (const s of mergeRanges(silences, 0.06)) {
    if (s.end - s.start < minGap) continue;
    out.push({ start: s.start === 0 ? 0 : s.start + pad, end: s.end - pad });
  }
  return out;
}

function wordsIn(words: Word[], r: Range): string {
  return words.filter((w) => w.start >= r.start - 0.01 && w.end <= r.end + 0.01).map((w) => w.text.trim()).join(' ');
}

export function buildPlan(input: {
  words: Word[];
  silences: Range[];
  duration: number;
  decisions: Decisions;
  options: EditOptions;
  loudness?: { integrated: number; truePeak: number };
  /** Ranges the editor chose to keep on the review screen, even if a rule wanted them out. */
  keep?: Range[];
}): EditPlan {
  const { words, duration, decisions, options } = input;
  const cuts: Cut[] = [];

  if (options.silences.on) {
    const { minGap, pad } = SILENCE[options.silences.mode];
    const quiet = mergeRanges([
      ...wordGaps(words, duration, minGap, pad),
      ...quietRanges(input.silences, minGap, pad),
    ]);
    for (const r of quiet) cuts.push({ ...r, kind: 'silencio', text: '' });
  }

  for (const d of decisions.cuts) {
    if (d.kind === 'vicio' && !options.fillers) continue;
    if (d.kind !== 'vicio' && !options.repetitions) continue;
    const first = words[d.from], last = words[d.to];
    if (!first || !last) continue;
    // Take the pause around the cut words too, up to the neighbours.
    const before = d.from > 0 ? words[d.from - 1].end : 0;
    const after = d.to < words.length - 1 ? words[d.to + 1].start : duration;
    const r = { start: Math.max(before, first.start - 0.05), end: Math.min(after, last.end + 0.05) };
    cuts.push({ ...r, kind: d.kind, text: words.slice(d.from, d.to + 1).map((w) => w.text.trim()).join(' ') });
  }

  // Keep = timeline minus every cut; drop crumbs too short to watch.
  const forced = mergeRanges(input.keep ?? []);
  let removed = subtract(mergeRanges(cuts, 0.01), forced);
  let keep = complement(removed, duration);
  removed = mergeRanges([...removed, ...keep.filter((k) => k.end - k.start < MIN_SEGMENT)], 0.01);
  keep = complement(removed, duration);

  const highlights = decisions.highlights.map((i) => words[i]).filter(Boolean);
  const segments = zoomSegments(keep, highlights, options);

  let gainDb = 0;
  if (options.levelVoice.on && input.loudness && Number.isFinite(input.loudness.integrated)) {
    gainDb = options.levelVoice.targetLufs - input.loudness.integrated;
    gainDb = Math.min(gainDb, -1 - input.loudness.truePeak);  // never push peaks over -1 dBTP
    gainDb = Math.max(-12, Math.min(12, gainDb));
    gainDb = Math.round(gainDb * 10) / 10;
  }

  const after = segments.reduce((s, r) => s + r.end - r.start, 0);
  return {
    segments,
    cuts: mergeCutList(cuts.filter((c) => !forced.some((k) => k.start <= c.start + 0.01 && k.end >= c.end - 0.01)), words),
    gainDb,
    before: duration,
    after,
    highlights,
  };
}

/** Ranges minus holes. */
export function subtract(ranges: Range[], holes: Range[]): Range[] {
  let out = ranges.map((r) => ({ ...r }));
  for (const h of holes) {
    const next: Range[] = [];
    for (const r of out) {
      if (h.end <= r.start || h.start >= r.end) { next.push(r); continue; }
      if (h.start > r.start) next.push({ start: r.start, end: h.start });
      if (h.end < r.end) next.push({ start: h.end, end: r.end });
    }
    out = next;
  }
  return out;
}

export function complement(removed: Range[], duration: number): Range[] {
  const out: Range[] = [];
  let t = 0;
  for (const r of removed) {
    if (r.start > t) out.push({ start: t, end: Math.min(r.start, duration) });
    t = Math.max(t, r.end);
  }
  if (t < duration) out.push({ start: t, end: duration });
  return out.filter((r) => r.end - r.start > 0.001);
}

/** Punch-in zoom: alternate between wide and close on every cut, and split long takes at a highlight. */
function zoomSegments(keep: Range[], highlights: Word[], options: EditOptions): Segment[] {
  if (!options.zoom.on) return keep.map((r) => ({ ...r, zoom: 1 }));
  const close = ZOOM[options.zoom.strength];
  const pieces: Range[] = [];
  for (const r of keep) {
    if (!options.zoom.alsoWithoutCut || r.end - r.start < 6) { pieces.push(r); continue; }
    const splits = highlights.map((w) => w.start).filter((t) => t - r.start > 2.5 && r.end - t > 2.5);
    let from = r.start;
    for (const t of splits) {
      if (t - from < 2.5) continue;
      pieces.push({ start: from, end: t });
      from = t;
    }
    pieces.push({ start: from, end: r.end });
  }
  return pieces.map((r, i) => ({ ...r, zoom: i % 2 === 1 ? close : 1 }));
}

/** The summary list: overlapping cuts merged, silences counted once. */
function mergeCutList(cuts: Cut[], words: Word[]): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const out: Cut[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) {
      if (last.kind === 'silencio' && c.kind !== 'silencio') last.kind = c.kind;
      last.end = Math.max(last.end, c.end);
      last.text = last.kind === 'silencio' ? '' : wordsIn(words, last);
    } else out.push({ ...c });
  }
  return out;
}
