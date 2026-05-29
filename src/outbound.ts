/**
 * Outbound HTTP instrumentation for @allstak/nestjs.
 *
 * Without this, the SDK only observes INBOUND requests and emits correlation
 * headers on the inbound RESPONSE — distributed traces break at the first
 * downstream hop because egress carries no `traceparent`/`baggage`. This module
 * adds:
 *
 *   (a) a global `fetch` wrapper that, for every outbound call, injects W3C
 *       `traceparent` + `baggage` continuing the active request trace, times the
 *       call, and emits a client span + an HttpRequestPayload(direction:
 *       'outbound') through the SAME transport/redaction pipeline; and
 *   (b) an OPTIONAL @nestjs/axios HttpService integration that does the same on
 *       axios requests (only wired when @nestjs/axios is actually present — it is
 *       a peer/optional dependency and is NOT hard-required).
 *
 * Egress to the SDK's own ingest host is skipped so telemetry POSTs are not
 * themselves instrumented (which would recurse / self-pollute the trace).
 *
 * Everything here is fail-open: an instrumentation error never breaks the
 * caller's request, and a sampled-out / disabled trace still propagates headers
 * but emits no telemetry.
 */
import { SDK_NAME, SDK_VERSION } from './version';
import {
  allstakBaggage,
  formatTraceparent,
  mergeBaggage,
  randomHex,
  type TraceContext,
  type TraceContextManager,
} from './tracing';

/** The slice of transport this module needs (decoupled for testing). */
export interface OutboundSink {
  send(path: string, payload: unknown): Promise<void>;
}

/** Dispatch through the module's beforeSend + redaction pipeline. */
export type OutboundDispatch = (path: string, payload: Record<string, unknown>) => void;

export interface OutboundConfig {
  /** Normalized SDK ingest host (no trailing slash) — egress here is skipped. */
  ingestHost: string;
  serviceName: string;
  environment: string;
  release: string;
  /** Resolved sendDefaultPii — gates value-pattern scrubbing of the URL string. */
  sendDefaultPii: boolean;
}

/** Hooks the wrapper uses to read the active trace + scrub strings (reused from index). */
export interface OutboundDeps {
  traceContext: TraceContextManager;
  /** Value-scrub a free-text string per sendDefaultPii (reuses the module's scrubber). */
  scrub: (s: string) => string;
  dispatch: OutboundDispatch;
}

const OUTBOUND_OP = 'http.client';

/** Lowercase host (no port) of a URL string; '' when unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Path (no query) of a URL string; the raw url when unparseable. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    const i = url.indexOf('?');
    return i >= 0 ? url.slice(0, i) : url;
  }
}

/**
 * True when `url` targets the SDK's own ingest host. Telemetry egress must not
 * be instrumented (it would create a feedback loop and pollute traces).
 */
function isIngestUrl(url: string, ingestHost: string): boolean {
  const target = hostOf(url);
  if (!target) return false;
  return target === hostOf(ingestHost);
}

/**
 * Derive the child egress context from the active request trace. When a request
 * trace is active the egress span is a child of the request span and inherits
 * the trace id + sampled flag; otherwise this call starts its own root trace
 * (still propagates headers so the downstream service is linked to *something*).
 */
function deriveEgress(active: TraceContext | undefined): {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  requestId: string;
  sampled: boolean;
} {
  const spanId = randomHex(8);
  if (active) {
    return {
      traceId: active.traceId,
      spanId,
      parentSpanId: active.spanId,
      requestId: active.requestId,
      sampled: active.sampled,
    };
  }
  const traceId = randomHex(16);
  return { traceId, spanId, parentSpanId: '', requestId: traceId, sampled: true };
}

/**
 * Merge the propagation headers (traceparent + baggage) into an existing header
 * bag WITHOUT clobbering caller-supplied non-allstak baggage. Returns a new
 * plain object of string→string headers; never mutates the input.
 */
