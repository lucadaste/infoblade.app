import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifySvixSignature } from '../api/clerk-webhook.js';
import { deleteUserData } from './account-data.js';

const SECRET = 'whsec_' + Buffer.from('test-secret-key-bytes').toString('base64');

function sign(id, timestamp, body, secret = SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

describe('verifySvixSignature', () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"user.deleted","data":{"id":"user_123"}}';

  it('accepts a correctly signed request', () => {
    expect(verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: ts, signatureHeader: sign('msg_1', ts, body), body, now })).toBe(true);
  });

  it('accepts when any of several signatures matches', () => {
    const header = 'v1,AAAA ' + sign('msg_1', ts, body);
    expect(verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: ts, signatureHeader: header, body, now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = sign('msg_1', ts, body);
    expect(verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: ts, signatureHeader: header, body: body.replace('123', '999'), now })).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    const other = 'whsec_' + Buffer.from('some-other-key').toString('base64');
    expect(verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: ts, signatureHeader: sign('msg_1', ts, body, other), body, now })).toBe(false);
  });

  it('rejects stale timestamps (replay)', () => {
    const old = String(now / 1000 - 10 * 60);
    expect(verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: old, signatureHeader: sign('msg_1', old, body), body, now })).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(verifySvixSignature({ secret: SECRET, id: undefined, timestamp: ts, signatureHeader: sign('msg_1', ts, body), body, now })).toBe(false);
    expect(verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: ts, signatureHeader: undefined, body, now })).toBe(false);
  });
});

function fakeSupabase({ failTable } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        delete() { return { eq(col, val) { calls.push(['delete', table, col, val]); return Promise.resolve({ error: table === failTable ? { message: 'boom' } : null }); } }; },
        update(values) { return { eq(col, val) { calls.push(['update', table, values, col, val]); return Promise.resolve({ error: null }); } }; },
      };
    },
  };
}

describe('deleteUserData', () => {
  it('deletes every watchlist and detaches predictions', async () => {
    const sb = fakeSupabase();
    await deleteUserData(sb, 'user_123');
    expect(sb.calls).toEqual([
      ['delete', 'watchlists', 'user_id', 'user_123'],
      ['delete', 'crypto_watchlists', 'user_id', 'user_123'],
      ['delete', 'market_watchlists', 'user_id', 'user_123'],
      ['update', 'predictions', { user_id: null }, 'user_id', 'user_123'],
    ]);
  });

  it('still attempts every table when one fails, then throws', async () => {
    const sb = fakeSupabase({ failTable: 'crypto_watchlists' });
    await expect(deleteUserData(sb, 'user_123')).rejects.toThrow(/crypto_watchlists/);
    expect(sb.calls).toHaveLength(4);
  });

  it('refuses an empty user id', async () => {
    await expect(deleteUserData(fakeSupabase(), '')).rejects.toThrow();
  });
});
