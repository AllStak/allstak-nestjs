/**
 * Process-level fatal-error handlers for @allstak/nestjs.
 *
 * The interceptor/filter only see errors that flow through the NestJS request
 * pipeline. A truly UNHANDLED error — one thrown off the request path (a timer,
 * an event-emitter callback, a forgotten `await`) — escapes to Node's
 * `process` and would otherwise terminate the process with NOTHING captured and
 * the release-health session left dangling as `ok`.
 *
 * This module installs `process.on('uncaughtException')` +
 * `process.on('unhandledRejection')` (config-gated, default on) so such a
 * failure is:
 *
 *   1. captured at `fatal` level to `/ingest/v1/errors` (through the SAME
 *      capture pipeline — redaction, beforeSend, scope, sessionId);
 *   2. recorded against the active release-health session as `crashed`
 *      (terminal), so `/sessions/end` reports the crash; and
 *   3. flushed best-effort (bounded) so the POSTs have a chance to land before
 *      the process exits.
 *
 * It then PRESERVES Node's existing semantics: for `uncaughtException`, if the
 * SDK is the ONLY listener it re-emits so Node's default crash-and-exit still
 * applies; if the host registered its own listener the SDK does not force an
 * exit (the host owns that decision). `unhandledRejection` is captured without
 * changing the process's rejection mode.
 *
 * Everything here is fail-open: an install/capture/flush failure must never
 * escape into the host's startup path or alter the original crash beyond the
 * intended re-emit.
 */

/** Minimal slice of Node's `process` we depend on (no `@types/node` here). */
export interface CrashProcess {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  listeners?(event: string): unknown[];
  listenerCount?(event: string): number;
  emit?(event: string, ...args: any[]): boolean;
}

/** Hooks the handlers use; wired in src/index.ts to the active module pipeline. */
export interface CrashDeps {
  /**
   * Capture the fatal error at `fatal` level through the active capture
   * pipeline (redaction + beforeSend + scope + sessionId). Marks the
   * release-health session `crashed` as a side effect (the level is `fatal`).
   */
  captureFatal: (error: unknown, source: 'uncaughtException' | 'unhandledRejection') => void;
  /** End the active release-health session as `crashed`, posting `/sessions/end`. */
  endSessionCrashed: () => void;
  /** Best-effort, bounded flush of in-flight telemetry before the process exits. */
  flush: () => Promise<void>;
}

/** Marker so repeated installs (multi-module) attach the handlers only once. */
const CRASH_MARKER = Symbol.for('allstak.nestjs.crash.installed');

interface MarkedProcess extends CrashProcess {
  [CRASH_MARKER]?: { uncaught: (...a: any[]) => void; unhandled: (...a: any[]) => void };
}

/**
 * Resolve the global `process` object without a static `node:process` import
 * (keeps the no-`@types/node` build happy and degrades to a no-op off Node).
 */
function resolveProcess(): CrashProcess | null {
  const proc = (globalThis as { process?: unknown }).process as CrashProcess | undefined;
  if (!proc || typeof proc.on !== 'function') return null;
  return proc;
}

/** Count `uncaughtException` listeners excluding our own, fail-soft to 0. */
function otherUncaughtListenerCount(proc: MarkedProcess, ours: (...a: any[]) => void): number {
  try {
    if (typeof proc.listeners === 'function') {
      return proc.listeners('uncaughtException').filter((l) => l !== ours).length;
    }
    if (typeof proc.listenerCount === 'function') {
      // No way to exclude ours by reference here — subtract one for ourselves.
      return Math.max(0, proc.listenerCount('uncaughtException') - 1);
    }
  } catch {
    /* fall through */
  }
  return 0;
}

/**
 * Install the global fatal-error handlers (idempotent across calls). Returns an
 * uninstall function (used by tests) that removes exactly the listeners we
 * added and clears the marker. No-op (returns a no-op uninstaller) off Node.
 *
 * `processOverride` lets tests inject a fake process; production passes nothing.
 */
export function installGlobalErrorHandlers(
  deps: CrashDeps,
  processOverride?: CrashProcess,
): () => void {
  const candidate = (processOverride ?? resolveProcess()) as MarkedProcess | null;
  // Validate the override too: a non-Node / unusable process is a safe no-op.
  const proc = candidate && typeof candidate.on === 'function' ? candidate : null;
  if (!proc) return () => {};
  if (proc[CRASH_MARKER]) return () => {}; // already installed on this process

  const finalize = async (error: unknown, source: 'uncaughtException' | 'unhandledRejection') => {
    try {
      deps.captureFatal(error, source);
    } catch {
      /* capture must never throw out of a crash handler */
    }
    try {
      deps.endSessionCrashed();
    } catch {
      /* release-health end is best-effort */
    }
    try {
      await deps.flush();
    } catch {
      /* flush is best-effort */
    }
  };

  const onUncaught = (error: unknown): void => {
    // Capture + flush, then PRESERVE Node semantics. If the SDK is the only
    // listener, re-throw on the next tick so Node's default crash-and-exit
    // applies (after our async flush has had a chance to drain). If the host
    // has its own listener, we don't force an exit — the host owns that.
    void finalize(error, 'uncaughtException').then(() => {
      try {
        if (otherUncaughtListenerCount(proc, onUncaught) === 0) {
          // No other listener: restore Node's default behaviour by re-throwing
          // out of band so the runtime terminates as it would have.
          setTimeout(() => {
            throw error;
          }, 0);
        }
      } catch {
        /* re-emit is best-effort; never mask the original error */
      }
    });
  };

  const onUnhandled = (reason: unknown): void => {
    // Capture the rejection at fatal level + mark crashed + flush. We do NOT
    // change the process's rejection mode (Node's default --unhandled-rejections
    // behaviour, host overrides, and any other listener all still apply).
    void finalize(reason, 'unhandledRejection');
  };

  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onUnhandled);
  proc[CRASH_MARKER] = { uncaught: onUncaught, unhandled: onUnhandled };

  return () => {
    const remove =
      (proc.off as MarkedProcess['off']) ?? (proc.removeListener as MarkedProcess['removeListener']);
    try {
      remove?.call(proc, 'uncaughtException', onUncaught);
      remove?.call(proc, 'unhandledRejection', onUnhandled);
    } catch {
      /* uninstall is best-effort */
    }
    delete proc[CRASH_MARKER];
  };
}
