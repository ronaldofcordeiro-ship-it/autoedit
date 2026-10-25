// AutoEdit Engine: the local service the Premiere panel talks to.
// UXP panels cannot start programs, so the heavy work (ffmpeg, whisper)
// lives here and the panel calls it over http://127.0.0.1.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { log } from './log.ts';
import { cancelJob, getJob, listJobs, publicJob, rebuildJob, startJob, STEPS, type JobRequest } from './jobs.ts';
import { run, tool } from './media.ts';

export const PORT = Number(process.env.AUTOEDIT_PORT || 47380);
const VERSION = '0.1.0';

process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

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

// The panel asks for /health every few seconds; check the tools once a minute, not on every call.
const toolCheck = new Map<string, { at: number; ok: boolean }>();
async function hasTool(name: 'ffmpeg' | 'whisper-cli') {
  const hit = toolCheck.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  let ok = false;
  try { ok = (await run(tool(name), name === 'ffmpeg' ? ['-version'] : ['--help'])).code === 0; } catch { ok = false; }
  toolCheck.set(name, { at: Date.now(), ok });
  return ok;
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
    if (req.method === 'GET' && url.pathname === '/jobs') return send(res, 200, listJobs());
    if (req.method === 'POST' && url.pathname === '/log') { log('painel', (await readJson(req)).text); return send(res, 200, { ok: true }); }
    const m = url.pathname.match(/^\/jobs\/([\w-]+)(?:\/(cancel|rebuild))?$/);
    if (m) {
      const job = getJob(m[1]);
      if (!job) { log('404', req.method, url.pathname); return send(res, 404, { error: 'Trabalho não encontrado. O motor foi reiniciado? Clique em Ligar o AutoEdit de novo.' }); }
      if (m[2] === 'cancel' && req.method === 'POST') cancelJob(job.id);
      if (m[2] === 'rebuild' && req.method === 'POST') rebuildJob(job.id, (await readJson(req)).keep || []);
      return send(res, 200, publicJob(job));
    }
    send(res, 404, { error: 'Rota desconhecida.' });
  } catch (e) {
    log('500', req.method, req.url, e);
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => log(`AutoEdit Engine ${VERSION} em http://127.0.0.1:${PORT}`));
