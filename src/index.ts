import {
  type DynamicModule,
  type FactoryProvider,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
  type Type,
  Inject,
  Injectable,
  Module,
  Optional,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { SDK_NAME, SDK_VERSION } from './version';
import { compileExtra, isSensitiveKey, redactMap, REDACTED_VALUE, scrubString, scrubValues } from './redaction';
import { AllStakNestTransport } from './transport';
import { resolveRelease, type GitRunner } from './release';
import { SessionTracker } from './session';
import {
  Scope,
  ScopeManager,
  type ScopeUser,
  type ScopeBreadcrumb,
  type Severity,
  type MergedScopeData,
} from './scope';
import {
  TraceContextManager,
  allstakBaggage,
  clamp01,
  formatTraceparent,
  mergeBaggage,
  parseTraceparent,
  randomHex,
} from './tracing';
import {
  installFetchInstrumentation,
  instrumentAxiosInstance,
  type OutboundConfig,
  type OutboundDeps,
} from './outbound';

export { SDK_NAME, SDK_VERSION } from './version';
export { Scope } from './scope';
export type { ScopeUser, ScopeBreadcrumb, Severity, MergedScopeData } from './scope';
export { Session, SessionTracker } from './session';
export type { SessionStatus } from './session';
export { EventSpool } from './persistence';
export type { SpoolOptions, SpooledEnvelope } from './persistence';
export type { OfflineQueueOptions, TransportOptions } from './transport';
export {
  resolveRelease,
  resolveGitRelease,
  detectReleaseFromEnv,
  isNodeRuntime,
  defaultGitRunner,
  RELEASE_ENV_VARS,
  _resetReleaseCache,
  type ResolveReleaseOptions,
} from './release';
export type { GitRunner } from './release';
export { scrubString, scrubValues } from './redaction';
export type { ValueScrubOptions } from './redaction';
export {
  installFetchInstrumentation,
  instrumentAxiosInstance,
} from './outbound';
export type { OutboundConfig, OutboundDeps, OutboundSink } from './outbound';
export { TraceContextManager } from './tracing';
export type { TraceContext } from './tracing';

/** Injection token used by AllStakModule.forRoot() to provide config. */
export const ALLSTAK_OPTIONS = 'ALLSTAK_OPTIONS';
/** Injection token for the per-module Transport instance. */
export const ALLSTAK_TRANSPORT = 'ALLSTAK_TRANSPORT';

const DEFAULT_HOST = 'https://api.allstak.sa';
const runtimeReleaseRegistrations = new Set<string>();

export interface AllStakNestConfig {
  apiKey?: string;
  dsn?: string;
  host?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  serviceName?: string;
  /**
   * Platform identifier attached to the release-health session start payload.
   * Defaults to `node` for this server SDK.
   */
  platform?: string;
  /**
   * User id attached to the release-health session start payload (when known
   * at init). Per-request users are still derived from scope on error events.
   */
  userId?: string;
  /**
   * Open one release-health session per process at module startup
   * (`/ingest/v1/sessions/start`) and close it on graceful shutdown
   * (`/ingest/v1/sessions/end`), tracking ok/errored/crashed locally. Sessions
   * are never sampled. Default true; set false to opt out. Skipped
   * automatically under a unit-test runtime (NODE_ENV=test / VITEST).
   */
  enableAutoSessionTracking?: boolean;
  /**
   * Auto-detect the release when `release` is not set: env vars
   * (ALLSTAK_RELEASE, RAILWAY_GIT_COMMIT_SHA, RENDER_GIT_COMMIT, …), then local
   * git at init (`git describe`/short SHA, Node runtime only, cached one-shot),
   * then the SDK version so release is never empty. Default true. Set false to
   * gate off the git lookup and version fallback (explicit/env still apply).
   */
  autoDetectRelease?: boolean;
  /**
   * Register the resolved release with AllStak from the server runtime at
   * module startup, without requiring a CI/CD hook. Default true.
   */
  autoRegisterRelease?: boolean;
  /** Git runner seam for deterministic tests; defaults to a guarded spawnSync. */
  gitRunner?: GitRunner;
  /** Extra attribute key patterns to redact. Plain substrings or RegExp. */
  redactKeys?: (string | RegExp)[];
  /**
   * Send personally-identifiable information that the SDK would otherwise scrub
   * from free-text values. Default FALSE (matches Sentry's `sendDefaultPii`
   * default and is the privacy-safe choice).
   *
   * - `false` (default): email addresses and IPv4/IPv6 literals found inside
   *   string VALUES (error messages, extras/contexts, breadcrumbs, captured
   *   request fields) are replaced with `[REDACTED]`, and any auto-collected
   *   client IP the SDK attaches is dropped/masked.
   * - `true`: the caller has opted into PII, so those email/IP value scrubbers
   *   are disabled and auto-collected client IP is allowed through.
   *
   * High-risk financial/identity data (credit-card numbers that pass the Luhn
   * checksum, and hyphenated US SSNs) is ALWAYS scrubbed regardless of this
   * flag, and explicit `setUser({ id, email, ... })` identity is ALWAYS sent
   * verbatim regardless of this flag (it is intentional identification).
   */
  sendDefaultPii?: boolean;
  /** If true, include redacted headers in inbound HTTP event. Default false. */
  captureRequestHeaders?: boolean;
  /**
   * Mutate or drop an outbound event right before send. Return `null` to drop.
   * The event passed in has already been redacted; the hook receives the
   * already-safe payload so consumers can add metadata without re-introducing
   * sensitive values.
   */
  beforeSend?: (event: AllStakOutboundEvent) => AllStakOutboundEvent | null | Promise<AllStakOutboundEvent | null>;
  /**
   * Fraction 0..1 of error events captured. Default 1 (keep all). Applied at
   * capture time, BEFORE beforeSend: dropped errors never reach beforeSend.
   * Out-of-range or non-finite values clamp to [0, 1].
   */
  sampleRate?: number;
  /**
   * Fraction 0..1 of traces captured when this service is the trace origin
   * (no inbound sampled flag). Default 1. Drives the propagated W3C
   * `traceparent` sampled flag (`-01` kept / `-00` dropped) and gates whether
   * the request/span events are emitted for that trace. When an inbound
   * `traceparent` carries a sampled flag, the child inherits it and
   * `tracesSampleRate` is not consulted.
   */
  tracesSampleRate?: number;
  /** RNG seam for deterministic tests. Defaults to Math.random. Returns [0,1). */
  random?: () => number;
  /** Override fetch (test injection). */
  fetch?: typeof fetch;
  /**
   * Persist undeliverable telemetry (errors/logs/spans/http/db) to a bounded
   * filesystem spool so buffered events survive a process restart AND a network
   * outage, then replay them on the next init through the normal transport
   * (respecting retry/backoff). Session lifecycle calls are never persisted
   * (live-only). Default true on this server runtime; set false to opt out and
   * keep the existing in-memory drop-on-overflow behaviour. If the spool dir is
   * not writable (read-only FS, serverless, edge runtime with no `fs`) the SDK
   * degrades silently to in-memory — it never throws or blocks init.
   */
  enableOfflineQueue?: boolean;
  /**
   * Directory for the offline spool. Defaults to
   * `<os.tmpdir()>/allstak-nestjs-spool`. Set to point at a durable path (e.g.
   * a writable volume) if tmpdir is wiped on restart.
   */
  offlineQueueDir?: string;
  /**
   * Instrument OUTBOUND HTTP so distributed traces survive the first downstream
   * hop. When enabled (default true) the SDK wraps the global `fetch` to inject
   * W3C `traceparent` + `baggage` continuing the active request trace, and emits
   * a client span + an HttpRequestPayload(direction:'outbound') for each egress
   * call. The SDK's own ingest host is always skipped. Set false to opt out.
   * Skipped automatically under a unit-test runtime unless explicitly enabled.
   */
  enableOutboundHttp?: boolean;
}

export interface AllStakOutboundEvent {
  path: '/ingest/v1/http-requests' | '/ingest/v1/errors' | '/ingest/v1/spans' | '/ingest/v1/releases';
  payload: Record<string, unknown>;
}

export interface AllStakNestAsyncConfig {
  imports?: any[];
  useFactory: (...args: any[]) => Promise<AllStakNestConfig> | AllStakNestConfig;
  inject?: any[];
  useExisting?: Type<unknown>;
}

interface RequestLike {
  method: string;
  url?: string;
  originalUrl?: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: string | number; email?: string };
  allstakTraceId?: string;
  allstakRequestId?: string;
  allstakSpanId?: string;
  allstakParentSpanId?: string;
  allstakSampled?: boolean;
  /** Per-request scope, attached by the interceptor; read by the filter. */
  allstakScope?: Scope;
}

