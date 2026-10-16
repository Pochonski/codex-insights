import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionIndex } from '../src/collectors/sessions';
import { aggregate } from '../src/analytics/aggregate';

function usage(input: number, timestamp: string): string {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0 } } } });
}

function fixture(): { dir: string; root: string; file: string; state: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-incremental-'));
  const root = path.join(dir, 'sessions');
  const file = path.join(root, 'session.jsonl');
  require('node:fs').mkdirSync(root);
  return { dir, root, file, state: path.join(dir, 'index.json') };
}

describe('incremental JSONL indexing', () => {
  it('reads only appended bytes and does not duplicate cumulative counters', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const index = new SessionIndex(f.state);
      const first = await index.scan(f.root);
      appendFileSync(f.file, usage(150, '2026-10-15T00:01:00Z') + '\n');
      const second = await index.scan(f.root);
      expect(first.metrics.bytesRead).toBeGreaterThan(0);
      expect(second.metrics.bytesRead).toBeLessThan(statSync(f.file).size);
      expect(aggregate(second.events).total.inputTokens).toBe(150);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('keeps an incomplete final line until it is completed', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const index = new SessionIndex(f.state);
      await index.scan(f.root);
      const trailing = usage(150, '2026-10-15T00:01:00Z');
      appendFileSync(f.file, trailing);
      const partial = await index.scan(f.root);
      expect(aggregate(partial.events).total.inputTokens).toBe(100);
      appendFileSync(f.file, '\n');
      const complete = await index.scan(f.root);
      expect(aggregate(complete.events).total.inputTokens).toBe(150);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('archives a replaced file and preserves historical observations', async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, usage(100, '2026-10-15T00:00:00Z') + '\n');
      const index = new SessionIndex(f.state);
      await index.scan(f.root);
      renameSync(f.file, f.file + '.rotated');
      writeFileSync(f.file, usage(20, '2026-10-15T01:00:00Z') + '\n');
      const scan = await index.scan(f.root);
      expect(aggregate(scan.events).total.inputTokens).toBe(120);
      index.close();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
