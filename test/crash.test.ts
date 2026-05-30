/**
 * Process-level fatal-error handlers for @allstak/nestjs.
 *
 * Covers:
 *   - installGlobalErrorHandlers registers uncaughtException + unhandledRejection
 *   - an uncaughtException is captured at fatal level, session ends crashed,
 *     telemetry is flushed, and Node semantics are preserved (re-emit when the
 *     SDK is the only listener; no forced exit when the host has its own)
 *   - an unhandledRejection is captured + ends the session crashed (no re-emit)
 *   - install is idempotent and uninstall removes exactly our listeners
 *   - fail-open: a throwing capture/flush never escapes the handler
 *   - the lifecycle installs handlers (default on), captures a crash at fatal
 *     level through the active context, and ends the session crashed
 *   - enableGlobalErrorHandlers=false opts out
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installGlobalErrorHandlers,
  createAllStakNestSessionLifecycle,
  _getActiveSessionTracker,
  _resetSessionTrackerForTest,
  _resetGlobalErrorHandlersForTest,
  type CrashDeps,
  type CrashProcess,
} from '../src/index';

/** A fake process that records listeners and can fire events synchronously. */
function makeFakeProcess() {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const proc: CrashProcess & {
    fire: (event: string, ...args: any[]) => void;
    count: (event: string) => number;
  } = {
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return proc;
    },
    off(event, listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      return proc;
    },
    listeners(event) {
      return [...(listeners[event] ?? [])];
    },
    fire(event, ...args) {
      for (const l of [...(listeners[event] ?? [])]) l(...args);
    },
    count(event) {
      return (listeners[event] ?? []).length;
    },
  };
  return proc;
}