function withPropagationHeaders(
  existing: Record<string, string>,
  eg: { traceId: string; spanId: string; requestId: string; sampled: boolean },
): Record<string, string> {
  const out: Record<string, string> = { ...existing };
  // Find an existing baggage header case-insensitively to preserve vendor entries.
  let baggageKey = 'baggage';
  let baggageVal = '';
  for (const [k, v] of Object.entries(existing)) {
    if (k.toLowerCase() === 'baggage') {
      baggageKey = k;
      baggageVal = v ?? '';
      delete out[k];
    }
  }
  out.traceparent = formatTraceparent(eg.traceId, eg.spanId, eg.sampled);
  out[baggageKey] = mergeBaggage(baggageVal, eg.traceId, eg.requestId, eg.spanId);
  out['allstak-baggage'] = allstakBaggage(eg.traceId, eg.requestId, eg.spanId);
  return out;
}

/** Flatten an arbitrary HeadersInit / record into a plain string→string object. */
function headersToRecord(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  try {
    // fetch Headers instance.
    if (typeof (input as { forEach?: unknown }).forEach === 'function' && !Array.isArray(input)) {
      (input as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => {
        out[k] = v;
      });
      return out;
    }
    if (Array.isArray(input)) {
      for (const pair of input as [string, string][]) {
        if (pair && pair.length >= 2) out[pair[0]] = pair[1];
      }
      return out;
    }
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v != null) out[k] = String(v);
    }
  } catch {
    /* fail-open: empty header bag */
  }
  return out;
}

/** Build the outbound HttpRequestPayload row + matching client span and dispatch both. */
function emitOutbound(
  cfg: OutboundConfig,
  deps: OutboundDeps,
  eg: { traceId: string; spanId: string; parentSpanId: string; requestId: string },
  info: { method: string; url: string; status: number; durationMs: number; startedAt: number; errored: boolean },
): void {
  // Sampled-out / disabled traces propagate headers but emit no telemetry.
  const host = hostOf(info.url) || 'unknown';
  const path = deps.scrub(pathOf(info.url));
  const method = info.method.toUpperCase();
  const status = info.errored ? 0 : info.status;
  const spanStatus = info.errored || status >= 500 ? 'error' : 'ok';
  deps.dispatch('/ingest/v1/http-requests', {
    requests: [
      {
        direction: 'outbound',
        method,
        host,
        path,
        statusCode: status,
        durationMs: info.durationMs,
        timestamp: new Date(info.startedAt).toISOString(),
        traceId: eg.traceId,
        spanId: eg.spanId,
        parentSpanId: eg.parentSpanId,
        requestId: eg.requestId,
        environment: cfg.environment,
        release: cfg.release,
        service: cfg.serviceName,
        requestHeaders: '',
        metadata: {
          'sdk.name': SDK_NAME,
          'sdk.version': SDK_VERSION,
        },
      },
    ],
  });
  deps.dispatch('/ingest/v1/spans', {
    spans: [
      {
        traceId: eg.traceId,
        spanId: eg.spanId,
        parentSpanId: eg.parentSpanId,
        operation: OUTBOUND_OP,
        description: `${method} ${host}${path}`,
        status: spanStatus,
        durationMs: info.durationMs,
        startTimeMillis: info.startedAt,
        endTimeMillis: info.startedAt + info.durationMs,
        service: cfg.serviceName,
        environment: cfg.environment,
        release: cfg.release,
        tags: {
          component: 'http.client',
          method,
          statusCode: String(status),
        },
        data: JSON.stringify({ host, path }),
      },
    ],
  });
}

// ───────────────────────────────────────────────────────────────────────────
// (a) global fetch wrapper
// ───────────────────────────────────────────────────────────────────────────

/** Marker so we never double-wrap fetch (idempotent install across modules). */
const FETCH_MARKER = Symbol.for('allstak.nestjs.fetch.instrumented');