interface ResponseLike {
  statusCode: number;
  on?(event: 'finish' | 'close', cb: () => void): void;
  setHeader?(name: string, value: string): void;
  header?(name: string, value: string): void;
  getHeaders?(): Record<string, string | string[] | number | undefined>;
}

interface ExecutionContextLike {
  switchToHttp(): {
    getRequest<T = RequestLike>(): T;
    getResponse<T = ResponseLike>(): T;
  };
}

interface CallHandlerLike {
  handle(): unknown;
}

function normalizeHost(host?: string): string {
  return (host || DEFAULT_HOST).replace(/\/$/, '');
}

/**
 * Translate the public config into the transport's offline-queue option.
 * `enableOfflineQueue=false` disables persistence entirely; otherwise the spool
 * is enabled (default) with the optional `offlineQueueDir` override. The
 * transport itself degrades to in-memory if the dir is not writable.
 */
function offlineQueueOf(config: AllStakNestConfig): { enabled?: boolean; dir?: string } {
  if (config.enableOfflineQueue === false) return { enabled: false };
  return { enabled: true, dir: config.offlineQueueDir };
}

/**
 * Resolve the effective release for a config: explicit `release` > env vars >
 * local git at init > SDK version. The git lookup is cached one-shot inside
 * resolveRelease, so calling this from both the interceptor and filter is cheap.
 */
function releaseOf(config: AllStakNestConfig): string {
  return resolveRelease({
    explicit: config.release,
    autoDetectRelease: config.autoDetectRelease,
    gitRunner: config.gitRunner,
    version: SDK_VERSION,
  });
}

