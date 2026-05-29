/**
 * Value-pattern PII scrubbing tests for @allstak/nestjs (Sentry data-scrubbing
 * parity). Covers the two-tier redaction model:
 *
 *   A) ALWAYS scrub (regardless of sendDefaultPii):
 *      - credit-card numbers that PASS the Luhn checksum (Luhn-invalid digit
 *        runs are PRESERVED so order ids / timestamps are not nuked)
 *      - hyphenated US SSN (bare 9-digit numbers are NOT matched)
 *   B) Scrub UNLESS sendDefaultPii === true (default false):
 *      - email addresses
 *      - IPv4 literals (octet-validated)
 *
 * Plus end-to-end behavior through the exception filter: message/metadata are
 * value-scrubbed, explicit setUser identity is NOT scrubbed, key-based redaction
 * still works, stack frames are not corrupted, and the path is fail-open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAllStakNestExceptionFilter,
  createAllStakNestInterceptor,
  configureScope,
  scrubString,
  scrubValues,
  setUser,
} from '../src/index';

const R = '[REDACTED]';

// ── Unit: scrubString (the core value scanner) ──────────────────────────────

describe('scrubString — (A) credit cards (Luhn-gated, always on)', () => {
  it('redacts a Luhn-valid 16-digit card (sendDefaultPii false)', () => {
    expect(scrubString('charge 4111111111111111 today', false)).toBe(`charge ${R} today`);
  });
  it('redacts a Luhn-valid card with space separators', () => {
    expect(scrubString('card 4242 4242 4242 4242 ok', false)).toBe(`card ${R} ok`);
  });
  it('redacts a Luhn-valid card with hyphen separators', () => {
    expect(scrubString('card 5555-5555-5555-4444 ok', false)).toBe(`card ${R} ok`);
  });
  it('PRESERVES a 16-digit run that FAILS Luhn (order id, not a card)', () => {
    // 1234567890123456 is not Luhn-valid → must survive untouched.
    expect(scrubString('order 1234567890123456 shipped', false)).toBe('order 1234567890123456 shipped');
  });
  it('PRESERVES a 13-digit non-card numeric run (timestamp-like)', () => {
    expect(scrubString('ts 1234567890123 done', false)).toBe('ts 1234567890123 done');
  });
  it('scrubs credit cards even when sendDefaultPii is true (A is always on)', () => {
    expect(scrubString('card 4242424242424242 x', true)).toBe(`card ${R} x`);
  });
  it('does not slice a card out of a longer alphanumeric token', () => {
    // Embedded in a token (no boundary) → left alone to avoid corruption.
    const s = 'sku4111111111111111abc';
    expect(scrubString(s, false)).toBe(s);
  });
});

describe('scrubString — (A) US SSN (hyphen-required, always on)', () => {
  it('redacts a hyphenated SSN', () => {
    expect(scrubString('ssn 123-45-6789 on file', false)).toBe(`ssn ${R} on file`);
  });
  it('does NOT redact a bare 9-digit number (no hyphens)', () => {
    expect(scrubString('id 123456789 here', false)).toBe('id 123456789 here');
  });
  it('scrubs SSN even when sendDefaultPii is true', () => {
    expect(scrubString('ssn 123-45-6789', true)).toBe(`ssn ${R}`);
  });
});

describe('scrubString — (B) email (gated by sendDefaultPii)', () => {
  it('redacts an email when sendDefaultPii is false', () => {
    expect(scrubString('mail to jane.doe@example.com now', false)).toBe(`mail to ${R} now`);
  });
  it('PRESERVES an email when sendDefaultPii is true', () => {
    expect(scrubString('mail to jane.doe@example.com now', true)).toBe('mail to jane.doe@example.com now');
  });
});

describe('scrubString — (B) IPv4 (octet-validated, gated by sendDefaultPii)', () => {
  it('redacts a valid IPv4 when sendDefaultPii is false', () => {
    expect(scrubString('from 192.168.1.100 ok', false)).toBe(`from ${R} ok`);
  });
  it('PRESERVES a valid IPv4 when sendDefaultPii is true', () => {
    expect(scrubString('from 192.168.1.100 ok', true)).toBe('from 192.168.1.100 ok');
  });
  it('does NOT redact a dotted token with an out-of-range octet', () => {
    expect(scrubString('ver 999.1.2.3 build', false)).toBe('ver 999.1.2.3 build');
  });
});

describe('scrubString — (B) IPv6 best-effort', () => {
  it('redacts a full IPv6 literal when sendDefaultPii is false', () => {
    expect(scrubString('addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334 x', false)).toBe(`addr ${R} x`);
  });
  it('redacts a ::-compressed IPv6 literal', () => {
    expect(scrubString('addr 2001:db8::1 here', false)).toBe(`addr ${R} here`);
  });
  it('does NOT match an h:mm:ss timestamp as IPv6', () => {
    expect(scrubString('done at 12:34:56 today', false)).toBe('done at 12:34:56 today');
  });
  it('PRESERVES IPv6 when sendDefaultPii is true', () => {
    expect(scrubString('addr 2001:db8::1 here', true)).toBe('addr 2001:db8::1 here');
  });
});

describe('scrubString — fail-open + perf guards', () => {
  it('returns non-strings unchanged', () => {
    expect(scrubString(undefined as unknown as string, false)).toBe(undefined);
    expect(scrubString(123 as unknown as string, false)).toBe(123);
  });
  it('passes very large strings through unscanned (perf guard)', () => {
    const big = 'a@b.co '.repeat(5000); // > 16KB → unscanned
    expect(big.length).toBeGreaterThan(16 * 1024);
    expect(scrubString(big, false)).toBe(big);
  });
  it('combines all (A)+(B) scrubbers in one pass', () => {
    const s = 'u a@b.co ip 10.0.0.1 cc 4111111111111111 ssn 123-45-6789';
    expect(scrubString(s, false)).toBe(`u ${R} ip ${R} cc ${R} ssn ${R}`);
  });
});

// ── Unit: scrubValues (recursive, exempt keys) ──────────────────────────────

describe('scrubValues — recursion + exempt keys', () => {
  it('scrubs string values nested in objects/arrays', () => {
    const out = scrubValues(
      { a: 'a@b.co', nested: { b: ['10.0.0.1', 'safe'] } },
      { sendDefaultPii: false },
    );
    expect(out).toEqual({ a: R, nested: { b: [R, 'safe'] } });
  });
  it('exempts top-level keys from scrubbing', () => {
    const out = scrubValues(
      { userEmail: 'a@b.co', other: 'a@b.co' },
      { sendDefaultPii: false, exemptKeys: new Set(['userEmail']) },
    );
    expect(out).toEqual({ userEmail: 'a@b.co', other: R });
  });
  it('does not scrub object KEYS, only values', () => {
    const out = scrubValues({ 'a@b.co': 'plain' }, { sendDefaultPii: false });
    expect(Object.keys(out)).toEqual(['a@b.co']);
    expect((out as Record<string, unknown>)['a@b.co']).toBe('plain');
  });
  it('is fail-open on a self-referential (cyclic) object via depth cap', () => {
    const cyclic: Record<string, unknown> = { ip: '10.0.0.1' };
    cyclic.self = cyclic;
    // Must not throw / infinite-loop; top-level value still scrubbed.
    let out: Record<string, unknown> = {};
    expect(() => { out = scrubValues(cyclic, { sendDefaultPii: false }); }).not.toThrow();
    expect(out.ip).toBe(R);
  });
});

// ── Integration: exception filter wire path ─────────────────────────────────

interface IngestCall { url: string; body: any; }

function captureFetch(): IngestCall[] {
  const calls: IngestCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200 } as any;
  }));
  return calls;
}

const baseCfg = {
  apiKey: 'ask_dev_test',
  host: 'https://api.allstak.sa',
  environment: 'test',
  serviceName: 'redaction-test',
};

function throwThrough(filter: ReturnType<typeof createAllStakNestExceptionFilter>, error: Error): void {
  expect(() =>
    filter.catch(error, {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          originalUrl: '/x',
          headers: { authorization: 'Bearer SECRET' },
          allstakTraceId: 'c'.repeat(32),
          allstakRequestId: 'r',
          allstakSpanId: 'd'.repeat(16),
        }),
        getResponse: () => ({ statusCode: 500 }),
      }),
    }),
  ).toThrow();
}

function errors(calls: IngestCall[]): IngestCall[] {
  return calls.filter((c) => c.url.endsWith('/ingest/v1/errors'));
}

describe('@allstak/nestjs — value scrubbing on the wire path (exception filter)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); configureScope((s) => s.clear()); });
  afterEach(() => { vi.unstubAllGlobals(); configureScope((s) => s.clear()); });

  it('scrubs PII in the error message by default (sendDefaultPii false)', async () => {
    const calls = captureFetch();
    const filter = createAllStakNestExceptionFilter(baseCfg);
    throwThrough(filter, new Error('login failed for a@b.co from 10.0.0.1 card 4111111111111111'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    expect(errors(calls)[0].body.message).toBe(`login failed for ${R} from ${R} card ${R}`);
  });

  it('PRESERVES email + IPv4 in the message when sendDefaultPii is true', async () => {
    const calls = captureFetch();
    const filter = createAllStakNestExceptionFilter({ ...baseCfg, sendDefaultPii: true });
    throwThrough(filter, new Error('login failed for a@b.co from 10.0.0.1'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    expect(errors(calls)[0].body.message).toBe('login failed for a@b.co from 10.0.0.1');
  });

  it('ALWAYS scrubs credit cards + SSN even when sendDefaultPii is true', async () => {
    const calls = captureFetch();
    const filter = createAllStakNestExceptionFilter({ ...baseCfg, sendDefaultPii: true });
    throwThrough(filter, new Error('card 4111111111111111 ssn 123-45-6789'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    expect(errors(calls)[0].body.message).toBe(`card ${R} ssn ${R}`);
  });

  it('does NOT scrub explicit setUser email (intentional identity ships)', async () => {
    const calls = captureFetch();
    const interceptor = createAllStakNestInterceptor(baseCfg); // registers active ctx
    void interceptor;
    setUser({ id: 'u-1', email: 'owner@corp.com' });
    const filter = createAllStakNestExceptionFilter(baseCfg);
    throwThrough(filter, new Error('boom'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    const meta = errors(calls)[0].body.metadata;
    // Explicit user identity is exempt from value scrubbing.
    expect(meta.userEmail).toBe('owner@corp.com');
    expect(meta.userId).toBe('u-1');
  });

  it('scrubs PII that leaks into a NON-user extra value (not exempt)', async () => {
    const calls = captureFetch();
    const interceptor = createAllStakNestInterceptor(baseCfg);
    void interceptor;
    configureScope((s) => s.setExtra('note', 'reached out to other@corp.com'));
    const filter = createAllStakNestExceptionFilter(baseCfg);
    throwThrough(filter, new Error('boom'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    expect(errors(calls)[0].body.metadata['extra.note']).toBe(`reached out to ${R}`);
  });

  it('key-based redaction still works alongside value scrubbing', async () => {
    const calls = captureFetch();
    const interceptor = createAllStakNestInterceptor(baseCfg);
    void interceptor;
    configureScope((s) => s.setExtra('password', 'hunter2'));
    const filter = createAllStakNestExceptionFilter(baseCfg);
    throwThrough(filter, new Error('boom'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    // Key matches the denylist → whole value redacted by key, not value-scanned.
    expect(errors(calls)[0].body.metadata['extra.password']).toBe(R);
  });

  it('does NOT corrupt stack frame paths (frames are not value-scrubbed)', async () => {
    const calls = captureFetch();
    const filter = createAllStakNestExceptionFilter(baseCfg);
    const err = new Error('boom');
    // Craft a stack with a path that contains digits resembling nothing PII;
    // assert frames pass through untouched.
    err.stack = 'Error: boom\n    at handler (/srv/app/src/users/10.0.0.1.ts:42:7)';
    throwThrough(filter, err);
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    const frames: string[] = errors(calls)[0].body.stackTrace;
    expect(frames.some((f) => f.includes('/srv/app/src/users/10.0.0.1.ts:42:7'))).toBe(true);
  });
});