interface InstrumentedFetch {
  (input: any, init?: any): Promise<any>;
  [FETCH_MARKER]?: true;
}

/**
 * Install (idempotently) a global `fetch` wrapper that propagates trace headers
 * on egress and emits outbound telemetry. Returns an uninstall function (used by
 * tests). The original fetch is captured and restored on uninstall. No-op (and
 * returns a no-op uninstaller) when there is no global fetch to wrap.
 */
export function installFetchInstrumentation(cfg: OutboundConfig, deps: OutboundDeps): () => void {
  const g = globalThis as { fetch?: InstrumentedFetch };
  const original = g.fetch;
  if (typeof original !== 'function') return () => {};
  if (original[FETCH_MARKER]) return () => {}; // already wrapped

  const wrapped: InstrumentedFetch = async function (input: any, init?: any): Promise<any> {
    const url = requestUrlOf(input);
    // Skip our own ingest egress entirely — pass through untouched.
    if (!url || isIngestUrl(url, cfg.ingestHost)) {
      return original(input, init);
    }
    let eg: ReturnType<typeof deriveEgress>;
    let nextInput = input;
    let nextInit = init;
    try {
      eg = deriveEgress(deps.traceContext.getActive());
      ({ input: nextInput, init: nextInit } = injectFetchHeaders(input, init, eg));
    } catch {
      // Instrumentation setup failed — never break the caller's request.
      return original(input, init);
    }
    const method = methodOf(input, init);
    const startedAt = Date.now();
    try {
      const res = await original(nextInput, nextInit);
      const status = typeof res?.status === 'number' ? res.status : 200;
      safeEmit(eg, () =>
        emitOutbound(cfg, deps, eg, {
          method,
          url,
          status,
          durationMs: Math.max(0, Date.now() - startedAt),
          startedAt,
          errored: false,
        }),
      );
      return res;
    } catch (err) {
      safeEmit(eg, () =>
        emitOutbound(cfg, deps, eg, {
          method,
          url,
          status: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
          startedAt,
          errored: true,
        }),
      );
      throw err; // re-throw so the caller sees the real network error
    }
  };
  wrapped[FETCH_MARKER] = true;
  g.fetch = wrapped;
  return () => {
    if (g.fetch === wrapped) g.fetch = original;
  };
}

/** Run an emit only when the egress trace is sampled; swallow emit errors. */
function safeEmit(eg: { sampled: boolean }, fn: () => void): void {
  if (!eg.sampled) return;
  try {
    fn();
  } catch {
    /* telemetry emission must never break the caller */
  }
}

/** Resolve the absolute-or-relative URL string from a fetch input. */
function requestUrlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof (input as { url?: unknown }).url === 'string') return (input as { url: string }).url;
  try {
    return String(input);
  } catch {
    return '';
  }
}

/** Resolve the method for a fetch call (init wins over a Request input). */
function methodOf(input: unknown, init: unknown): string {
  const fromInit = (init as { method?: string } | undefined)?.method;
  if (fromInit) return fromInit;
  const fromReq = (input as { method?: string } | undefined)?.method;
  return fromReq || 'GET';
}

/**
 * Return a fetch (input, init) pair with propagation headers injected. We always
 * route the headers through `init` so we never need to clone an immutable
 * Request; a plain-string/URL input is left as-is.
 */
function injectFetchHeaders(
  input: any,
  init: any,
  eg: { traceId: string; spanId: string; requestId: string; sampled: boolean },
): { input: any; init: any } {
  // Merge headers from BOTH a Request input and the init (init wins on conflict).
  const fromInput = input && typeof input === 'object' ? headersToRecord(input.headers) : {};
  const fromInit = init ? headersToRecord(init.headers) : {};
  const merged = withPropagationHeaders({ ...fromInput, ...fromInit }, eg);
  return { input, init: { ...(init ?? {}), headers: merged } };
}

