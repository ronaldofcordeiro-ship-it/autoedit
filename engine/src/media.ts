// ffmpeg / ffprobe / whisper.cpp wrappers. Binaries come from the installer's
// bin folder, an env override, or the PATH, in that order.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Range, SourceClip, Word } from '@autoedit/core';

const here = dirname(fileURLToPath(import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';

export function tool(name: 'ffmpeg' | 'ffprobe' | 'whisper-cli'): string {
  const env = process.env[`AUTOEDIT_${name.replace('-cli', '').toUpperCase()}`];
  if (env) return env;
  for (const dir of [join(here, '..', 'bin'), join(here, 'bin'), join(dirname(process.execPath), 'bin')]) {
    const p = join(dir, name + exe);
    if (existsSync(p)) return p;
  }
  return name;
}

export interface RunResult { code: number; stdout: string; stderr: string }

export function run(cmd: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, signal });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function must(cmd: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  const r = await run(cmd, args, signal);
  if (r.code !== 0) throw new Error(`${cmd.split(/[\\/]/).pop()} falhou: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return r;
}

export async function probe(clip: SourceClip): Promise<SourceClip> {
  const r = await must(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', clip.path]);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
  // Phones store portrait video as landscape pixels plus a rotation flag;
  // Premiere shows it upright, so the XML must describe it upright too.
  const rot = Number(v?.tags?.rotate ?? (v?.side_data_list || []).find((d: any) => d.rotation !== undefined)?.rotation ?? 0);
  const turned = Math.abs(rot) % 180 === 90;
  return {
    ...clip,
    mediaDuration: Number(j.format?.duration) || clip.mediaDuration,
    width: (turned ? v?.height : v?.width) ?? clip.width,
    height: (turned ? v?.width : v?.height) ?? clip.height,
    hasAudio: (j.streams || []).some((s: any) => s.codec_type === 'audio'),
  };
}

/**
 * Renders the sequence's audio as the timeline plays it (clips at their
 * positions, gaps silent). 'analysis' is mono 16 kHz with a light voice-band
 * clean-up so silence detection and transcription hear the voice, not the
 * room; 'full' is the untouched stereo mix, for measuring loudness.
 */
export async function timelineAudio(clips: SourceClip[], duration: number, out: string, mode: 'analysis' | 'full', signal?: AbortSignal): Promise<void> {
  const rate = mode === 'analysis' ? 16000 : 48000;
  const withAudio = clips.filter((c) => c.hasAudio !== false);
  if (!withAudio.length) throw new Error('A sequência não tem áudio na trilha principal.');
  const args = ['-y', '-v', 'error'];
  const parts: string[] = [];
  withAudio.forEach((c, i) => {
    args.push('-ss', c.srcIn.toFixed(3), '-t', (c.end - c.start).toFixed(3), '-i', c.path);
    parts.push(`[${i}:a:0]aresample=${rate},aformat=channel_layouts=${mode === 'analysis' ? 'mono' : 'stereo'},adelay=${Math.round(c.start * 1000)}:all=1[a${i}]`);
  });
  const clean = mode === 'analysis' ? 'highpass=f=80,lowpass=f=7000,afftdn=nf=-25,' : '';
  const mix = withAudio.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${withAudio.length}:normalize=0:duration=longest,`
    + `${clean}apad=whole_dur=${duration.toFixed(3)}[out]`;
  args.push('-filter_complex', [...parts, mix].join(';'), '-map', '[out]', '-ac', mode === 'analysis' ? '1' : '2', '-ar', String(rate), '-t', duration.toFixed(3), out);
  await must(tool('ffmpeg'), args, signal);
}

export async function loudness(wav: string, signal?: AbortSignal): Promise<{ integrated: number; truePeak: number }> {
  const r = await must(tool('ffmpeg'), ['-v', 'info', '-i', wav, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], signal);
  const m = r.stderr.match(/\{[\s\S]*"input_i"[\s\S]*?\}/);
  if (!m) return { integrated: NaN, truePeak: NaN };
  const j = JSON.parse(m[0]);
  return { integrated: Number(j.input_i), truePeak: Number(j.input_tp) };
}

export async function silences(wav: string, noiseDb: number, minDur: number, signal?: AbortSignal): Promise<Range[]> {
  const r = await must(tool('ffmpeg'), ['-v', 'info', '-i', wav, '-af', `silencedetect=n=${noiseDb.toFixed(1)}dB:d=${minDur}`, '-f', 'null', '-'], signal);
  const out: Range[] = [];
  let start: number | null = null;
  for (const line of r.stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end: ([\d.]+)/);
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return out;
}

/**
 * Picks the silence threshold from the recording itself, in 100 ms windows:
 * 22 dB under the voice (its loud windows), but always well above the room's
 * noise floor. Measured on real takes: phone (floor -70, voice -16 → -38) and
 * a camera in a shop (floor -50, voice -8 → -30).
 */
export async function silenceThreshold(wav: string, signal?: AbortSignal): Promise<number> {
  const r = await must(tool('ffmpeg'), ['-v', 'error', '-i', wav, '-af',
    'asetnsamples=n=1600,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], signal);
  const db = (r.stdout.match(/RMS_level=(-?[\d.]+)/g) || []).map((m) => Number(m.split('=')[1])).filter((x) => Number.isFinite(x) && x > -120).sort((a, b) => a - b);
  if (db.length < 10) return -40;
  const at = (q: number) => db[Math.min(db.length - 1, Math.floor(q * db.length))];
  const floor = at(0.1), voice = at(0.9);
  return Math.max(-60, Math.min(-20, Math.max(voice - 22, floor + 8)));
}

/** Word-level transcript with whisper.cpp (one "segment" per word). */
export async function transcribe(wav: string, language: string, signal?: AbortSignal): Promise<Word[]> {
  const model = process.env.AUTOEDIT_WHISPER_MODEL || join(here, '..', 'models', 'ggml-small.bin');
  if (!existsSync(model)) throw new Error('Modelo de transcrição não encontrado. Reinstale o AutoEdit.');
  const base = wav.replace(/\.wav$/, '');
  await must(tool('whisper-cli'), ['-m', model, '-f', wav, '-l', language, '-ml', '1', '-sow', '-oj', '-of', base, '-np'], signal);
  const j = JSON.parse(readFileSync(base + '.json', 'utf8'));
  const words: Word[] = [];
  for (const seg of j.transcription || []) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    words.push({ text, start: seg.offsets.from / 1000, end: seg.offsets.to / 1000 });
  }
  return words;
}
