// Shared shapes between the panel, the local engine and the cloud brain.
// Every time is in seconds on the sequence timeline unless the name says
// otherwise (srcIn/srcOut are seconds inside the media file).

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Range {
  start: number;
  end: number;
}

/** One clip of the source sequence, as the panel reads it from Premiere. */
export interface SourceClip {
  path: string;
  name: string;
  start: number;   // where it sits on the timeline
  end: number;
  srcIn: number;   // in point inside the media
  /** Media facts the XML needs; the engine fills them with ffprobe. */
  mediaDuration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export interface SequenceInfo {
  name: string;
  fps: number;          // 29.97, 30, 25, 23.976, 60...
  width: number;
  height: number;
  audioRate: number;    // 48000
  clips: SourceClip[];  // main camera, V1 + its linked audio
}

export type SilenceMode = 'dinamico' | 'suave';
export type ZoomStrength = 'suave' | 'medio' | 'forte';

export interface EditOptions {
  silences: { on: boolean; mode: SilenceMode };
  repetitions: boolean;
  fillers: boolean;
  jcut: { on: boolean; frames: number };
  levelVoice: { on: boolean; targetLufs: number };
  zoom: { on: boolean; strength: ZoomStrength; alsoWithoutCut: boolean };
  language: string;
}

export const DEFAULT_OPTIONS: EditOptions = {
  silences: { on: true, mode: 'dinamico' },
  repetitions: true,
  fillers: true,
  jcut: { on: true, frames: 4 },
  levelVoice: { on: true, targetLufs: -14 },
  zoom: { on: false, strength: 'medio', alsoWithoutCut: false },
  language: 'pt',
};

export type CutKind = 'silencio' | 'repeticao' | 'vicio' | 'falso_inicio';

export interface Cut extends Range {
  kind: CutKind;
  text: string;   // what was said in the cut, empty for silences
}

/** What the brain returns: word ranges to drop and words worth a highlight. */
export interface Decisions {
  cuts: { from: number; to: number; kind: Exclude<CutKind, 'silencio'> }[];  // word indices, inclusive
  highlights: number[];  // word indices
}

export interface Segment extends Range {
  zoom: number;   // scale multiplier for this segment, 1 = none
}

export interface EditPlan {
  segments: Segment[];     // timeline ranges that stay, in order
  cuts: Cut[];
  gainDb: number;
  before: number;          // duration in seconds
  after: number;
  highlights: Word[];
}