// ───────────────────────────────────────────────────────────────────────────
// (b) optional @nestjs/axios HttpService integration
// ───────────────────────────────────────────────────────────────────────────

/** Minimal shape of an axios instance we touch — avoids a hard axios dep. */
interface AxiosLike {
  interceptors?: {
    request?: { use(onFulfilled: (cfg: any) => any): unknown };
    response?: { use(onFulfilled: (res: any) => any, onRejected?: (err: any) => any): unknown };
  };
  defaults?: { baseURL?: string };
}

/** Marker key on an axios instance so we never attach our interceptors twice. */
const AXIOS_MARKER = '__allstakInstrumented';

/**
 * Attach request/response interceptors to an axios instance (typically obtained
 * from @nestjs/axios `HttpService.axiosRef`). Idempotent per instance and
 * fail-open. Returns true if interceptors were attached.
 *
 * This is intentionally decoupled from @nestjs/axios: callers pass the raw axios
 * instance, so this file imports neither axios nor @nestjs/axios.
 */
export function instrumentAxiosInstance(axios: AxiosLike, cfg: OutboundConfig, deps: OutboundDeps): boolean {
  if (!axios || typeof axios !== 'object') return false;
  const marked = axios as AxiosLike & { [AXIOS_MARKER]?: true };
  if (marked[AXIOS_MARKER]) return false;
  const reqUse = axios.interceptors?.request?.use;
  const resUse = axios.interceptors?.response?.use;
  if (typeof reqUse !== 'function' || typeof resUse !== 'function') return false;

  axios.interceptors!.request!.use((reqConfig: any) => {
    try {
      const url = axiosUrlOf(reqConfig, axios.defaults?.baseURL);
      if (!url || isIngestUrl(url, cfg.ingestHost)) return reqConfig;
      const eg = deriveEgress(deps.traceContext.getActive());
      reqConfig.headers = withPropagationHeaders(headersToRecord(reqConfig.headers), eg);
      // Stash egress context + start time for the response interceptor.
      reqConfig.__allstak = { eg, startedAt: Date.now(), url };
    } catch {
      /* never block the outbound request over instrumentation */
    }
    return reqConfig;
  });

  axios.interceptors!.response!.use(
    (res: any) => {
      try {
        emitFromAxios(cfg, deps, res?.config, typeof res?.status === 'number' ? res.status : 200, false);
      } catch {
        /* fail-open */
      }
      return res;
    },
    (err: any) => {
      try {
        const status = typeof err?.response?.status === 'number' ? err.response.status : 0;
        emitFromAxios(cfg, deps, err?.config, status, status === 0);
      } catch {
        /* fail-open */
      }
      return Promise.reject(err);
    },
  );

  marked[AXIOS_MARKER] = true;
  return true;
}

/** Emit outbound telemetry from a completed axios request using its stashed context. */
function emitFromAxios(
  cfg: OutboundConfig,
  deps: OutboundDeps,
  reqConfig: any,
  status: number,
  errored: boolean,
): void {
  const stashed = reqConfig?.__allstak as
    | { eg: ReturnType<typeof deriveEgress>; startedAt: number; url: string }
    | undefined;
  if (!stashed) return;
  const method = (reqConfig?.method || 'GET').toUpperCase();
  safeEmit(stashed.eg, () =>
    emitOutbound(cfg, deps, stashed.eg, {
      method,
      url: stashed.url,
      status,
      durationMs: Math.max(0, Date.now() - stashed.startedAt),
      startedAt: stashed.startedAt,
      errored,
    }),
  );
}

/** Resolve a full URL from an axios request config (respecting baseURL). */
function axiosUrlOf(reqConfig: any, baseURL?: string): string {
  const url = reqConfig?.url;
  if (typeof url !== 'string' || url.length === 0) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = reqConfig?.baseURL || baseURL;
  if (typeof base === 'string' && base) {
    return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
  }
  return url;
}
