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

export { SDK_NAME, SDK_VERSION } from './version';

/** Injection token used by AllStakModule.forRoot() to provide config. */
export const ALLSTAK_OPTIONS = 'ALLSTAK_OPTIONS';
/** Injection token for the per-module Transport instance. */
export const ALLSTAK_TRANSPORT = 'ALLSTAK_TRANSPORT';

const DEFAULT_HOST = 'https://api.allstak.sa';

export interface AllStakNestConfig {
  apiKey?: string;
  dsn?: string;
  host?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  serviceName?: string;
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
  /** Override fetch (test injection). */
  fetch?: typeof fetch;
}

export interface AllStakOutboundEvent {
  path: '/ingest/v1/http-requests' | '/ingest/v1/errors' | '/ingest/v1/spans';
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

function parseTraceparent(value: string): { traceId?: string; parentSpanId?: string } {
  const parts = value.split('-');
  if (parts.length < 4) return {};
  return {
    traceId: parts[1]?.length === 32 ? parts[1] : undefined,
    parentSpanId: parts[2]?.length === 16 ? parts[2] : undefined,
  };
}

function traceparent(traceId: string, spanId: string): string {
  const t = traceId.length === 32 ? traceId : randomHex(16);
  const s = spanId.length === 16 ? spanId : randomHex(8);
  return `00-${t}-${s}-01`;
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

@Injectable()
export class AllStakNestInterceptor {
  private config: AllStakNestConfig;
  private extraRedact: RegExp[];

  constructor(
    @Optional() @Inject(ALLSTAK_OPTIONS) config?: AllStakNestConfig,
    @Optional() @Inject(ALLSTAK_TRANSPORT) private readonly transport?: AllStakNestTransport,
  ) {
    this.config = config || {};
    this.extraRedact = compileExtra(this.config.redactKeys);
    if (!this.transport) {
      this.transport = new AllStakNestTransport({
        host: normalizeHost(this.config.host || this.config.endpoint),
        apiKey: this.config.apiKey || this.config.dsn || '',
        fetch: this.config.fetch,
      });
    }
  }

  intercept(context: ExecutionContextLike, next: CallHandlerLike): unknown {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const response = context.switchToHttp().getResponse<ResponseLike>();
    const startedAt = Date.now();
    const parsed = parseTraceparent(headerValue(request.headers, 'traceparent'));
    const traceId = headerValue(request.headers, 'x-allstak-trace-id') || parsed.traceId || randomHex(16);
    const requestId = headerValue(request.headers, 'x-allstak-request-id') || headerValue(request.headers, 'x-request-id') || traceId;
    const spanId = randomHex(8);
    request.allstakTraceId = traceId;
    request.allstakRequestId = requestId;
    request.allstakSpanId = spanId;
    request.allstakParentSpanId = headerValue(request.headers, 'x-allstak-parent-span-id') || parsed.parentSpanId;
    setHeader(response, 'traceparent', traceparent(traceId, spanId));
    setHeader(response, 'baggage', mergeBaggage(headerValue(request.headers, 'baggage'), traceId, requestId, spanId));
    setHeader(response, 'allstak-baggage', allstakBaggage(traceId, requestId, spanId));
    setHeader(response, 'x-allstak-trace-id', traceId);
    setHeader(response, 'x-allstak-request-id', requestId);

    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      const durationMs = Math.max(0, Date.now() - startedAt);
      const path = pathOf(request);
      const method = request.method.toUpperCase();
      const statusCode = response.statusCode;
      const headerHost = request.headers.host;
      const userId = request.user?.id == null ? undefined : String(request.user.id);
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
            release: this.config.release || '',
            service: this.config.serviceName || '',
            userId,
            requestHeaders: this.config.captureRequestHeaders
              ? redactHeadersToString(request.headers, this.extraRedact)
              : '',
            metadata: redactMap(
              {
                'sdk.name': SDK_NAME,
                'sdk.version': SDK_VERSION,
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
              release: this.config.release || '',
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

  constructor(
    @Optional() @Inject(ALLSTAK_OPTIONS) config?: AllStakNestConfig,
    @Optional() @Inject(ALLSTAK_TRANSPORT) private readonly transport?: AllStakNestTransport,
  ) {
    this.config = config || {};
    this.extraRedact = compileExtra(this.config.redactKeys);
    if (!this.transport) {
      this.transport = new AllStakNestTransport({
        host: normalizeHost(this.config.host || this.config.endpoint),
        apiKey: this.config.apiKey || this.config.dsn || '',
        fetch: this.config.fetch,
      });
    }
  }

  catch(exception: unknown, context: ExecutionContextLike): never {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const error = exception instanceof Error ? exception : new Error(String(exception));
    const payload: Record<string, unknown> = {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: error.stack ? error.stack.split('\n') : [],
      level: 'error',
      environment: this.config.environment || '',
      release: this.config.release || '',
      traceId: request.allstakTraceId || '',
      spanId: request.allstakSpanId || '',
      parentSpanId: request.allstakParentSpanId || '',
      requestId: request.allstakRequestId || '',
      metadata: redactMap(
        {
          'sdk.name': SDK_NAME,
          'sdk.version': SDK_VERSION,
          service: this.config.serviceName || '',
          httpMethod: request.method,
          httpPath: pathOf(request),
        },
        this.extraRedact,
      ),
    };
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
