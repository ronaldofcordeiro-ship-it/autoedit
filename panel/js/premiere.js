// Everything that touches Premiere goes through here (UXP premierepro API).

const ppro = require('premierepro');

const Premiere = (() => {
  const TICKS_PER_SECOND = 254016000000;

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
    for (const item of items) {
      if (await item.isDisabled()) continue;
      if (item.isAdjustmentLayer && await item.isAdjustmentLayer()) continue;
      const projectItem = await item.getProjectItem();
      const clipItem = projectItem && ppro.ClipProjectItem.cast(projectItem);
      const path = clipItem ? await clipItem.getMediaFilePath() : '';
      if (!path) continue;   // titles, graphics, nested sequences
      clips.push({
        path,
        name: await item.getName(),
        start: (await item.getStartTime()).seconds,
        end: (await item.getEndTime()).seconds,
        srcIn: (await item.getInPoint()).seconds,
      });
    }
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

  return { readSequence, summary, importEdit, removeEdit };
})();
