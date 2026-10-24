// AutoEdit cloud API. Holds the Claude key, checks licences, and keeps the
// panel and engine free of secrets.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import type { EditOptions, Word } from '@autoedit/core';
import { decide } from './brain.ts';

const app = new Hono();

// Licences: a comma-separated list for now; Hotmart/Kiwify webhooks will fill a table later.
const LICENSES = new Set((process.env.AUTOEDIT_LICENSES || '').split(',').map((s) => s.trim()).filter(Boolean));
const MAX_WORDS = 40_000;   // about 3 hours of speech

app.get('/health', (c) => c.json({ ok: true }));

app.post('/v1/decide', async (c) => {
  if (LICENSES.size && !LICENSES.has(c.req.header('x-autoedit-license') || '')) {
    return c.json({ error: 'Licença inválida ou expirada.' }, 401);
  }
  const body = await c.req.json<{ words: Word[]; options?: Partial<EditOptions> }>();
  if (!Array.isArray(body.words)) return c.json({ error: 'Faltou a transcrição.' }, 400);
  if (body.words.length > MAX_WORDS) return c.json({ error: 'Vídeo longo demais para uma edição só.' }, 413);
  try {
    return c.json(await decide(body.words, body.options || {}));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return c.json({ error: 'Muita gente editando agora. Tente de novo em instantes.' }, 429);
    if (e instanceof Anthropic.APIError) return c.json({ error: 'A IA não respondeu.' }, 502);
    throw e;
  }
});

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port }, () => console.log(`AutoEdit API em http://localhost:${port}`));
