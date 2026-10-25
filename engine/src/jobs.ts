// One "Ligar o AutoEdit" run: analyse the sequence, decide, write the XML.
// Steps mirror what the panel shows on the progress screen.

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildPlan, buildXml, DEFAULT_OPTIONS, heuristicDecisions,
  type Decisions, type EditOptions, type EditPlan, type Range, type SequenceInfo, type Word,
} from '@autoedit/core';
import { loudness, probe, silences, silenceThreshold, timelineAudio, transcribe } from './media.ts';

export const STEPS = [
  { id: 'probe', now: 'lendo a sua sequência', done: 'Li a sua sequência' },
  { id: 'voice', now: 'separando a sua voz', done: 'Separei a sua voz' },
  { id: 'listen', now: 'ouvindo o que você falou', done: 'Ouvi tudo que você falou' },
  { id: 'decide', now: 'decidindo os cortes', done: 'Decidi os cortes' },
  { id: 'build', now: 'montando a sequência nova', done: 'Montei a sequência nova' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

export interface JobRequest {
  sequence: SequenceInfo;
  options?: Partial<EditOptions>;
  words?: Word[];          // a transcript the panel already has (Premiere's own)
  outDir?: string;
  brain?: { url: string; license?: string };
}

export interface JobResult {
  plan: EditPlan;
  xmlPath: string;
  sequenceName: string;
  words: Word[];
  brain: 'nuvem' | 'offline';
  seconds: number;
}

export interface Job {
  id: string;
  status: 'rodando' | 'pronto' | 'erro' | 'cancelado';
  step: StepId;
  progress: number;      // 0..100
  error?: string;
  result?: JobResult;
  abort: AbortController;
  startedAt: number;
  inputs?: BuildInputs;
  rebuilds?: number;
}

interface BuildInputs {
  words: Word[];
  quiet: Range[];
  duration: number;
  decisions: Decisions;
  options: EditOptions;
  loud: { integrated: number; truePeak: number };
  seq: SequenceInfo;
  dir: string;
  brain: JobResult['brain'];
}

const jobs = new Map<string, Job>();

export function getJob(id: string) { return jobs.get(id); }

export function publicJob(j: Job) {
  const { abort, inputs, ...rest } = j;
  return rest;
}

export function startJob(req: JobRequest): Job {
  const job: Job = { id: randomUUID(), status: 'rodando', step: 'probe', progress: 0, abort: new AbortController(), startedAt: Date.now() };
  jobs.set(job.id, job);
  runJob(job, req).catch((e) => {
    if (job.status === 'cancelado') return;
    job.status = 'erro';
    job.error = e instanceof Error ? e.message : String(e);
  });
  return job;
}

export function cancelJob(id: string) {
  const j = jobs.get(id);
  if (j && j.status === 'rodando') { j.status = 'cancelado'; j.abort.abort(); }
}

function mergeOptions(o: Partial<EditOptions> | undefined): EditOptions {
  const d = DEFAULT_OPTIONS;
  return {
    silences: { ...d.silences, ...o?.silences },
    repetitions: o?.repetitions ?? d.repetitions,
    fillers: o?.fillers ?? d.fillers,
    jcut: { ...d.jcut, ...o?.jcut },
    levelVoice: { ...d.levelVoice, ...o?.levelVoice },
    zoom: { ...d.zoom, ...o?.zoom },
    language: o?.language ?? d.language,
  };
}

async function askBrain(brain: JobRequest['brain'], words: Word[], options: EditOptions, signal: AbortSignal): Promise<Decisions | null> {
  if (!brain?.url || !words.length) return null;
  try {
    const res = await fetch(brain.url.replace(/\/$/, '') + '/v1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(brain.license ? { 'x-autoedit-license': brain.license } : {}) },
      body: JSON.stringify({ words, options }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!res.ok) return null;
    return (await res.json()) as Decisions;
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}

async function runJob(job: Job, req: JobRequest) {
  const signal = job.abort.signal;
  const options = mergeOptions(req.options);
  const at = (step: StepId, progress: number) => { job.step = step; job.progress = progress; };
  const dir = join(req.outDir || join(tmpdir(), 'AutoEdit'), job.id.slice(0, 8));
  mkdirSync(dir, { recursive: true });

  at('probe', 2);
  const clips = [];
  for (const c of req.sequence.clips) clips.push(await probe(c));
  const seq: SequenceInfo = { ...req.sequence, clips };
  const duration = Math.max(...clips.map((c) => c.end));

  at('voice', 8);
  const wav = join(dir, 'voz.wav');
  const mix = join(dir, 'mix.wav');
  await timelineAudio(clips, duration, wav, 'analysis', signal);
  await timelineAudio(clips, duration, mix, 'full', signal);
  const loud = await loudness(mix, signal);
  // Silence threshold sits between this recording's room noise and its voice.
  const noise = await silenceThreshold(wav, signal);
  const quiet = await silences(wav, noise, 0.2, signal);

  at('listen', 20);
  const words = req.words?.length ? req.words : await transcribe(wav, options.language, signal, (pct) => at('listen', 20 + Math.round(pct * 0.5)));

  at('decide', 70);
  const fromBrain = await askBrain(req.brain, words, options, signal);
  const decisions = fromBrain ?? heuristicDecisions(words, options);

  if (job.status !== 'rodando') return;
  job.inputs = { words, quiet, duration, decisions, options, loud, seq, dir, brain: fromBrain ? 'nuvem' : 'offline' };
  at('build', 90);
  job.result = build(job.inputs, [], job.startedAt);
  job.progress = 100;
  job.status = 'pronto';
}

function build(x: BuildInputs, keep: Range[], startedAt: number, version = 0): JobResult {
  const plan = buildPlan({ words: x.words, silences: x.quiet, duration: x.duration, decisions: x.decisions, options: x.options, loudness: x.loud, keep });
  const sequenceName = `${x.seq.name} · AutoEdit`;
  const xmlPath = join(x.dir, `${safe(sequenceName)}${version ? ` (${version})` : ''}.xml`);
  writeFileSync(xmlPath, buildXml(plan, x.seq, { name: sequenceName, jcutFrames: x.options.jcut.on ? x.options.jcut.frames : 0 }));
  writeFileSync(join(x.dir, 'plano.json'), JSON.stringify({ plan, words: x.words }, null, 1));
  return { plan, xmlPath, sequenceName, words: x.words, brain: x.brain, seconds: (Date.now() - startedAt) / 1000 };
}

/** Review screen: the editor un-ticked some cuts; write the XML again without them. */
export function rebuildJob(id: string, keep: Range[]): Job | undefined {
  const job = jobs.get(id);
  if (!job?.inputs || !job.result) return job;
  const version = (job.rebuilds = (job.rebuilds ?? 0) + 1);
  job.result = { ...build(job.inputs, keep, job.startedAt, version), seconds: job.result.seconds };
  return job;
}

const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
