// The cloud brain: reads the transcript and decides what an editor would cut.
// Only words and times are sent here, never audio or video.

import Anthropic from '@anthropic-ai/sdk';
import { heuristicDecisions, type Decisions, type EditOptions, type Word } from '@autoedit/core';

const client = new Anthropic();
const MODEL = process.env.AUTOEDIT_MODEL || 'claude-opus-5-5';

// Kept byte-identical between requests so it is cached.
const SYSTEM = `Você é o editor de vídeo do AutoEdit. Recebe a transcrição palavra por palavra de um vídeo de uma pessoa falando para a câmera (Reels, YouTube, aulas) e decide o que um bom editor cortaria.

Cada linha da transcrição é: índice | início em segundos | palavra.

Marque para cortar, por intervalo de índices (inclusivo):
- "repeticao": a pessoa disse a mesma ideia mais de uma vez seguida porque errou ou quis refazer. Corte as tentativas anteriores e mantenha só a última, que costuma ser a melhor. Não corte repetições intencionais de estilo ("é não, é não").
- "falso_inicio": começou uma frase, parou no meio e recomeçou de outro jeito. Corte o pedaço abandonado.
- "vicio": sons e muletas sem conteúdo ("ahn", "éé", "hum") e falas de bastidor entre tomadas ("ok, valendo", "corta", "de novo", "deixa eu começar de novo"). Palavras normais que fazem parte da frase ("tipo", "né", "então") só saem quando são claramente muleta e o corte não estraga a frase.

Na dúvida, não corte: perder conteúdo é pior do que deixar uma pausa.

Também escolha "highlights": as palavras mais fortes de cada frase (a que um editor destacaria numa legenda ou num zoom), no máximo uma a cada 3 segundos.

Os intervalos não podem se sobrepor e precisam estar em ordem.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cuts', 'highlights'],
  properties: {
    cuts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'kind'],
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          kind: { type: 'string', enum: ['repeticao', 'falso_inicio', 'vicio'] },
        },
      },
    },
    highlights: { type: 'array', items: { type: 'integer' } },
  },
};

export function transcriptLines(words: Word[]): string {
  return words.map((w, i) => `${i} | ${w.start.toFixed(2)} | ${w.text.trim()}`).join('\n');
}

/** Drops anything malformed the model might return: bad indices, overlaps, wrong order. */
export function sanitize(d: Decisions, n: number): Decisions {
  const cuts: Decisions['cuts'] = [];
  let last = -1;
  for (const c of [...(d.cuts || [])].sort((a, b) => a.from - b.from)) {
    const from = Math.max(0, Math.floor(c.from)), to = Math.min(n - 1, Math.floor(c.to));
    if (to < from || from <= last) continue;
    cuts.push({ from, to, kind: c.kind });
    last = to;
  }
  const highlights = [...new Set((d.highlights || []).map(Math.floor))].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  return { cuts, highlights };
}

export async function decide(words: Word[], options: Partial<EditOptions>): Promise<Decisions> {
  if (!words.length) return { cuts: [], highlights: [] };
  const wanted: string[] = [];
  if (options.repetitions !== false) wanted.push('repetições e falsos inícios');
  if (options.fillers !== false) wanted.push('vícios de linguagem');
  const ask = wanted.length ? `Corte: ${wanted.join(' e ')}.` : 'Não corte nada; só escolha os highlights.';

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `Idioma: ${options.language || 'pt'}. ${ask}\n\n${transcriptLines(words)}` }],
  });

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    return heuristicDecisions(words, { repetitions: options.repetitions !== false, fillers: options.fillers !== false, language: options.language });
  }
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = sanitize(JSON.parse(text) as Decisions, words.length);
  if (options.repetitions === false) parsed.cuts = parsed.cuts.filter((c) => c.kind === 'vicio');
  if (options.fillers === false) parsed.cuts = parsed.cuts.filter((c) => c.kind !== 'vicio');
  return parsed;
}
