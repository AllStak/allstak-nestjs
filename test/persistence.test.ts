/**
 * Offline / persistent event queue for @allstak/nestjs.
 *
 * Covers (per the offline-queue spec):
 *   - persist-on-send-failure (network error → scrubbed body written to spool)
 *   - drain-and-resend-on-init (a new transport replays the spool, removes on 2xx)
 *   - scrub-before-persist (no secret value ever hits disk)
 *   - cap / eviction (drop OLDEST when over the count cap)
 *   - session lifecycle calls are NOT persisted (live-only)
 *   - opt-out flag (enableOfflineQueue=false / offlineQueue:false disables it)
 *   - graceful no-op when the store is unavailable (unwritable dir → in-memory)
 *
 * Spool dirs are isolated per test via mkdtempSync so suites never collide and
 * exact fetch-count assertions stay stable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AllStakNestTransport, EventSpool } from '../src/index';

function tmpSpoolDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'allstak-spool-test-'));
}

function listSpoolFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith('allstak-') && f.endsWith('.json'));
  } catch {
    return [];
  }
}

function spoolBodies(dir: string): string[] {
  return listSpoolFiles(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

const dirs: string[] = [];
beforeEach(() => {
  dirs.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function freshDir(): string {
  const d = tmpSpoolDir();
  dirs.push(d);
  return d;
}

function makeTransport(fetchSpy: ReturnType<typeof vi.fn>, dir: string, extra: Record<string, unknown> = {}): AllStakNestTransport {
  return new AllStakNestTransport({
    host: 'https://api.allstak.sa',
    apiKey: 'ask_dev_test',
    fetch: fetchSpy as unknown as typeof fetch,
    // Passing an object (not a bool) clears the unit-test runtime guard so the
    // spool is exercised deterministically against an isolated dir.
    offlineQueue: { enabled: true, dir, ...extra },
  });
}

// ── persist-on-send-failure ───────────────────────────────────────────────────

describe('@allstak/nestjs — offline queue: persist on send failure', () => {
  it('writes the scrubbed body to the spool when the network rejects', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const dir = freshDir();
    const transport = makeTransport(fetchSpy, dir);

    await transport.send('/ingest/v1/errors', { message: 'boom', level: 'error' });

    expect(fetchSpy).toHaveBeenCalledTimes(1); // it tried the network first
    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(spoolBodies(dir)[0]);
    expect(record.path).toBe('/ingest/v1/errors');
    expect(JSON.parse(record.body).message).toBe('boom');
  });

  it('persists on overflow instead of dropping', async () => {
    // Never resolves ⇒ requests stay in-flight and saturate the budget.
    const fetchSpy = vi.fn(() => new Promise(() => {}));
    const dir = freshDir();
    const transport = new AllStakNestTransport({
      host: 'https://api.allstak.sa',
      apiKey: 'ask_dev_test',
      fetch: fetchSpy as unknown as typeof fetch,
      maxConcurrent: 1,
      offlineQueue: { enabled: true, dir },
    });

    void transport.send('/ingest/v1/errors', { message: 'first' }); // occupies the slot
    await transport.send('/ingest/v1/errors', { message: 'overflow' }); // over budget → persist

    expect(listSpoolFiles(dir)).toHaveLength(1);
    expect(transport.stats().dropped).toBe(0);
    const record = JSON.parse(spoolBodies(dir)[0]);
    expect(JSON.parse(record.body).message).toBe('overflow');
  });

  it('persists buffered events when shutting down', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const dir = freshDir();
    const transport = makeTransport(fetchSpy, dir);
    await transport.shutdown(0);

    await transport.send('/ingest/v1/spans', { spans: [{ op: 'x' }] });
    expect(fetchSpy).not.toHaveBeenCalled(); // shutting down: no network
    expect(listSpoolFiles(dir)).toHaveLength(1);
  });
});

// ── scrub-before-persist ──────────────────────────────────────────────────────

describe('@allstak/nestjs — offline queue: scrub before persist', () => {
  it('never writes an un-redacted secret to disk', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const dir = freshDir();
    const transport = makeTransport(fetchSpy, dir);

    await transport.send('/ingest/v1/errors', {
      message: 'failed login',
      password: 'hunter2-SUPERSECRET',
      authorization: 'Bearer LEAKED-TOKEN',
      metadata: { apiKey: 'sk_live_DEADBEEF' },
    });

    const onDisk = spoolBodies(dir).join('\n');
    // The scrubbed body is what's persisted: secrets must not appear at all.
    expect(onDisk).not.toContain('hunter2-SUPERSECRET');
    expect(onDisk).not.toContain('LEAKED-TOKEN');
    expect(onDisk).not.toContain('sk_live_DEADBEEF');
    expect(onDisk).toContain('[REDACTED]');
    // Non-sensitive fields survive so the event is still useful.
    expect(onDisk).toContain('failed login');
  });
});

// ── drain-and-resend-on-init ──────────────────────────────────────────────────

describe('@allstak/nestjs — offline queue: drain & resend on init', () => {
  it('a new transport replays spooled events and removes them on 2xx', async () => {
    const dir = freshDir();
    // Seed the spool via a failing transport (simulating a previous process).
    const failing = vi.fn().mockRejectedValue(new Error('offline'));
    const t1 = makeTransport(failing, dir);
    await t1.send('/ingest/v1/errors', { message: 'persisted-1' });
    await t1.send('/ingest/v1/spans', { spans: [{ op: 'persisted-2' }] });
    expect(listSpoolFiles(dir)).toHaveLength(2);

    // New process / restored network: a fresh transport drains on init.
    const ok = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const t2 = makeTransport(ok, dir);
    await vi.waitFor(() => expect(ok.mock.calls.length).toBe(2));
    const sentBodies = ok.mock.calls.map(([, init]: any) => JSON.parse(init.body));
    const messages = sentBodies.map((b: any) => b.message ?? b.spans?.[0]?.op);
    expect(messages).toContain('persisted-1');
    expect(messages).toContain('persisted-2');
    // Accepted (2xx) ⇒ removed from the spool.
    await vi.waitFor(() => expect(listSpoolFiles(dir)).toHaveLength(0));
  });

  it('keeps an entry on a transient (5xx/429) replay failure, removes on permanent 4xx', async () => {
    const dir = freshDir();
    const failing = vi.fn().mockRejectedValue(new Error('offline'));
    const t1 = makeTransport(failing, dir);
    await t1.send('/ingest/v1/errors', { message: 'retry-me' });
    expect(listSpoolFiles(dir)).toHaveLength(1);

    // Replay returns 503 (transient) ⇒ entry stays for the next drain.
    const transient = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const t2 = makeTransport(transient, dir);
    await vi.waitFor(() => expect(transient.mock.calls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(listSpoolFiles(dir)).toHaveLength(1); // kept

    // Replay returns 400 (permanent) ⇒ entry dropped (not retriable).
    const permanent = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const t3 = makeTransport(permanent, dir);
    await vi.waitFor(() => expect(permanent.mock.calls.length).toBe(1));
    await vi.waitFor(() => expect(listSpoolFiles(dir)).toHaveLength(0));
  });
});

// ── cap / eviction (drop oldest) ──────────────────────────────────────────────

describe('@allstak/nestjs — offline queue: bounded / drop oldest', () => {
  it('evicts the OLDEST entries when over the count cap', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const dir = freshDir();
    const transport = makeTransport(fetchSpy, dir, { maxEntries: 3 });

    for (let i = 1; i <= 6; i++) {
      await transport.send('/ingest/v1/errors', { message: `evt-${i}` });
    }
    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(3);
    const bodies = spoolBodies(dir).map((r) => JSON.parse(JSON.parse(r).body).message);
    // Oldest (evt-1..3) evicted; newest 3 retained.
    expect(bodies.sort()).toEqual(['evt-4', 'evt-5', 'evt-6']);
  });
});

// ── session lifecycle paths are NOT persisted ─────────────────────────────────

describe('@allstak/nestjs — offline queue: session calls are live-only', () => {
  it('does not persist /sessions/start or /sessions/end even on failure', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const dir = freshDir();
    const transport = makeTransport(fetchSpy, dir);

    await transport.send('/ingest/v1/sessions/start', { sessionId: 's1', release: 'r' });
    await transport.send('/ingest/v1/sessions/end', { sessionId: 's1', status: 'ok' });
    // A persistable event proves the spool itself is working.
    await transport.send('/ingest/v1/errors', { message: 'kept' });

    const files = listSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(spoolBodies(dir)[0]);
    expect(record.path).toBe('/ingest/v1/errors');
  });
});

// ── opt-out flag ──────────────────────────────────────────────────────────────

describe('@allstak/nestjs — offline queue: opt-out', () => {
  it('offlineQueue:false keeps the in-memory drop-on-overflow behaviour', async () => {
    const fetchSpy = vi.fn(() => new Promise(() => {})); // saturate budget
    const dir = freshDir();
    const transport = new AllStakNestTransport({
      host: 'https://api.allstak.sa',
      apiKey: 'ask_dev_test',
      fetch: fetchSpy as unknown as typeof fetch,
      maxConcurrent: 1,
      offlineQueue: false,
    });

    void transport.send('/ingest/v1/errors', { message: 'first' });
    await transport.send('/ingest/v1/errors', { message: 'overflow' });

    expect(transport.spoolLocation()).toBeNull();
    expect(transport.stats().dropped).toBe(1); // dropped, not persisted
    expect(listSpoolFiles(dir)).toHaveLength(0);
  });

  it('offlineQueue:{enabled:false} also disables persistence', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const dir = freshDir();
    const transport = new AllStakNestTransport({
      host: 'https://api.allstak.sa',
      apiKey: 'ask_dev_test',
      fetch: fetchSpy as unknown as typeof fetch,
      offlineQueue: { enabled: false, dir },
    });
    await transport.send('/ingest/v1/errors', { message: 'gone' });
    expect(listSpoolFiles(dir)).toHaveLength(0);
    expect(transport.spoolLocation()).toBeNull();
  });
});

// ── graceful no-op when the store is unavailable ──────────────────────────────

describe('@allstak/nestjs — offline queue: graceful degradation', () => {
  it('an unwritable spool dir degrades to in-memory and never throws', async () => {
    // Point at a path under a regular FILE so mkdirSync fails (ENOTDIR).
    const file = path.join(freshDir(), 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const unwritable = path.join(file, 'spool');

    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const transport = new AllStakNestTransport({
      host: 'https://api.allstak.sa',
      apiKey: 'ask_dev_test',
      fetch: fetchSpy as unknown as typeof fetch,
      offlineQueue: { enabled: true, dir: unwritable },
    });

    expect(transport.spoolLocation()).toBeNull(); // degraded to in-memory
    await expect(transport.send('/ingest/v1/errors', { message: 'x' })).resolves.toBeUndefined();
    expect(transport.stats().persisted).toBe(0);
  });

  it('EventSpool reports disabled and no-ops on an unwritable dir', () => {
    const file = path.join(freshDir(), 'plain-file');
    fs.writeFileSync(file, 'x');
    const spool = new EventSpool({ dir: path.join(file, 'spool') });
    expect(spool.isEnabled()).toBe(false);
    expect(spool.location()).toBeNull();
    expect(() => spool.persist('/ingest/v1/errors', '{}')).not.toThrow();
    expect(spool.persist('/ingest/v1/errors', '{}')).toBe(false);
    expect(spool.load()).toEqual([]);
    expect(spool.size()).toBe(0);
  });
});

// ── EventSpool unit: max-age pruning ──────────────────────────────────────────

describe('@allstak/nestjs — EventSpool max-age pruning', () => {
  it('prunes entries older than maxAgeMs on load', () => {
    const dir = freshDir();
    const spool = new EventSpool({ dir, maxAgeMs: 1000 });
    const now = 10_000_000;
    spool.persist('/ingest/v1/errors', JSON.stringify({ message: 'stale' }), now - 5000);
    spool.persist('/ingest/v1/errors', JSON.stringify({ message: 'fresh' }), now - 100);
    expect(listSpoolFiles(dir)).toHaveLength(2);

    const loaded = spool.load(now);
    expect(loaded).toHaveLength(1);
    expect(JSON.parse(loaded[0].body).message).toBe('fresh');
    expect(listSpoolFiles(dir)).toHaveLength(1); // stale file pruned from disk
  });
});
