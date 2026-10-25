// Everything that touches Premiere goes through here (UXP premierepro API).

const ppro = require('premierepro');

const Premiere = (() => {
  const TICKS_PER_SECOND = 254016000000;
  let lastItems = [];   // project items behind the clips of the last readSequence()

  async function project() {
    const p = await ppro.Project.getActiveProject();
    if (!p) throw new Error('Abra um projeto no Premiere.');
    return p;
  }

  async function activeSequence() {
    const p = await project();
    const seq = await p.getActiveSequence();
    if (!seq) throw new Error('Abra a sequência que você quer editar.');
    return { p, seq };
  }

  async function fpsOf(seq) {
    const tb = Number(await seq.getTimebase());   // ticks per frame
    const fps = tb > 0 ? TICKS_PER_SECOND / tb : 30;
    return Math.round(fps * 1000) / 1000;
  }

  /** What the engine needs: the clips on V1 with their media files. */
  async function readSequence() {
    const { seq } = await activeSequence();
    const fps = await fpsOf(seq);
    const size = await seq.getFrameSize();
    const track = await seq.getVideoTrack(0);
    if (!track) throw new Error('A sequência não tem trilha de vídeo.');
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
    const clips = [];
    lastItems = [];
    for (const item of items) {
      if (await item.isDisabled()) continue;
      if (item.isAdjustmentLayer && await item.isAdjustmentLayer()) continue;
      const projectItem = await item.getProjectItem();
      const clipItem = projectItem && ppro.ClipProjectItem.cast(projectItem);
      const path = clipItem ? await clipItem.getMediaFilePath() : '';
      if (!path) continue;   // titles, graphics, nested sequences
      lastItems.push({ path, clipItem });
      clips.push({
        path,
        name: await item.getName(),
        start: (await item.getStartTime()).seconds,
        end: (await item.getEndTime()).seconds,
        srcIn: (await item.getInPoint()).seconds,
      });
    }
    // Keep the project items in the same order as the clips sent to the engine.
    const order = clips.map((c, i) => i).sort((a, b) => clips[a].start - clips[b].start);
    lastItems = order.map((i) => lastItems[i]);
    clips.sort((a, b) => a.start - b.start);
    return {
      name: seq.name,
      fps,
      width: Math.round(size.width),
      height: Math.round(size.height),
      audioRate: 48000,
      clips,
    };
  }

  /**
   * Premiere's own speech-to-text for every clip of the last readSequence():
   * transcribes the clips that have no transcript yet and exports them as JSON.
   * Returns [] when this Premiere can't, so the engine falls back to whisper.
   */
  async function transcripts(language, onStatus) {
    const T = ppro.Transcript;
    if (!T || !T.exportToJSON || !T.transcribeClipProjectItem) return [];
    let code;
    try {
      const langs = (T.querySupportedLanguages && await T.querySupportedLanguages()) || [];
      const match = langs.find((l) => /^pt-br$/i.test(l.languageCode) && language === 'pt')
        || langs.find((l) => String(l.languageCode).toLowerCase().startsWith(language));
      code = match && match.languageCode;
    } catch (e) { /* older Premiere: use the user's default language */ }

    const byPath = new Map();
    const out = [];
    for (let i = 0; i < lastItems.length; i++) {
      const { path, clipItem } = lastItems[i];
      const status = (s) => onStatus && onStatus(s, i, lastItems.length);
      status.cancelled = onStatus && onStatus.cancelled;
      if (!byPath.has(path)) byPath.set(path, await exportOrTranscribe(T, clipItem, code, status));
      const json = byPath.get(path);
      if (json) out.push({ clip: i, json });
    }
    return out;
  }

  async function exportOrTranscribe(T, clipItem, code, onStatus) {
    const read = async () => { try { const j = await T.exportToJSON(clipItem); return j && j.length > 20 ? j : ''; } catch (e) { return ''; } };
    const has = async () => { try { return T.hasTranscript ? await T.hasTranscript(clipItem) : !!(await read()); } catch (e) { return false; } };
    if (await has()) return read();
    onStatus('o Premiere está transcrevendo');
    let started;
    try {
      started = await (code ? T.transcribeClipProjectItem(clipItem, { language: code }) : T.transcribeClipProjectItem(clipItem));
    } catch (e) {
      try { started = await T.transcribeClipProjectItem(clipItem); } catch (e2) { return ''; }
    }
    if (started === false) return '';
    // The call can return before the transcript is ready; wait for it (up to 30 min).
    const t0 = Date.now();
    while (Date.now() - t0 < 30 * 60 * 1000 && !(onStatus.cancelled && onStatus.cancelled())) {
      const j = await read();
      if (j) return j;
      onStatus('o Premiere está transcrevendo (' + Math.round((Date.now() - t0) / 1000) + ' s)');
      await new Promise((r) => setTimeout(r, 2000));
    }
    return '';
  }

  async function summary() {
    const { seq } = await activeSequence();
    const end = (await seq.getEndTime()).seconds;
    const size = await seq.getFrameSize();
    return { name: seq.name, duration: end, fps: await fpsOf(seq), width: size.width, height: size.height };
  }

  /** Imports the engine's XML as a new sequence and opens it. Returns that sequence. */
  async function importEdit(xmlPath, name) {
    const p = await project();
    const before = new Set((await p.getSequences()).map((s) => s.guid.toString()));
    const ok = await p.importFiles([xmlPath], true, await p.getInsertionBin(), false);
    if (!ok) throw new Error('O Premiere não conseguiu importar a edição.');
    const created = (await p.getSequences()).filter((s) => !before.has(s.guid.toString()));
    const seq = created.find((s) => s.name === name) || created[0];
    if (!seq) throw new Error('A sequência nova não apareceu no projeto.');
    await p.openSequence(seq);
    return seq;
  }

  async function removeEdit(seq) {
    const p = await project();
    return p.deleteSequence(seq);
  }

  return { readSequence, transcripts, summary, importEdit, removeEdit };
})();
