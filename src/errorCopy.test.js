// #1954: the server's stable error codes and the player copy for them.
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, HttpError } from '../worker/lib/http.js';
import { PLAYER_ERROR_COPY, playerErrorMessage } from './errorCopy.js';

describe('player copy for server error codes (#1954)', () => {
  it('has copy for every code the server can send, and no orphaned copy', () => {
    expect(Object.keys(PLAYER_ERROR_COPY).sort()).toEqual(Object.values(ERROR_CODES).sort());
  });

  it('reads like something a player can act on, never like internals', () => {
    for (const [code, copy] of Object.entries(PLAYER_ERROR_COPY)) {
      expect(copy.length, code).toBeGreaterThan(10);
      // Customer-facing spelling uses the accent (the plain "landlet" is for code).
      expect(copy, code).not.toMatch(/\blandlet/i);
      expect(copy, code).not.toMatch(/refetch|HTTP|\b[45]\d\d\b|#\d+|SPEC|API\.md|concurrent/i);
    }
  });

  it('maps a known code to its copy, and anything else to the fallback', () => {
    expect(playerErrorMessage('changed_concurrently', 'raw server text')).toBe(PLAYER_ERROR_COPY.changed_concurrently);
    expect(playerErrorMessage('some_future_code', 'raw server text')).toBe('raw server text');
    expect(playerErrorMessage(undefined, 'raw server text')).toBe('raw server text');
    expect(playerErrorMessage(null, 'raw server text')).toBe('raw server text');
    // Inherited object keys are not codes.
    expect(playerErrorMessage('toString', 'raw server text')).toBe('raw server text');
    expect(playerErrorMessage('__proto__', 'raw server text')).toBe('raw server text');
  });
});

describe('HttpError codes on the server (#1954)', () => {
  it('exposes the code, keeps the developer-facing message, and sends the code in the extra fields', () => {
    const error = new HttpError('Landlet changed concurrently — refetch and retry', 409, { code: ERROR_CODES.CHANGED_CONCURRENTLY });
    expect(error.code).toBe('changed_concurrently');
    expect(error.message).toBe('Landlet changed concurrently — refetch and retry');
    expect(error.status).toBe(409);
    // index.js serialises `{ error: message, ...extra }`, so this is what reaches the wire.
    expect({ error: error.message, ...error.extra }).toEqual({
      error: 'Landlet changed concurrently — refetch and retry', code: 'changed_concurrently',
    });
  });

  it('has no code when none is given, so the message is still what the player sees', () => {
    expect(new HttpError('Password must be at least 8 characters.', 400).code).toBeNull();
  });
});
