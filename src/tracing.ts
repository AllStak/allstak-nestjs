/**
 * W3C trace-context helpers + active-trace AsyncLocalStorage for @allstak/nestjs.
 *
 * The inbound interceptor already parses an incoming `traceparent`/`baggage` and
 * emits correlation headers on the RESPONSE. This module factors the wire-format
 * helpers out of `index.ts` (no behaviour change) so the OUTBOUND HTTP
 * instrumentation can reuse the exact same traceparent/baggage encoding, and
 * adds a small AsyncLocalStorage that carries the *current request's* trace
 * context so an outbound call made while handling a request becomes a child span
 * of that request's trace.
 */

/** Active trace context for the current async scope (a request being handled). */
export interface TraceContext {
  traceId: string;
  /** The span id of the *enclosing* operation (the inbound request span). */
  spanId: string;
  requestId: string;
  /** W3C sampled flag for this trace — propagated unchanged onto egress. */
  sampled: boolean;
}

export interface ParsedTraceparent {
  traceId?: string;
  parentSpanId?: string;
  sampled?: boolean;
}

/** Cryptographically-random lowercase hex string of `bytes` bytes. */
export function randomHex(bytes: number): string {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const data = new Uint8Array(bytes);
    c.getRandomValues(data);
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

/** Parse a W3C `traceparent` (`00-<32hex>-<16hex>-<2hex>`). Fail-soft. */
export function parseTraceparent(value: string): ParsedTraceparent {
  const parts = value.split('-');
  if (parts.length < 4) return {};
  const flags = parts[3];
  // trace-flags is a 2-hex-digit field; bit 0 is the "sampled" flag.
  const sampled = /^[0-9a-fA-F]{2}$/.test(flags ?? '')
    ? (parseInt(flags, 16) & 0x01) === 0x01
    : undefined;
  return {
    traceId: parts[1]?.length === 32 ? parts[1] : undefined,
    parentSpanId: parts[2]?.length === 16 ? parts[2] : undefined,
    sampled,
  };
}

/** Build a W3C `traceparent` header value, generating ids when malformed. */
export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  const t = traceId.length === 32 ? traceId : randomHex(16);
  const s = spanId.length === 16 ? spanId : randomHex(8);
  return `00-${t}-${s}-${sampled ? '01' : '00'}`;
}

/** AllStak vendor baggage entries (trace/request/span correlation). */
export function allstakBaggage(traceId: string, requestId: string, spanId: string): string {
  return [
    `allstak-trace_id=${traceId}`,
    `allstak-request_id=${requestId}`,
    `allstak-span_id=${spanId}`,
  ].join(',');
}

/** Merge AllStak baggage into an existing `baggage` value, preserving non-allstak entries. */
export function mergeBaggage(existing: string, traceId: string, requestId: string, spanId: string): string {
  const preserved = existing
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.toLowerCase().startsWith('allstak-'));
  return [...preserved, ...allstakBaggage(traceId, requestId, spanId).split(',')].join(',');
}

/** Clamp a sample-rate to [0,1]; non-finite/undefined → 1 (keep all). */
export function clamp01(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// Active-trace AsyncLocalStorage
//
// The interceptor publishes the request's TraceContext here for the duration of
// the request's async chain (via `enterWith`, matching the scope ALS pattern).
// The outbound fetch/axios instrumentation reads it so egress spans continue the
// in-flight trace. Falls back to "no active trace" without ALS — outbound calls
// then start their own root trace, which is still correct, just not linked.
// ───────────────────────────────────────────────────────────────────────────

interface AsyncTraceStorage {
  getStore(): TraceContext | undefined;
  run<T>(store: TraceContext, callback: () => T): T;
  enterWith?(store: TraceContext): void;
}

type AsyncLocalStorageCtor = new <T>() => AsyncTraceStorage;

declare const module: unknown;

/**
 * Resolve Node's AsyncLocalStorage without a static `import 'node:async_hooks'`
 * (mirrors src/scope.ts so these no-`@types/node` packages still build and run
 * under node>=18). Tries the modern builtin accessor, then an indirect require.
 */
function loadAsyncLocalStorage(): AsyncLocalStorageCtor | null {
  const proc = (globalThis as {
    process?: {
      versions?: { node?: string };
      getBuiltinModule?: (id: string) => { AsyncLocalStorage?: AsyncLocalStorageCtor };
    };
  }).process;
  if (!proc?.versions?.node) return null;
  try {
    const fromBuiltin = proc.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage;
    if (fromBuiltin) return fromBuiltin;
  } catch {
    /* fall through */
  }
  try {
    const req =
      (globalThis as { require?: (id: string) => { AsyncLocalStorage?: AsyncLocalStorageCtor } }).require ??
      (typeof module !== 'undefined' &&
        (module as { require?: (id: string) => { AsyncLocalStorage?: AsyncLocalStorageCtor } }).require);
    const mod = req ? req('node:async_hooks') : undefined;
    return mod?.AsyncLocalStorage ?? null;
  } catch {
    return null;
  }
}

function createAsyncTraceStorage(): AsyncTraceStorage | null {
  const Ctor = loadAsyncLocalStorage();
  if (!Ctor) return null;
  try {
    return new Ctor<TraceContext>();
  } catch {
    return null;
  }
}

/** Carries the active request's TraceContext through the async chain. */
export class TraceContextManager {
  private readonly als: AsyncTraceStorage | null = createAsyncTraceStorage();

  /** The trace context active in the current async scope, if any. */
  getActive(): TraceContext | undefined {
    return this.als?.getStore();
  }

  /**
   * Publish `ctx` for the remainder of the current async context (used by the
   * interceptor's `enterWith`-style hook). No-ops without ALS.
   */
  enterWith(ctx: TraceContext): void {
    if (this.als?.enterWith) this.als.enterWith(ctx);
  }

  /** Run `callback` with `ctx` active (used by tests / explicit wrapping). */
  run<T>(ctx: TraceContext, callback: () => T): T {
    if (this.als) return this.als.run(ctx, callback);
    return callback();
  }
}