function registerRuntimeRelease(
  config: AllStakNestConfig,
  transport: AllStakNestTransport,
  release: string,
): void {
  if (!shouldAutoRegisterRelease(config.autoRegisterRelease) || !release) return;
  const host = normalizeHost(config.host || config.endpoint);
  const apiKey = config.apiKey || config.dsn || '';
  if (!apiKey) return;
  const environment = config.environment || 'production';
  const key = `${host}|${apiKey}|${environment}|${release}`;
  if (runtimeReleaseRegistrations.has(key)) return;
  runtimeReleaseRegistrations.add(key);
  void transport.send('/ingest/v1/releases', {
    version: release,
    environment,
    author: `${SDK_NAME}/${SDK_VERSION}`,
    message: 'Registered automatically by AllStak NestJS SDK at runtime',
  });
}

function shouldAutoRegisterRelease(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  try {
    return process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true';
  } catch {
    return true;
  }
}

/** True only on a unit-test runtime (mirrors the release-registration guard). */
function isLikelyTestRuntime(): boolean {
  try {
    return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether release-health session tracking should run. Default true; explicit
 * `false` opts out. Auto-skip under a unit-test runtime so tests don't open
 * sessions against `/ingest/v1/sessions/start` (the createAllStak* test seams
 * pass an explicit flag to exercise the behavior deterministically).
 */
function shouldTrackSessions(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  return !isLikelyTestRuntime();
}

/**
 * Whether outbound HTTP instrumentation should be installed. Default true;
 * explicit `false` opts out. Auto-skip under a unit-test runtime so global-fetch
 * wrapping doesn't bleed across suites; tests opt back in with an explicit flag.
 */
function shouldInstrumentOutbound(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  return !isLikelyTestRuntime();
}

/** Build the OutboundConfig from a resolved config + release + pii decision. */
function outboundConfigOf(config: AllStakNestConfig, release: string, sendDefaultPii: boolean): OutboundConfig {
  return {
    ingestHost: normalizeHost(config.host || config.endpoint),
    serviceName: config.serviceName || '',
    environment: config.environment || '',
    release,
    sendDefaultPii,
  };
}

/**
 * Build the OutboundDeps wiring the instrumentation to the active module's
 * transport/config dispatch pipeline + the active trace context + the module's
 * value-pattern scrubber. Reuses dispatch() so beforeSend + redaction still run.
 */
function outboundDepsOf(
  transport: AllStakNestTransport,
  config: AllStakNestConfig,
  sendDefaultPii: boolean,
): OutboundDeps {
  return {
    traceContext: traceContextManager,
    scrub: (s: string) => String(scrubMessage(s, sendDefaultPii)),
    dispatch: (path, payload) =>
      void dispatch(transport, config, { path: path as AllStakOutboundEvent['path'], payload }),
  };
}

/** Idempotency guard so multiple provider constructions install fetch once. */
let outboundFetchInstalled = false;

/**
 * Install the global-fetch outbound instrumentation once, gated by config.
 * Fail-open. Records nothing on the request object; the wrapper reads the active
 * trace from the ALS the interceptor populates.
 */
function maybeInstallOutboundFetch(
  config: AllStakNestConfig,
  transport: AllStakNestTransport,
  release: string,
  sendDefaultPii: boolean,
): void {
  if (outboundFetchInstalled) return;
  if (!shouldInstrumentOutbound(config.enableOutboundHttp)) return;
  try {
    installFetchInstrumentation(
      outboundConfigOf(config, release, sendDefaultPii),
      outboundDepsOf(transport, config, sendDefaultPii),
    );
    outboundFetchInstalled = true;
  } catch {
    /* instrumentation install must never break module init */
  }
}

/** @internal — exposed for tests; resets the install guard. */
export function _resetOutboundInstallForTest(): void {
  outboundFetchInstalled = false;
}

function pathOf(request: RequestLike): string {
  const raw = request.originalUrl || request.url || '/';
  const i = raw.indexOf('?');
  return i >= 0 ? raw.slice(0, i) : raw;
}

function headerValue(headers: RequestLike['headers'], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function setHeader(response: ResponseLike, name: string, value: string): void {
  response.setHeader?.(name, value);
  response.header?.(name, value);
}

function redactHeadersToString(headers: RequestLike['headers'], extra: RegExp[]): string {
  const keys = Object.keys(headers).sort();
  const out: string[] = [];
  for (const k of keys) {
    const raw = headers[k];
    if (isSensitiveKey(k, extra)) {
      out.push(`${k}: ${REDACTED_VALUE}`);
    } else {
      const v = Array.isArray(raw) ? raw.join(',') : raw ?? '';
      out.push(`${k}: ${v}`);
    }
  }
  return out.join('\n');
}

async function dispatch(
  transport: AllStakNestTransport,
  config: AllStakNestConfig,
  event: AllStakOutboundEvent,
): Promise<void> {
  let outbound: AllStakOutboundEvent | null = event;
  if (config.beforeSend) {
    try {
      const result = await config.beforeSend(event);
      outbound = result ?? null;
    } catch {
      outbound = event; // beforeSend errors must not block ingest
    }
  }
  if (!outbound) return;
  await transport.send(outbound.path, outbound.payload);
}

// ───────────────────────────────────────────────────────────────────────────
// Module-level manual capture + scope API
//
// The transport/config live inside the AllStakModule providers. To let
// application code call captureException / setUser / withScope from anywhere,
// the interceptor + filter register their resolved transport/config at module
// scope on construction. Manual captures route through the SAME transport
// (redaction + beforeSend via dispatch()) and merge the active scope.
// ───────────────────────────────────────────────────────────────────────────

/** Process-wide scope manager (ALS-backed request isolation + global scope). */
const scopeManager = new ScopeManager();

/**
 * Process-wide active-trace context (ALS-backed). The interceptor publishes the
 * current request's trace here; the outbound HTTP instrumentation reads it so an
 * egress span continues the in-flight request trace as a child span.
 */
const traceContextManager = new TraceContextManager();

interface ActiveCaptureContext {
  transport: AllStakNestTransport;
  config: AllStakNestConfig;
  extraRedact: RegExp[];
  /** Release resolved once at registration (explicit > env > git > version). */
  release: string;
  /** Resolved sendDefaultPii at registration (gates email/IP value scrubbing). */
  sendDefaultPii: boolean;
}

let activeContext: ActiveCaptureContext | null = null;

function registerActiveContext(ctx: ActiveCaptureContext): void {
  // Last registered wins; both interceptor and filter call this so a manual
  // capture works whether or not the interceptor is active.
  activeContext = ctx;
}

// ───────────────────────────────────────────────────────────────────────────
// Release-health session lifecycle
//
// A single session is opened per process at module startup and closed on
// graceful shutdown. The lifecycle provider owns the SessionTracker; the
// exception filter / captureException mark it errored/crashed via the
// module-level reference below (mirrors the Java SDK's recordError/recordCrash
// wiring). Sessions are never sampled and the whole path is fail-open.
// ───────────────────────────────────────────────────────────────────────────

let activeSessionTracker: SessionTracker | null = null;

function platformOf(config: AllStakNestConfig): string {
  return config.platform || 'node';
}

/** Mark the active session errored (HANDLED) or crashed (UNHANDLED/fatal). */
function recordSessionForLevel(level: Severity): void {
  const tracker = activeSessionTracker;
  if (!tracker) return;
  try {
    if (level === 'fatal') tracker.recordCrash();
    else if (level === 'error') tracker.recordError();
  } catch {
    /* release-health must never break capture */
  }
}

/** Resolve the current session id (if a session is active), for event payloads. */
function currentSessionId(): string | undefined {
  return activeSessionTracker?.current()?.id;
}

/** @internal — exposed for tests. */
export function _getActiveSessionTracker(): SessionTracker | null {
  return activeSessionTracker;
}
/** @internal — exposed for tests; clears the module-level tracker reference. */
export function _resetSessionTrackerForTest(): void {
  activeSessionTracker = null;
}

/**
 * Whether the caller opted into PII (Sentry `sendDefaultPii`). Default false =
 * privacy-safe parity: the email/IP value scrubbers run and auto-collected IP
 * is dropped. (A)-tier scrubbing (CC/SSN) is always on regardless.
 */
function sendDefaultPiiOf(config: AllStakNestConfig): boolean {
  return config.sendDefaultPii === true;
}

/**
 * Metadata keys carrying EXPLICIT identity set via setUser(). These are
 * intentional identification (Sentry never strips explicitly-set user data), so
 * they are exempt from value-pattern scrubbing — they still ship verbatim even
 * when sendDefaultPii is false. They are NOT exempt from KEY-based redaction.
 */
const VALUE_SCRUB_EXEMPT_KEYS: ReadonlySet<string> = new Set(['userId', 'userEmail']);

/**
 * Value-scrub a metadata bag in place-safe fashion: returns a copy with PII in
 * string VALUES redacted per sendDefaultPii, while exempting explicit-user
 * identity keys. Fail-open: any scrubber error yields the unscrubbed input so an
 * event is never dropped over a value-scan failure.
 */
function scrubMetadata(meta: Record<string, unknown>, sendDefaultPii: boolean): Record<string, unknown> {
  try {
    return scrubValues(meta, { sendDefaultPii, exemptKeys: VALUE_SCRUB_EXEMPT_KEYS });
  } catch {
    return meta;
  }
}

/** Value-scrub a free-text string (e.g. error message). Fail-open. */
function scrubMessage(message: unknown, sendDefaultPii: boolean): unknown {
  if (typeof message !== 'string') return message;
  try {
    return scrubString(message, sendDefaultPii);
  } catch {
    return message;
  }
}

/** Value-scrub breadcrumb message + data, exempting nothing. Fail-open. */
function scrubBreadcrumbs(crumbs: ScopeBreadcrumb[], sendDefaultPii: boolean): ScopeBreadcrumb[] {
  try {
    return crumbs.map((c) => scrubValues(c, { sendDefaultPii }));
  } catch {
    return crumbs;
  }
}

/** Flatten merged scope into a metadata bag (pre-redaction). */
function scopeMetadata(merged: MergedScopeData): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (merged.user?.id != null) meta.userId = String(merged.user.id);
  if (merged.user?.email != null) meta.userEmail = merged.user.email;
  for (const [k, v] of Object.entries(merged.tags)) meta[`tag.${k}`] = v;
  for (const [k, v] of Object.entries(merged.extras)) meta[`extra.${k}`] = v;
  for (const [name, c] of Object.entries(merged.contexts)) meta[`context.${name}`] = c;
  return meta;
}

/**
 * Apply the active merged scope onto an error/http-request payload. Mutates and
 * returns `payload`; metadata is re-run through redaction. Shared by manual
 * captures and the auto-capture interceptor/filter.
 */
function applyScopeToPayload(
  payload: Record<string, unknown>,
  extraRedact: RegExp[],
  merged: MergedScopeData,
  sendDefaultPii: boolean,
): Record<string, unknown> {
  const baseMeta = (payload.metadata as Record<string, unknown> | undefined) ?? {};
  // Key-based redaction first, then value-pattern scrubbing of the surviving
  // string values (explicit-user identity keys exempt so setUser email/id ship).
  const keyRedacted = redactMap({ ...baseMeta, ...scopeMetadata(merged) }, extraRedact) ?? {};
  payload.metadata = scrubMetadata(keyRedacted, sendDefaultPii);
  if (typeof payload.message === 'string') payload.message = scrubMessage(payload.message, sendDefaultPii);
  if (merged.level) payload.level = merged.level;
  if (merged.fingerprint) payload.fingerprint = merged.fingerprint;
  if (merged.breadcrumbs.length) payload.breadcrumbs = scrubBreadcrumbs(merged.breadcrumbs, sendDefaultPii);
  if (merged.user?.id != null && payload.userId === undefined) {
    payload.userId = String(merged.user.id);
  }
  return payload;
}

/**
 * Capture an exception on demand through the active module transport. Honors
 * the same beforeSend + redaction pipeline as auto-capture and merges the
 * current scope. No-op if AllStakModule was never registered.
 */
export function captureException(error: unknown, hint?: { extra?: Record<string, unknown>; level?: Severity }): void {
  const ctx = activeContext;
  if (!ctx) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const level: Severity = hint?.level ?? 'error';
  const payload: Record<string, unknown> = {
    exceptionClass: err.name || 'Error',
    message: err.message,
    stackTrace: err.stack ? err.stack.split('\n') : [],
    level,
    environment: ctx.config.environment || '',
    release: ctx.release,
    sessionId: currentSessionId(),
    metadata: {
      'sdk.name': SDK_NAME,
      'sdk.version': SDK_VERSION,
      service: ctx.config.serviceName || '',
      ...(hint?.extra ?? {}),
    },
  };
  // applyScopeToPayload value-scrubs metadata + message; stackTrace frames are
  // intentionally NOT scrubbed (filenames/functions are not PII).
  applyScopeToPayload(payload, ctx.extraRedact, scopeManager.getMerged(), ctx.sendDefaultPii);
  // Release-health: a manual captureException is a HANDLED error (or a fatal
  // one if the caller marked it). Mirrors the reference SessionTracker model.
  recordSessionForLevel(level);
  void dispatch(ctx.transport, ctx.config, { path: '/ingest/v1/errors', payload });
}

/** Capture a freeform message on demand through the active module transport. */
export function captureMessage(message: string, level: Severity = 'info'): void {
  const ctx = activeContext;
  if (!ctx) return;
  const payload: Record<string, unknown> = {
    exceptionClass: 'Message',
    message,
    stackTrace: [],
    level,
    environment: ctx.config.environment || '',
    release: ctx.release,
    sessionId: currentSessionId(),
    metadata: {
      'sdk.name': SDK_NAME,
      'sdk.version': SDK_VERSION,
      service: ctx.config.serviceName || '',
    },
  };
  applyScopeToPayload(payload, ctx.extraRedact, scopeManager.getMerged(), ctx.sendDefaultPii);
  recordSessionForLevel(level);
  void dispatch(ctx.transport, ctx.config, { path: '/ingest/v1/errors', payload });
}

/** Set the user on the active (request or global) scope. */
export function setUser(user: ScopeUser | null): void {
  scopeManager.getCurrentScope().setUser(user);
}
/** Set a single tag on the active scope. */
export function setTag(key: string, value: string): void {
  scopeManager.getCurrentScope().setTag(key, value);
}
/** Merge tags onto the active scope. */
export function setTags(tags: Record<string, string>): void {
  scopeManager.getCurrentScope().setTags(tags);
}
/** Set a single extra value on the active scope. */
export function setExtra(key: string, value: unknown): void {
  scopeManager.getCurrentScope().setExtra(key, value);
}
/** Merge extras onto the active scope. */
export function setExtras(extras: Record<string, unknown>): void {
  scopeManager.getCurrentScope().setExtras(extras);
}
/** Attach (or remove, with `null`) a named context bag on the active scope. */
export function setContext(name: string, ctx: Record<string, unknown> | null): void {
  scopeManager.getCurrentScope().setContext(name, ctx);
}
/** Add a breadcrumb to the active scope; attached to subsequently captured events. */
export function addBreadcrumb(crumb: ScopeBreadcrumb): void {
  scopeManager.getCurrentScope().addBreadcrumb(crumb);
}
/** Run `callback` with a forked scope that is popped afterwards (sync or async). */
export function withScope<T>(callback: (scope: Scope) => T): T {
  return scopeManager.withScope(callback);
}
/** Mutate the active scope in place. */
export function configureScope(callback: (scope: Scope) => void): void {
  scopeManager.configureScope(callback);
}
/** @internal — exposed for tests; returns the merged active scope view. */
export function _getMergedScope(): MergedScopeData {
  return scopeManager.getMerged();
}

/**
 * Instrument a @nestjs/axios `HttpService` (or any object exposing `axiosRef`,
 * or a raw axios instance) so outbound axios requests inject W3C trace headers
 * and emit an outbound HttpRequestPayload + client span — the axios counterpart
 * to the global-fetch wrapper. @nestjs/axios is an OPTIONAL/peer integration:
 * this SDK never imports it, the host passes its HttpService in.
 *
 * Idempotent per axios instance and fully fail-open. Returns true when the
 * instance was instrumented. No-op (returns false) when AllStakModule was not
 * registered, when `enableOutboundHttp` is disabled, or when the object does not
 * look like an axios instance.
 */
export function instrumentHttpService(httpService: unknown): boolean {
  const ctx = activeContext;
  if (!ctx) return false;
  if (!shouldInstrumentOutbound(ctx.config.enableOutboundHttp)) return false;
  // Accept a NestJS HttpService (`.axiosRef`) or a raw axios instance.
  const axios =
    (httpService as { axiosRef?: unknown } | null | undefined)?.axiosRef ?? httpService;
  try {
    return instrumentAxiosInstance(
      axios as Parameters<typeof instrumentAxiosInstance>[0],
      outboundConfigOf(ctx.config, ctx.release, ctx.sendDefaultPii),
      outboundDepsOf(ctx.transport, ctx.config, ctx.sendDefaultPii),
    );
  } catch {
    return false;
  }
}

/** @internal */
export function _resetRuntimeReleaseRegistrationForTest(): void {
  runtimeReleaseRegistrations.clear();
}

@Injectable()
export class AllStakNestInterceptor {
  private config: AllStakNestConfig;
  private extraRedact: RegExp[];
  private release: string;
  private sendDefaultPii: boolean;

  constructor(
    @Optional() @Inject(ALLSTAK_OPTIONS) config?: AllStakNestConfig,
    @Optional() @Inject(ALLSTAK_TRANSPORT) private readonly transport?: AllStakNestTransport,
  ) {
    this.config = config || {};
    this.extraRedact = compileExtra(this.config.redactKeys);
    this.release = releaseOf(this.config);
    this.sendDefaultPii = sendDefaultPiiOf(this.config);
    if (!this.transport) {
      this.transport = new AllStakNestTransport({
        host: normalizeHost(this.config.host || this.config.endpoint),
        apiKey: this.config.apiKey || this.config.dsn || '',
        fetch: this.config.fetch,
        offlineQueue: offlineQueueOf(this.config),
      });
    }
    registerRuntimeRelease(this.config, this.transport, this.release);
    registerActiveContext({ transport: this.transport, config: this.config, extraRedact: this.extraRedact, release: this.release, sendDefaultPii: this.sendDefaultPii });
    // Outbound HTTP instrumentation: wrap global fetch so egress propagates the
    // trace + emits an outbound HttpRequestPayload. Installed once, fail-open.
    maybeInstallOutboundFetch(this.config, this.transport, this.release, this.sendDefaultPii);
  }

  intercept(context: ExecutionContextLike, next: CallHandlerLike): unknown {
    // Establish a fresh, request-isolated scope for the remainder of this
    // request's async context so user/tags set in a controller (which runs
    // downstream of next.handle() inside this async chain) don't leak across
    // concurrent requests. We ALSO stash the same Scope instance on the request
    // object: the exception filter and the response finalize hook read it from
    // there, which is robust even if Nest invokes them in a sibling async
    // context where ALS propagation would not reach.
    const requestScope = scopeManager.enterRequestScope() ?? undefined;
    const request = context.switchToHttp().getRequest<RequestLike>();
    request.allstakScope = requestScope;
    const response = context.switchToHttp().getResponse<ResponseLike>();
    const startedAt = Date.now();
    const parsed = parseTraceparent(headerValue(request.headers, 'traceparent'));
    const traceId = headerValue(request.headers, 'x-allstak-trace-id') || parsed.traceId || randomHex(16);
    const requestId = headerValue(request.headers, 'x-allstak-request-id') || headerValue(request.headers, 'x-request-id') || traceId;
    const spanId = randomHex(8);
    // Trace sampling: inherit an inbound sampled flag (child follows root);
    // otherwise this service is the trace origin, so decide via tracesSampleRate
    // and drive the propagated traceparent flag accordingly.
    const tracesSampleRate = clamp01(this.config.tracesSampleRate);
    const random = this.config.random || Math.random;
    const sampled = parsed.sampled ?? (tracesSampleRate >= 1 ? true : random() < tracesSampleRate);
    request.allstakTraceId = traceId;
    request.allstakRequestId = requestId;
    request.allstakSpanId = spanId;
    request.allstakSampled = sampled;
    request.allstakParentSpanId = headerValue(request.headers, 'x-allstak-parent-span-id') || parsed.parentSpanId;
    // Publish the active trace into ALS for the rest of this request's async
    // chain so outbound HTTP calls (fetch/axios) become children of this trace.
    // enterWith mirrors the scope ALS hook; no-ops when ALS is unavailable.
    traceContextManager.enterWith({ traceId, spanId, requestId, sampled });
    setHeader(response, 'traceparent', formatTraceparent(traceId, spanId, sampled));
    setHeader(response, 'baggage', mergeBaggage(headerValue(request.headers, 'baggage'), traceId, requestId, spanId));
    setHeader(response, 'allstak-baggage', allstakBaggage(traceId, requestId, spanId));
    setHeader(response, 'x-allstak-trace-id', traceId);
    setHeader(response, 'x-allstak-request-id', requestId);

    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      // Trace-not-sampled: skip request + span emission for this trace. The
      // propagated traceparent already carries the -00 flag so downstream
      // services drop consistently.
      if (!sampled) return;
      const durationMs = Math.max(0, Date.now() - startedAt);
      const path = pathOf(request);
      const method = request.method.toUpperCase();
      const statusCode = response.statusCode;
      const headerHost = request.headers.host;
      const merged = scopeManager.getMergedFor(request.allstakScope);
      const scopeUserId = merged.user?.id == null ? undefined : String(merged.user.id);
      const userId = scopeUserId ?? (request.user?.id == null ? undefined : String(request.user.id));
      const payload: Record<string, unknown> = {
        requests: [
          {
            direction: 'inbound',
            method,
            host: typeof headerHost === 'string' ? headerHost : request.hostname || 'unknown',
            path,
            statusCode,
            durationMs,
            timestamp: new Date(startedAt).toISOString(),
            traceId,
            spanId,
            parentSpanId: request.allstakParentSpanId || '',
            requestId,
            environment: this.config.environment || '',
            release: this.release,
            service: this.config.serviceName || '',
            userId,
            requestHeaders: this.config.captureRequestHeaders
              ? redactHeadersToString(request.headers, this.extraRedact)
              : '',
            metadata: scrubMetadata(
              redactMap(
                {
                  'sdk.name': SDK_NAME,
                  'sdk.version': SDK_VERSION,
                  ...scopeMetadata(merged),
                },
                this.extraRedact,
              ) ?? {},
              this.sendDefaultPii,
            ),
          },
        ],
      };
      void dispatch(this.transport!, this.config, { path: '/ingest/v1/http-requests', payload });
      void dispatch(this.transport!, this.config, {
        path: '/ingest/v1/spans',
        payload: {
          spans: [
            {
              traceId,
              spanId,
              parentSpanId: request.allstakParentSpanId || '',
              operation: 'nestjs.request',
              description: `${method} ${path}`,
              status: statusCode >= 500 ? 'error' : 'ok',
              durationMs,
              startTimeMillis: startedAt,
              endTimeMillis: startedAt + durationMs,
              service: this.config.serviceName || '',
              environment: this.config.environment || '',
              release: this.release,
              tags: {
                component: 'nestjs',
                method,
                statusCode: String(statusCode),
              },
              data: JSON.stringify({
                host: typeof headerHost === 'string' ? headerHost : request.hostname || 'unknown',
                path,
              }),
            },
          ],
        },
      });
    };
    response.on?.('finish', finalize);
    response.on?.('close', finalize);
    return next.handle();
  }
}

@Injectable()
export class AllStakNestExceptionFilter {
  private config: AllStakNestConfig;
  private extraRedact: RegExp[];
  private release: string;
  private sendDefaultPii: boolean;

  constructor(
    @Optional() @Inject(ALLSTAK_OPTIONS) config?: AllStakNestConfig,
    @Optional() @Inject(ALLSTAK_TRANSPORT) private readonly transport?: AllStakNestTransport,
  ) {
    this.config = config || {};
    this.extraRedact = compileExtra(this.config.redactKeys);
    this.release = releaseOf(this.config);
    this.sendDefaultPii = sendDefaultPiiOf(this.config);
    if (!this.transport) {
      this.transport = new AllStakNestTransport({
        host: normalizeHost(this.config.host || this.config.endpoint),
        apiKey: this.config.apiKey || this.config.dsn || '',
        fetch: this.config.fetch,
        offlineQueue: offlineQueueOf(this.config),
      });
    }
    registerRuntimeRelease(this.config, this.transport, this.release);
    registerActiveContext({ transport: this.transport, config: this.config, extraRedact: this.extraRedact, release: this.release, sendDefaultPii: this.sendDefaultPii });
  }

  catch(exception: unknown, context: ExecutionContextLike): never {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const error = exception instanceof Error ? exception : new Error(String(exception));
    // Error sampling: deterministic random drop at capture time, applied
    // BEFORE beforeSend (dispatch). Dropped errors never reach beforeSend.
    const sampleRate = clamp01(this.config.sampleRate);
    const random = this.config.random || Math.random;
    if (sampleRate < 1 && random() >= sampleRate) {
      throw exception; // sampled out — still rethrow so Nest handles the response
    }
    const payload: Record<string, unknown> = {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: error.stack ? error.stack.split('\n') : [],
      level: 'error',
      environment: this.config.environment || '',
      release: this.release,
      sessionId: currentSessionId(),
      traceId: request.allstakTraceId || '',
      spanId: request.allstakSpanId || '',
      parentSpanId: request.allstakParentSpanId || '',
      requestId: request.allstakRequestId || '',
      metadata: {
        'sdk.name': SDK_NAME,
        'sdk.version': SDK_VERSION,
        service: this.config.serviceName || '',
        httpMethod: request.method,
        httpPath: pathOf(request),
      },
    };
    // Merge the active request scope (user/tags/extras/contexts/breadcrumbs)
    // and apply redaction + value-pattern PII scrubbing. Read the scope off the
    // request object (set by the interceptor) so it is correct regardless of
    // async-context propagation.
    applyScopeToPayload(payload, this.extraRedact, scopeManager.getMergedFor(request.allstakScope), this.sendDefaultPii);
    // Release-health: a request that reached the global exception filter is a
    // HANDLED error from the process's perspective (Nest returns a 500 and the
    // process keeps running) ⇒ mark the session errored, not crashed.
    recordSessionForLevel('error');
    void dispatch(this.transport!, this.config, { path: '/ingest/v1/errors', payload });
    throw exception;
  }
}

export function createAllStakNestInterceptor(config: AllStakNestConfig): AllStakNestInterceptor {
  return new AllStakNestInterceptor(config);
}

export function createAllStakNestExceptionFilter(config: AllStakNestConfig): AllStakNestExceptionFilter {
  return new AllStakNestExceptionFilter(config);
}

/**
 * Owns the per-process release-health session. Opens it on module init
 * (`/ingest/v1/sessions/start`) and closes it on graceful shutdown
 * (`/ingest/v1/sessions/end`). Registered as a Nest provider by
 * AllStakModule.forRoot(); shutdown firing requires `app.enableShutdownHooks()`
 * in the host app. Fully fail-open: nothing here throws into init/shutdown.
 */
@Injectable()
export class AllStakSessionLifecycle implements OnModuleInit, OnApplicationShutdown {
  private config: AllStakNestConfig;
  private release: string;
  private tracker: SessionTracker | null = null;

  constructor(
    @Optional() @Inject(ALLSTAK_OPTIONS) config?: AllStakNestConfig,
    @Optional() @Inject(ALLSTAK_TRANSPORT) private readonly transport?: AllStakNestTransport,
  ) {
    this.config = config || {};
    this.release = releaseOf(this.config);
    if (!this.transport) {
      this.transport = new AllStakNestTransport({
        host: normalizeHost(this.config.host || this.config.endpoint),
        apiKey: this.config.apiKey || this.config.dsn || '',
        fetch: this.config.fetch,
        offlineQueue: offlineQueueOf(this.config),
      });
    }
  }

  onModuleInit(): void {
    try {
      if (!shouldTrackSessions(this.config.enableAutoSessionTracking)) return;
      this.tracker = new SessionTracker(
        {
          // Release falls back to the SDK version upstream (resolveRelease),
          // so a non-empty release is the norm; an empty release keeps the
          // in-memory tracker but skips the network call.
          release: this.release,
          environment: this.config.environment,
          userId: this.config.userId,
          sdkName: SDK_NAME,
          sdkVersion: SDK_VERSION,
          platform: platformOf(this.config),
        },
        this.transport!,
      );
      activeSessionTracker = this.tracker;
      this.tracker.start();
    } catch {
      /* session tracking must never block module init */
    }
  }

  onApplicationShutdown(): void {
    try {
      this.tracker?.end();
    } catch {
      /* best-effort, must not throw on shutdown */
    } finally {
      if (activeSessionTracker === this.tracker) activeSessionTracker = null;
    }
  }
}

/**
 * Build a standalone session lifecycle for tests / manual wiring. The returned
 * instance is NOT auto-started; call `onModuleInit()` to start and
 * `onApplicationShutdown()` to end (mirroring Nest's lifecycle invocation).
 */
export function createAllStakNestSessionLifecycle(config: AllStakNestConfig): AllStakSessionLifecycle {
  return new AllStakSessionLifecycle(config);
}

function transportProvider(): FactoryProvider {
  return {
    provide: ALLSTAK_TRANSPORT,
    inject: [ALLSTAK_OPTIONS],
    useFactory: (cfg: AllStakNestConfig) =>
      new AllStakNestTransport({
        host: normalizeHost(cfg.host || cfg.endpoint),
        apiKey: cfg.apiKey || cfg.dsn || '',
        fetch: cfg.fetch,
        offlineQueue: offlineQueueOf(cfg),
      }),
  };
}

@Module({})
export class AllStakModule {
  /** Synchronous root registration. */
  static forRoot(options: AllStakNestConfig): DynamicModule {
    const providers: Provider[] = [
      { provide: ALLSTAK_OPTIONS, useValue: options },
      transportProvider(),
      { provide: APP_INTERCEPTOR, useClass: AllStakNestInterceptor },
      { provide: APP_FILTER, useClass: AllStakNestExceptionFilter },
      AllStakSessionLifecycle,
    ];
    return {
      module: AllStakModule,
      global: true,
      providers,
      exports: [ALLSTAK_OPTIONS, ALLSTAK_TRANSPORT],
    };
  }

  /**
   * Async root registration — lets consumers compose the AllStak config from a
   * NestJS ConfigService or any other async source.
   *
   * ```ts
   * AllStakModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => ({
   *     apiKey: cfg.get('ALLSTAK_API_KEY'),
   *     environment: cfg.get('NODE_ENV') ?? 'production',
   *   }),
   * })
   * ```
   */
  static forRootAsync(options: AllStakNestAsyncConfig): DynamicModule {
    const optionsProvider: FactoryProvider = {
      provide: ALLSTAK_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject || [],
    };
    return {
      module: AllStakModule,
      global: true,
      imports: options.imports || [],
      providers: [
        optionsProvider,
        transportProvider(),
        { provide: APP_INTERCEPTOR, useClass: AllStakNestInterceptor },
        { provide: APP_FILTER, useClass: AllStakNestExceptionFilter },
        AllStakSessionLifecycle,
      ],
      exports: [ALLSTAK_OPTIONS, ALLSTAK_TRANSPORT],
    };
  }
}

export { AllStakNestTransport };
