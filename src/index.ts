import {
  type DynamicModule,
  type FactoryProvider,
  type Provider,
  type Type,
  Inject,
  Injectable,
  Module,
  Optional,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { SDK_NAME, SDK_VERSION } from './version';
import { compileExtra, isSensitiveKey, redactMap, REDACTED_VALUE } from './redaction';
import { AllStakNestTransport } from './transport';
import { resolveRelease, type GitRunner } from './release';
import {
  Scope,
  ScopeManager,
  type ScopeUser,
  type ScopeBreadcrumb,
  type Severity,
  type MergedScopeData,
} from './scope';

export { SDK_NAME, SDK_VERSION } from './version';
export { Scope } from './scope';
export type { ScopeUser, ScopeBreadcrumb, Severity, MergedScopeData } from './scope';
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

function pathOf(request: RequestLike): string {
  const raw = request.originalUrl || request.url || '/';
  const i = raw.indexOf('?');
  return i >= 0 ? raw.slice(0, i) : raw;
}

function headerValue(headers: RequestLike['headers'], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function randomHex(bytes: number): string {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const data = new Uint8Array(bytes);
    c.getRandomValues(data);
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

function parseTraceparent(value: string): {
  traceId?: string;
  parentSpanId?: string;
  sampled?: boolean;
} {
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

function traceparent(traceId: string, spanId: string, sampled: boolean): string {
  const t = traceId.length === 32 ? traceId : randomHex(16);
  const s = spanId.length === 16 ? spanId : randomHex(8);
  return `00-${t}-${s}-${sampled ? '01' : '00'}`;
}

function clamp01(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function allstakBaggage(traceId: string, requestId: string, spanId: string): string {
  return [
    `allstak-trace_id=${traceId}`,
    `allstak-request_id=${requestId}`,
    `allstak-span_id=${spanId}`,
  ].join(',');
}

function mergeBaggage(existing: string, traceId: string, requestId: string, spanId: string): string {
  const preserved = existing
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.toLowerCase().startsWith('allstak-'));
  return [...preserved, ...allstakBaggage(traceId, requestId, spanId).split(',')].join(',');
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

interface ActiveCaptureContext {
  transport: AllStakNestTransport;
  config: AllStakNestConfig;
  extraRedact: RegExp[];
  /** Release resolved once at registration (explicit > env > git > version). */
  release: string;
}

let activeContext: ActiveCaptureContext | null = null;

function registerActiveContext(ctx: ActiveCaptureContext): void {
  // Last registered wins; both interceptor and filter call this so a manual
  // capture works whether or not the interceptor is active.
  activeContext = ctx;
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
): Record<string, unknown> {
  const baseMeta = (payload.metadata as Record<string, unknown> | undefined) ?? {};
  payload.metadata = redactMap({ ...baseMeta, ...scopeMetadata(merged) }, extraRedact);
  if (merged.level) payload.level = merged.level;
  if (merged.fingerprint) payload.fingerprint = merged.fingerprint;
  if (merged.breadcrumbs.length) payload.breadcrumbs = merged.breadcrumbs;
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
  const payload: Record<string, unknown> = {
    exceptionClass: err.name || 'Error',
    message: err.message,
    stackTrace: err.stack ? err.stack.split('\n') : [],
    level: hint?.level ?? 'error',
    environment: ctx.config.environment || '',
    release: ctx.release,
    metadata: {
      'sdk.name': SDK_NAME,
      'sdk.version': SDK_VERSION,
      service: ctx.config.serviceName || '',
      ...(hint?.extra ?? {}),
    },
  };
  applyScopeToPayload(payload, ctx.extraRedact, scopeManager.getMerged());
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
    metadata: {
      'sdk.name': SDK_NAME,
      'sdk.version': SDK_VERSION,
      service: ctx.config.serviceName || '',
    },
  };
  applyScopeToPayload(payload, ctx.extraRedact, scopeManager.getMerged());
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

/** @internal */
export function _resetRuntimeReleaseRegistrationForTest(): void {
  runtimeReleaseRegistrations.clear();
}

@Injectable()
export class AllStakNestInterceptor {
  private config: AllStakNestConfig;
  private extraRedact: RegExp[];
  private release: string;

  constructor(
    @Optional() @Inject(ALLSTAK_OPTIONS) config?: AllStakNestConfig,
    @Optional() @Inject(ALLSTAK_TRANSPORT) private readonly transport?: AllStakNestTransport,
  ) {
    this.config = config || {};
    this.extraRedact = compileExtra(this.config.redactKeys);
    this.release = releaseOf(this.config);
    if (!this.transport) {
      this.transport = new AllStakNestTransport({
        host: normalizeHost(this.config.host || this.config.endpoint),
        apiKey: this.config.apiKey || this.config.dsn || '',
        fetch: this.config.fetch,
      });
    }
    registerRuntimeRelease(this.config, this.transport, this.release);
    registerActiveContext({ transport: this.transport, config: this.config, extraRedact: this.extraRedact, release: this.release });
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
    setHeader(response, 'traceparent', traceparent(traceId, spanId, sampled));
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
            metadata: redactMap(
              {
                'sdk.name': SDK_NAME,
                'sdk.version': SDK_VERSION,
                ...scopeMetadata(merged),
              },
              this.extraRedact,
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

  constructor(
    @Optional() @Inject(ALLSTAK_OPTIONS) config?: AllStakNestConfig,
    @Optional() @Inject(ALLSTAK_TRANSPORT) private readonly transport?: AllStakNestTransport,
  ) {
    this.config = config || {};
    this.extraRedact = compileExtra(this.config.redactKeys);
    this.release = releaseOf(this.config);
    if (!this.transport) {
      this.transport = new AllStakNestTransport({
        host: normalizeHost(this.config.host || this.config.endpoint),
        apiKey: this.config.apiKey || this.config.dsn || '',
        fetch: this.config.fetch,
      });
    }
    registerRuntimeRelease(this.config, this.transport, this.release);
    registerActiveContext({ transport: this.transport, config: this.config, extraRedact: this.extraRedact, release: this.release });
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
    // and apply redaction. Read the scope off the request object (set by the
    // interceptor) so it is correct regardless of async-context propagation.
    applyScopeToPayload(payload, this.extraRedact, scopeManager.getMergedFor(request.allstakScope));
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

function transportProvider(): FactoryProvider {
  return {
    provide: ALLSTAK_TRANSPORT,
    inject: [ALLSTAK_OPTIONS],
    useFactory: (cfg: AllStakNestConfig) =>
      new AllStakNestTransport({
        host: normalizeHost(cfg.host || cfg.endpoint),
        apiKey: cfg.apiKey || cfg.dsn || '',
        fetch: cfg.fetch,
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
      ],
      exports: [ALLSTAK_OPTIONS, ALLSTAK_TRANSPORT],
    };
  }
}

export { AllStakNestTransport };
