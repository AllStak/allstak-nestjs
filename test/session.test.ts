/**
 * Release-health session tracking for @allstak/nestjs.
 *
 * Covers:
 *   - /sessions/start payload shape (NEVER sampled, fired through transport)
 *   - /sessions/end payload shape + status transitions (ok → errored → crashed)
 *   - sessionId preserved on the wire (not redacted) and attached to errors
 *   - enableAutoSessionTracking=false opt-out (no session network calls)
 *   - fail-open behaviour (transport failure must not throw on init/shutdown)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AllStakNestTransport,
  SDK_NAME,
  SDK_VERSION,
  Session,
  SessionTracker,
  createAllStakNestExceptionFilter,
  createAllStakNestSessionLifecycle,
  _getActiveSessionTracker,
  _resetSessionTrackerForTest,
} from '../src/index';

function makeTransport(fetchSpy: ReturnType<typeof vi.fn>): AllStakNestTransport {
  return new AllStakNestTransport({
    host: 'https://api.allstak.sa',
    apiKey: 'ask_dev_test',
    fetch: fetchSpy as unknown as typeof fetch,
  });
}

function bodyOf(call: any): any {
  return JSON.parse(call[1].body);
}

function callsFor(fetchSpy: ReturnType<typeof vi.fn>, suffix: string): any[] {
  return fetchSpy.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetSessionTrackerForTest();
});

// ── Session model (mirrors the Java reference Session/SessionStatus) ─────────

describe('@allstak/nestjs — Session status model', () => {
  it('starts ok, recordError → errored, recordCrash → crashed (terminal)', () => {
    const s = new Session();
    expect(s.status).toBe('ok');
    expect(s.errorCount).toBe(0);

    s.recordError();
    s.recordError();
    expect(s.status).toBe('errored');
    expect(s.errorCount).toBe(2);

    s.recordCrash();
    expect(s.status).toBe('crashed');
    expect(s.errorCount).toBe(3);

    // crashed is terminal: a later handled error does not downgrade it.
    s.recordError();
    expect(s.status).toBe('crashed');
  });

  it('durationMs is non-negative and reflects elapsed time', () => {
    const s = new Session('fixed-id', 1_000);
    expect(s.durationMs(2_500)).toBe(1_500);
    expect(s.durationMs(500)).toBe(0); // floored at 0
  });
});

// ── SessionTracker lifecycle ─────────────────────────────────────────────────

describe('@allstak/nestjs — SessionTracker start payload', () => {
  it('POSTs /sessions/start with the documented shape and is NEVER sampled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker(
      {
        release: 'rel@1.2.3',
        environment: 'production',
        userId: 'user-9',
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
        platform: 'node',
      },
      makeTransport(fetchSpy),
    );
    const session = tracker.start();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/start').length).toBe(1));

    const startCall = callsFor(fetchSpy, '/ingest/v1/sessions/start')[0];
    // Auth header reused from the SDK's other ingest calls.
    expect(startCall[1].headers['X-AllStak-Key']).toBe('ask_dev_test');
    const body = bodyOf(startCall);
    expect(body.sessionId).toBe(session.id);
    expect(body.sessionId).toMatch(/[0-9a-f]/i); // survived redaction
    expect(body.release).toBe('rel@1.2.3');
    expect(body.environment).toBe('production');
    expect(body.userId).toBe('user-9');
    expect(body.sdkName).toBe(SDK_NAME);
    expect(body.sdkVersion).toBe(SDK_VERSION);
    expect(body.platform).toBe('node');
  });

  it('is idempotent — a second start() reuses the same session id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker({ release: 'r' }, makeTransport(fetchSpy));
    const first = tracker.start();
    const second = tracker.start();
    expect(second.id).toBe(first.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(callsFor(fetchSpy, '/ingest/v1/sessions/start')).toHaveLength(1);
  });

  it('with no release: skips the network call but keeps in-memory tracking', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker({ release: '' }, makeTransport(fetchSpy));
    const session = tracker.start();
    tracker.recordError();
    tracker.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(session.status).toBe('errored');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('@allstak/nestjs — SessionTracker end payload + status transitions', () => {
  it('end() posts status=ok with a numeric durationMs when no errors', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker({ release: 'r' }, makeTransport(fetchSpy));
    const session = tracker.start();
    tracker.end();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/end').length).toBe(1));
    const body = bodyOf(callsFor(fetchSpy, '/ingest/v1/sessions/end')[0]);
    expect(body.sessionId).toBe(session.id);
    expect(body.status).toBe('ok');
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ok → errored: a handled error then end() posts status=errored', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker({ release: 'r' }, makeTransport(fetchSpy));
    tracker.start();
    tracker.recordError();
    tracker.end();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/end').length).toBe(1));
    expect(bodyOf(callsFor(fetchSpy, '/ingest/v1/sessions/end')[0]).status).toBe('errored');
  });

  it('errored → crashed: a crash overrides errored at end()', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker({ release: 'r' }, makeTransport(fetchSpy));
    tracker.start();
    tracker.recordError();
    tracker.recordCrash();
    tracker.end();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/end').length).toBe(1));
    expect(bodyOf(callsFor(fetchSpy, '/ingest/v1/sessions/end')[0]).status).toBe('crashed');
  });

  it('end() is idempotent — a second end() is a no-op', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker({ release: 'r' }, makeTransport(fetchSpy));
    tracker.start();
    tracker.end();
    tracker.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(callsFor(fetchSpy, '/ingest/v1/sessions/end')).toHaveLength(1);
  });

  it('explicit final status overrides the accumulated status', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const tracker = new SessionTracker({ release: 'r' }, makeTransport(fetchSpy));
    tracker.start();
    tracker.recordError();
    tracker.end('abnormal');
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/end').length).toBe(1));
    expect(bodyOf(callsFor(fetchSpy, '/ingest/v1/sessions/end')[0]).status).toBe('abnormal');
  });
});

// ── Lifecycle provider (module init / shutdown) ──────────────────────────────

describe('@allstak/nestjs — session lifecycle provider', () => {
  it('onModuleInit opens a session; onApplicationShutdown closes it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchSpy);
    const lifecycle = createAllStakNestSessionLifecycle({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      environment: 'production',
      release: 'lifecycle@1.0.0',
      // explicit opt-in so the unit-test runtime guard does not skip it
      enableAutoSessionTracking: true,
    });
    lifecycle.onModuleInit();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/start').length).toBe(1));
    const startBody = bodyOf(callsFor(fetchSpy, '/ingest/v1/sessions/start')[0]);
    expect(startBody.release).toBe('lifecycle@1.0.0');
    expect(startBody.platform).toBe('node');
    expect(_getActiveSessionTracker()).not.toBeNull();

    lifecycle.onApplicationShutdown();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/end').length).toBe(1));
    const endBody = bodyOf(callsFor(fetchSpy, '/ingest/v1/sessions/end')[0]);
    expect(endBody.sessionId).toBe(startBody.sessionId);
    expect(endBody.status).toBe('ok');
    expect(_getActiveSessionTracker()).toBeNull();
  });

  it('enableAutoSessionTracking=false opts out — no session network calls', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchSpy);
    const lifecycle = createAllStakNestSessionLifecycle({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'optout@1.0.0',
      enableAutoSessionTracking: false,
    });
    lifecycle.onModuleInit();
    lifecycle.onApplicationShutdown();
    await new Promise((r) => setTimeout(r, 10));
    expect(callsFor(fetchSpy, '/ingest/v1/sessions/start')).toHaveLength(0);
    expect(callsFor(fetchSpy, '/ingest/v1/sessions/end')).toHaveLength(0);
    expect(_getActiveSessionTracker()).toBeNull();
  });

  it('is fail-open: a throwing transport does not break init or shutdown', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('dns down')));
    const lifecycle = createAllStakNestSessionLifecycle({
      apiKey: 'ask_dev_test',
      host: 'https://api.invalid',
      release: 'failopen@1.0.0',
      enableAutoSessionTracking: true,
    });
    expect(() => lifecycle.onModuleInit()).not.toThrow();
    expect(() => lifecycle.onApplicationShutdown()).not.toThrow();
  });
});

// ── sessionId attached to error events + session status from errors ──────────

describe('@allstak/nestjs — sessionId on error events', () => {
  function makeFilterContext() {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          originalUrl: '/x',
          headers: {},
          allstakTraceId: 'c'.repeat(32),
          allstakRequestId: 'r',
          allstakSpanId: 'd'.repeat(16),
        }),
        getResponse: () => ({ statusCode: 500 }),
      }),
    };
  }

  it('error payload carries the active sessionId (un-redacted) and marks session errored', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchSpy);

    // Open a session via the lifecycle so the module-level tracker is active.
    const lifecycle = createAllStakNestSessionLifecycle({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'err@1.0.0',
      enableAutoSessionTracking: true,
    });
    lifecycle.onModuleInit();
    const sessionId = _getActiveSessionTracker()!.current()!.id;

    const filter = createAllStakNestExceptionFilter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'err@1.0.0',
    });
    expect(() => filter.catch(new Error('boom'), makeFilterContext())).toThrow();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/errors').length).toBe(1));
    const errBody = bodyOf(callsFor(fetchSpy, '/ingest/v1/errors')[0]);
    expect(errBody.sessionId).toBe(sessionId);
    expect(errBody.sdkName).toBe(SDK_NAME);
    expect(errBody.sdkVersion).toBe(SDK_VERSION);
    expect(errBody.platform).toBe('node');

    // The handled request error escalated the session to errored.
    expect(_getActiveSessionTracker()!.current()!.status).toBe('errored');

    lifecycle.onApplicationShutdown();
    await vi.waitFor(() => expect(callsFor(fetchSpy, '/ingest/v1/sessions/end').length).toBe(1));
    expect(bodyOf(callsFor(fetchSpy, '/ingest/v1/sessions/end')[0]).status).toBe('errored');
  });
});
