// AutoEdit Engine: the local service the Premiere panel talks to.
// UXP panels cannot start programs, so the heavy work (ffmpeg, whisper)
// lives here and the panel calls it over http://127.0.0.1.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cancelJob, getJob, publicJob, rebuildJob, startJob, STEPS, type JobRequest } from './jobs.ts';
import { run, tool } from './media.ts';

export const PORT = Number(process.env.AUTOEDIT_PORT || 47380);
const VERSION = '0.1.0';

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000_000) throw new Error('Pedido grande demais.');
  }
  return raw ? JSON.parse(raw) : {};
}

async function hasTool(name: 'ffmpeg' | 'whisper-cli') {
  try { return (await run(tool(name), name === 'ffmpeg' ? ['-version'] : ['--help'])).code === 0; } catch { return false; }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, version: VERSION, ffmpeg: await hasTool('ffmpeg'), whisper: await hasTool('whisper-cli'), steps: STEPS });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = (await readJson(req)) as JobRequest;
      if (!body.sequence?.clips?.length) return send(res, 400, { error: 'A sequência não tem clipes de vídeo na trilha V1.' });
      return send(res, 200, publicJob(startJob(body)));
    }
    const m = url.pathname.match(/^\/jobs\/([\w-]+)(?:\/(cancel|rebuild))?$/);
    if (m) {
      const job = getJob(m[1]);
      if (!job) return send(res, 404, { error: 'Trabalho não encontrado.' });
      if (m[2] === 'cancel' && req.method === 'POST') cancelJob(job.id);
      if (m[2] === 'rebuild' && req.method === 'POST') rebuildJob(job.id, (await readJson(req)).keep || []);
      return send(res, 200, publicJob(job));
    }
    send(res, 404, { error: 'Rota desconhecida.' });
  } catch (e) {
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`AutoEdit Engine ${VERSION} em http://127.0.0.1:${PORT}`));
