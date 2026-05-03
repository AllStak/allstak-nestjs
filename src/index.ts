const DEFAULT_HOST = 'https://api.allstak.sa';

export interface AllStakNestConfig {
  apiKey: string;
  host?: string;
  environment?: string;
  release?: string;
  serviceName?: string;
}

interface RequestLike {
  method: string;
  url?: string;
  originalUrl?: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: string | number; email?: string };
}

interface ResponseLike {
  statusCode: number;
  on?(event: 'finish' | 'close', cb: () => void): void;
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
  const index = raw.indexOf('?');
  return index >= 0 ? raw.slice(0, index) : raw;
}

async function send(config: AllStakNestConfig, path: string, payload: unknown): Promise<void> {
  await fetch(`${normalizeHost(config.host)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AllStak-Key': config.apiKey,
    },
    body: JSON.stringify(payload),
  });
}

export class AllStakNestInterceptor {
  constructor(private config: AllStakNestConfig) {}

  intercept(context: ExecutionContextLike, next: CallHandlerLike): unknown {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const response = context.switchToHttp().getResponse<ResponseLike>();
    const startedAt = Date.now();
    const finalize = (): void => {
      const headerHost = request.headers.host;
      const userId = request.user?.id == null ? undefined : String(request.user.id);
      void send(this.config, '/ingest/v1/http-requests', {
        requests: [{
          direction: 'inbound',
          method: request.method.toUpperCase(),
          host: typeof headerHost === 'string' ? headerHost : request.hostname || 'unknown',
          path: pathOf(request),
          statusCode: response.statusCode,
          durationMs: Math.max(0, Date.now() - startedAt),
          timestamp: new Date(startedAt).toISOString(),
          environment: this.config.environment || '',
          release: this.config.release || '',
          service: this.config.serviceName || '',
          userId,
        }],
      }).catch(() => undefined);
    };
    response.on?.('finish', finalize);
    response.on?.('close', finalize);
    return next.handle();
  }
}

export class AllStakNestExceptionFilter {
  constructor(private config: AllStakNestConfig) {}

  catch(exception: unknown, context: ExecutionContextLike): never {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const error = exception instanceof Error ? exception : new Error(String(exception));
    void send(this.config, '/ingest/v1/errors', {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: error.stack ? error.stack.split('\n') : [],
      level: 'error',
      environment: this.config.environment || '',
      release: this.config.release || '',
      metadata: {
        sdkName: '@allstak/nestjs',
        service: this.config.serviceName || '',
        httpMethod: request.method,
        httpPath: pathOf(request),
      },
    }).catch(() => undefined);
    throw exception;
  }
}

export function createAllStakNestInterceptor(config: AllStakNestConfig): AllStakNestInterceptor {
  return new AllStakNestInterceptor(config);
}

export function createAllStakNestExceptionFilter(config: AllStakNestConfig): AllStakNestExceptionFilter {
  return new AllStakNestExceptionFilter(config);
}