/** Drain pending microtasks (finalize() chains a few awaits before re-emit). */
async function flushMicrotasks(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function makeDeps(overrides: Partial<CrashDeps> = {}) {
  const calls = { captured: [] as Array<{ error: unknown; source: string }>, ended: 0, flushed: 0 };
  const deps: CrashDeps = {
    captureFatal: (error, source) => calls.captured.push({ error, source }),
    endSessionCrashed: () => {
      calls.ended++;
    },
    flush: async () => {
      calls.flushed++;
    },
    ...overrides,
  };
  return { deps, calls };
}

afterEach(() => {
  _resetGlobalErrorHandlersForTest();
  _resetSessionTrackerForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('@allstak/nestjs — installGlobalErrorHandlers', () => {
  it('registers both process handlers and returns an uninstaller', () => {
    const proc = makeFakeProcess();
    const { deps } = makeDeps();
    const uninstall = installGlobalErrorHandlers(deps, proc);
    expect(proc.count('uncaughtException')).toBe(1);
    expect(proc.count('unhandledRejection')).toBe(1);
    uninstall();
    expect(proc.count('uncaughtException')).toBe(0);
    expect(proc.count('unhandledRejection')).toBe(0);
  });

  it('uncaughtException: captures fatal, ends crashed, flushes', async () => {
    const proc = makeFakeProcess();
    // A host listener exists so the SDK does NOT re-emit (an out-of-band
    // re-throw would escape the runner). Re-emit behaviour is asserted in its
    // own test via a setTimeout spy; here we only assert capture/end/flush.
    proc.on('uncaughtException', () => {});
    const { deps, calls } = makeDeps();
    installGlobalErrorHandlers(deps, proc);
    const boom = new Error('fatal boom');
    proc.fire('uncaughtException', boom);
    // finalize() is async — let the microtasks settle.
    await flushMicrotasks();
    expect(calls.captured).toEqual([{ error: boom, source: 'uncaughtException' }]);
    expect(calls.ended).toBe(1);
    expect(calls.flushed).toBe(1);
  });

  it('uncaughtException: re-emits when the SDK is the only listener (Node default preserved)', async () => {
    const proc = makeFakeProcess();
    const { deps } = makeDeps();
    // Spy on setTimeout so the out-of-band re-throw is observed, not executed
    // (executing it would escape the test runner — that is exactly Node's
    // crash-and-exit behaviour we are preserving).
    const scheduled: Array<() => void> = [];
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void) => {
        scheduled.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as any);
    try {
      installGlobalErrorHandlers(deps, proc);
      const boom = new Error('terminate me');
      proc.fire('uncaughtException', boom);
      await flushMicrotasks();
      // With the SDK as the sole listener a re-throw was scheduled (Node would
      // otherwise crash-and-exit). Invoking it re-throws the original error.
      expect(scheduled.length).toBe(1);
      expect(scheduled[0]).toThrow('terminate me');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('uncaughtException: does NOT re-emit when the host has its own listener', async () => {
    const proc = makeFakeProcess();
    // Host installs its own listener FIRST.
    proc.on('uncaughtException', () => {});
    const { deps } = makeDeps();
    const scheduled: Array<() => void> = [];
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void) => {
        scheduled.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as any);
    try {
      installGlobalErrorHandlers(deps, proc);
      proc.fire('uncaughtException', new Error('host-owned'));
      await flushMicrotasks();
      // Host owns the exit decision; the SDK did not schedule a re-throw.
      expect(scheduled.length).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('unhandledRejection: captures fatal + ends crashed (no re-emit)', async () => {
    const proc = makeFakeProcess();
    const { deps, calls } = makeDeps();
    installGlobalErrorHandlers(deps, proc);
    const reason = new Error('rejected');
    proc.fire('unhandledRejection', reason);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.captured).toEqual([{ error: reason, source: 'unhandledRejection' }]);
    expect(calls.ended).toBe(1);
    expect(calls.flushed).toBe(1);
  });

  it('install is idempotent — a second install does not double-register', () => {
    const proc = makeFakeProcess();
    const { deps } = makeDeps();
    installGlobalErrorHandlers(deps, proc);
    installGlobalErrorHandlers(deps, proc); // no-op (marker set)
    expect(proc.count('uncaughtException')).toBe(1);
    expect(proc.count('unhandledRejection')).toBe(1);
  });

  it('fail-open: a throwing capture never escapes the handler', async () => {
    const proc = makeFakeProcess();
    const { deps } = makeDeps({
      captureFatal: () => {
        throw new Error('capture boom');
      },
    });
    installGlobalErrorHandlers(deps, proc);
    expect(() => proc.fire('unhandledRejection', new Error('x'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('off Node (no process) is a safe no-op', () => {
    const { deps } = makeDeps();
    // Pass an object that is not a usable process.
    const uninstall = installGlobalErrorHandlers(deps, { on: undefined } as unknown as CrashProcess);
    expect(typeof uninstall).toBe('function');
    expect(() => uninstall()).not.toThrow();
  });
});

describe('@allstak/nestjs — lifecycle wires the global handlers', () => {
  it('installs handlers, captures a crash at fatal level, ends session crashed', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchSpy);
    const proc = makeFakeProcess();
    const lifecycle = createAllStakNestSessionLifecycle({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'crash@1.0.0',
      environment: 'production',
      enableAutoSessionTracking: true,
      enableGlobalErrorHandlers: true,
    });
    lifecycle._setCrashProcessForTest(proc);
    lifecycle.onModuleInit();
    expect(proc.count('uncaughtException')).toBe(1);
    // Add a host listener AFTER install so the SDK suppresses its out-of-band
    // re-throw (which would otherwise escape the runner); this test asserts the
    // emitted telemetry, not the re-emit (covered by its own test).
    proc.on('uncaughtException', () => {});
    const sessionId = _getActiveSessionTracker()!.current()!.id;

    proc.fire('uncaughtException', new Error('process down'));
    // The error POST + the crashed /sessions/end POST should both fire.
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/ingest/v1/errors')).length).toBe(1),
    );
    const errBody = JSON.parse(fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/ingest/v1/errors'))![1].body);
    expect(errBody.level).toBe('fatal');
    expect(errBody.metadata.mechanism).toBe('uncaughtException');
    expect(errBody.metadata.handled).toBe(false);
    expect(errBody.sessionId).toBe(sessionId);

    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/ingest/v1/sessions/end')).length).toBe(1),
    );
    const endBody = JSON.parse(
      fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/ingest/v1/sessions/end'))![1].body,
    );
    expect(endBody.status).toBe('crashed');

    // Graceful shutdown removes ONLY the handler the lifecycle installed (the
    // host's own dummy listener, added above, must survive).
    expect(proc.count('uncaughtException')).toBe(2); // SDK + host dummy
    lifecycle.onApplicationShutdown();
    expect(proc.count('uncaughtException')).toBe(1); // host dummy remains
  });

  it('enableGlobalErrorHandlers=false opts out — no handlers installed', () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchSpy);
    const proc = makeFakeProcess();
    const lifecycle = createAllStakNestSessionLifecycle({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'noop@1.0.0',
      enableAutoSessionTracking: true,
      enableGlobalErrorHandlers: false,
    });
    lifecycle._setCrashProcessForTest(proc);
    lifecycle.onModuleInit();
    expect(proc.count('uncaughtException')).toBe(0);
    expect(proc.count('unhandledRejection')).toBe(0);
    lifecycle.onApplicationShutdown();
  });
});
