// Writes the edit as a Final Cut Pro 7 XML (xmeml) that Premiere imports as a
// brand-new sequence. The original sequence is never touched, so "undo the
// edit" is just deleting the imported sequence.

import type { EditPlan, SequenceInfo, SourceClip } from './types.ts';

interface Piece {
  clip: SourceClip;
  clipIndex: number;
  srcIn: number;       // seconds in the media
  duration: number;
  zoom: number;
  cutBefore: boolean;  // a real cut happened right before this piece
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function pathUrl(path: string): string {
  const p = path.replace(/\\/g, '/');
  const parts = p.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg[0] + '%3a' : encodeURIComponent(seg)));
  const joined = parts.join('/');
  return 'file://localhost' + (joined.startsWith('/') ? joined : '/' + joined);
}

function rate(fps: number): string {
  const timebase = Math.round(fps);
  const ntsc = Math.abs(fps - timebase) > 0.001;
  return `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

/** Splits the plan's segments at clip boundaries and maps them into media time. */
export function pieces(plan: EditPlan, seq: SequenceInfo): Piece[] {
  const out: Piece[] = [];
  let prevEnd = -1;
  for (const seg of plan.segments) {
    for (let ci = 0; ci < seq.clips.length; ci++) {
      const c = seq.clips[ci];
      const start = Math.max(seg.start, c.start), end = Math.min(seg.end, c.end);
      if (end - start < 1e-3) continue;
      out.push({
        clip: c, clipIndex: ci, srcIn: c.srcIn + (start - c.start), duration: end - start,
        zoom: seg.zoom, cutBefore: prevEnd >= 0 && Math.abs(start - prevEnd) > 1e-3,
      });
      prevEnd = end;
    }
  }
  return out;
}

export function buildXml(plan: EditPlan, seq: SequenceInfo, opts: { name: string; jcutFrames: number }): string {
  const fps = seq.fps;
  const f = (s: number) => Math.round(s * fps);
  const ps = pieces(plan, seq);
  const gain = Math.pow(10, plan.gainDb / 20);

  // Lay the pieces end to end in frames. Video edges move later by the J-cut,
  // so the next voice is heard a few frames before its picture shows up.
  const j = Math.max(0, Math.round(opts.jcutFrames));
  const audio: { start: number; end: number; in: number; out: number; p: Piece }[] = [];
  let t = 0;
  for (const p of ps) {
    const len = Math.max(1, f(p.duration));
    const inF = f(p.srcIn);
    audio.push({ start: t, end: t + len, in: inF, out: inF + len, p });
    t += len;
  }
  const video = audio.map((a) => ({ ...a }));
  if (j > 0) {
    for (let i = 1; i < video.length; i++) {
      if (!video[i].p.cutBefore) continue;
      const shift = Math.min(j, video[i].end - video[i].start - 1);
      if (shift <= 0) continue;
      video[i - 1].end += shift; video[i - 1].out += shift;
      video[i].start += shift; video[i].in += shift;
    }
  }
  const total = t;

  const files = new Map<number, string>();
  const fileRef = (p: Piece) => {
    const id = `file-${p.clipIndex + 1}`;
    if (files.has(p.clipIndex)) return `<file id="${id}"/>`;
    files.set(p.clipIndex, id);
    const c = p.clip;
    const dur = f(c.mediaDuration ?? c.srcIn + (c.end - c.start));
    return `<file id="${id}"><name>${esc(c.name)}</name><pathurl>${esc(pathUrl(c.path))}</pathurl>${rate(fps)}<duration>${dur}</duration>`
      + `<media><video><samplecharacteristics>${rate(fps)}<width>${c.width ?? seq.width}</width><height>${c.height ?? seq.height}</height>`
      + `<pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`
      + (c.hasAudio === false ? '' : [1, 2].map((ch) => `<audio><samplecharacteristics><depth>16</depth><samplerate>${seq.audioRate}</samplerate></samplecharacteristics>`
        + `<channelcount>1</channelcount><layout>stereo</layout><audiochannel><sourcechannel>${ch}</sourcechannel><channellabel>${ch === 1 ? 'left' : 'right'}</channellabel></audiochannel></audio>`).join(''))
      + `</media></file>`;
  };

  const param = (id: string, name: string, min: number, max: number, value: number) =>
    `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name><valuemin>${min}</valuemin><valuemax>${max}</valuemax><value>${value}</value></parameter>`;
  const motion = (zoom: number, rotation = 0) => zoom === 1 && !rotation ? '' :
    `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>`
    + param('scale', 'Scale', 0, 1000, Math.round(zoom * 1000) / 10)
    + (rotation ? param('rotation', 'Rotation', -8640, 8640, rotation) : '')
    + `</effect></filter>`;

  const level = gain === 1 ? '' :
    `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>`
    + `<parameter authoringApp="PremierePro"><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${gain.toFixed(5)}</value></parameter></effect></filter>`;

  // Premiere reads a stereo clip as two mono clip items on A1 and A2, all linked to the picture.
  const link = (i: number, withAudio: boolean) =>
    `<link><linkclipref>v-${i + 1}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${i + 1}</clipindex></link>`
    + (withAudio ? [1, 2].map((ch) => `<link><linkclipref>a${ch}-${i + 1}</linkclipref><mediatype>audio</mediatype><trackindex>${ch}</trackindex><clipindex>${i + 1}</clipindex><groupindex>1</groupindex></link>`).join('') : '');

  const head = (id: string, c: SourceClip, x: { start: number; end: number; in: number; out: number }, attrs = '') =>
    `<clipitem id="${id}"${attrs}><masterclipid>masterclip-${seq.clips.indexOf(c) + 1}</masterclipid><name>${esc(c.name)}</name><enabled>TRUE</enabled>`
    + `<duration>${f(c.mediaDuration ?? c.srcIn + (c.end - c.start))}</duration>${rate(fps)}`
    + `<start>${x.start}</start><end>${x.end}</end><in>${x.in}</in><out>${x.out}</out>`;

  // Clips without audio still take their slot (disabled) so clip indices stay aligned across tracks.
  const vItems = video.map((v, i) => head(`v-${i + 1}`, v.p.clip, v) + fileRef(v.p) + motion(v.p.zoom, v.p.clip.rotation) + link(i, v.p.clip.hasAudio !== false) + `</clipitem>`).join('');
  const aTrack = (ch: number) => audio.map((a, i) => a.p.clip.hasAudio === false ? '' :
    head(`a${ch}-${i + 1}`, a.p.clip, a, ' premiereChannelType="mono"') + fileRef(a.p)
    + `<sourcetrack><mediatype>audio</mediatype><trackindex>${ch}</trackindex></sourcetrack>` + level + link(i, true) + `</clipitem>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1" explodedTracks="true">`
    + `<name>${esc(opts.name)}</name><duration>${total}</duration>${rate(fps)}`
    + `<timecode>${rate(fps)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`
    + `<media><video><format><samplecharacteristics>${rate(fps)}<width>${seq.width}</width><height>${seq.height}</height>`
    + `<pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`
    + `<track>${vItems}<enabled>TRUE</enabled><locked>FALSE</locked></track></video>`
    + `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>${seq.audioRate}</samplerate></samplecharacteristics></format>`
    + `<outputs>${[1, 2].map((ch) => `<group><index>${ch}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>${ch}</index></channel></group>`).join('')}</outputs>`
    + [1, 2].map((ch) => `<track currentExplodedTrackIndex="${ch - 1}" totalExplodedTrackCount="2" premiereTrackType="Stereo">${aTrack(ch)}<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${ch}</outputchannelindex></track>`).join('')
    + `</audio>`
    + `</media></sequence></xmeml>\n`;
}
