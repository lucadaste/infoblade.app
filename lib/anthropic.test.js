import { describe, it, expect } from 'vitest';
import { parseBatchResults, toBatchParams } from './anthropic.js';

describe('parseBatchResults', () => {
  it('parses one result per JSONL line, in any order', () => {
    const text = [
      JSON.stringify({ custom_id: 'b', result: { type: 'errored' } }),
      '',
      JSON.stringify({ custom_id: 'a', result: { type: 'succeeded', message: { content: [] } } }),
    ].join('\n');
    const rows = parseBatchResults(text);
    expect(rows.map(r => r.custom_id)).toEqual(['b', 'a']);
    expect(rows[1].result.type).toBe('succeeded');
  });

  it('skips malformed lines and lines without a custom_id', () => {
    const text = `not json\n${JSON.stringify({ result: {} })}\n${JSON.stringify({ custom_id: 'ok', result: { type: 'expired' } })}`;
    expect(parseBatchResults(text).map(r => r.custom_id)).toEqual(['ok']);
  });

  it('handles empty input', () => {
    expect(parseBatchResults('')).toEqual([]);
    expect(parseBatchResults(null)).toEqual([]);
  });
});

describe('toBatchParams', () => {
  it('drops fallbacks (rejected by the Batches API) and keeps everything else', () => {
    const body = { model: 'claude-sonnet-5-5', max_tokens: 16000, fallbacks: 'default', system: [], messages: [] };
    expect(toBatchParams(body)).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 16000, system: [], messages: [] });
    expect(body.fallbacks).toBe('default');
  });
});
