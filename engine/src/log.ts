import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), 'AutoEdit');

/** One line per problem in %TEMP%/AutoEdit/motor.log, so a failure can be looked at after the fact. */
export function log(...parts: unknown[]) {
  const line = new Date().toISOString() + ' ' + parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, 'motor.log'), line + '\n'); } catch { /* logging must never break a job */ }
}
