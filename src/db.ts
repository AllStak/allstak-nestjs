/**
 * ORM auto-instrumentation for @allstak/nestjs — `/ingest/v1/db` telemetry.
 *
 * Mirrors the existing outbound-HTTP integration pattern (see src/outbound.ts):
 * the SDK never imports Prisma or TypeORM (both are optional/peer integrations
 * the host owns). Instead the host passes its client / data-source to a one-line
 * registration call, exactly like `instrumentHttpService()`:
 *
 *   - `instrumentPrisma(client)`  — wraps the client with a Prisma client
 *     extension (`$extends({ query })`) that times every model/raw operation and
 *     emits a normalized `/ingest/v1/db` row. Returns the EXTENDED client (Prisma
 *     `$extends` is immutable), so callers assign it back:
 *       `prisma = instrumentPrisma(prisma)`.
 *   - `instrumentDataSource(ds)` — attaches a TypeORM `Logger` adapter to a
 *     DataSource so every executed query (and query error) is captured. Mutates
 *     the data-source's logger in place and returns true when wired.
 *
 * Each captured query carries the ACTIVE trace/span ids (read from the same
 * AsyncLocalStorage the request interceptor populates) so a DB call made while
 * handling a request becomes a child of that request's trace. SQL is normalized
 * (literals → `?`) BEFORE it leaves the process, so no parameter values are ever
 * transmitted; the free-text `errorMessage` is value-scrubbed per `sendDefaultPii`.
 *
 * Everything here is fail-open: an instrumentation/emit error never breaks the
 * caller's query, and a sampled-out / disabled trace emits no telemetry.
 */
import { SDK_NAME, SDK_VERSION } from './version';
import type { TraceContext, TraceContextManager } from './tracing';

/** Dispatch through the module's beforeSend + redaction pipeline. */
export type DbDispatch = (path: '/ingest/v1/db', payload: Record<string, unknown>) => void;

export interface DbConfig {
  serviceName: string;
  environment: string;
  release: string;
  /** Resolved sendDefaultPii — gates value-pattern scrubbing of the error text. */
  sendDefaultPii: boolean;
}

/** Hooks the instrumentation uses (reused from index, like OutboundDeps). */
export interface DbDeps {
  traceContext: TraceContextManager;
  /** Value-scrub a free-text string per sendDefaultPii (reuses the module scrubber). */
  scrub: (s: string) => string;
  dispatch: DbDispatch;
}

const MAX_QUERY_CHARS = 2048;
const MAX_ERROR_CHARS = 500;

// ───────────────────────────────────────────────────────────────────────────
// SQL normalisation (mirrors the wire contract used by the other SDKs)
// ───────────────────────────────────────────────────────────────────────────

/** Replace literal values with `?` placeholders and collapse whitespace. */
export function normalizeQuery(sql: string): string {
  let out = String(sql);
  // Single-quoted string literals (escaped quotes handled by the greedy class).
  out = out.replace(/'(?:[^']|'')*'/g, '?');
  // Double-quoted string literals (some engines use these for strings).
  out = out.replace(/"(?:[^"]|"")*"/g, '?');
  // Numeric literals.
  out = out.replace(/\b\d+(\.\d+)?\b/g, '?');
  // Collapse runs of whitespace.
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_QUERY_CHARS) out = out.slice(0, MAX_QUERY_CHARS);
  return out;
}

/** Short stable hash of a normalized query (FNV-1a, 16 lowercase hex chars). */
export function hashQuery(normalized: string): string {
  // 64-bit FNV-1a via BigInt — deterministic, dependency-free.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < normalized.length; i++) {
    h ^= BigInt(normalized.charCodeAt(i) & 0xff);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** Detect SELECT / INSERT / UPDATE / DELETE, else OTHER. */
export function detectQueryType(sql: string): string {
  const first = sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
  return first === 'SELECT' || first === 'INSERT' || first === 'UPDATE' || first === 'DELETE'
    ? first
    : 'OTHER';
}

/** A single captured DB query (pre-wire; ids filled from the active trace). */
export interface DbQueryInfo {
  /** Raw SQL — normalized inside emitDbQuery before it leaves the process. */
  query: string;
  durationMs: number;
  status?: 'success' | 'error';
  errorMessage?: string;
  databaseName?: string;
  databaseType?: string;
  /** Override query type; otherwise detected from the normalized SQL. */
  queryType?: string;
  rowsAffected?: number;
  /** Defaults to Date.now() at emit time. */
  timestampMillis?: number;
}

/** Derive correlation ids from the active request trace (if any). */
function correlationOf(active: TraceContext | undefined): { traceId: string; spanId: string } {
  if (active) return { traceId: active.traceId, spanId: active.spanId };
  return { traceId: '', spanId: '' };
}

/**
 * Build a `/ingest/v1/db` row from a captured query and dispatch it. Only emits
 * when the active trace is sampled (an off-trace / sampled-out request still
 * runs queries but contributes no telemetry). Fully fail-open.
 */
export function emitDbQuery(cfg: DbConfig, deps: DbDeps, info: DbQueryInfo): void {
  try {
    const active = deps.traceContext.getActive();
    // Sampled-out request trace: skip emission (matches the outbound HTTP rule).
    if (active && active.sampled === false) return;
    const { traceId, spanId } = correlationOf(active);
    const normalizedQuery = normalizeQuery(info.query);
    const status = info.status ?? 'success';
    const rawError = info.errorMessage ? String(info.errorMessage).slice(0, MAX_ERROR_CHARS) : '';
    deps.dispatch('/ingest/v1/db', {
      queries: [
        {
          normalizedQuery,
          queryHash: hashQuery(normalizedQuery),
          queryType: info.queryType ?? detectQueryType(normalizedQuery),
          durationMs: Math.max(0, Math.round(info.durationMs)),
          timestampMillis: info.timestampMillis ?? Date.now(),
          status,
          errorMessage: rawError ? deps.scrub(rawError) : '',
          databaseName: info.databaseName ?? '',
          databaseType: info.databaseType ?? '',
          service: cfg.serviceName,
          environment: cfg.environment,
          traceId,
          spanId,
          rowsAffected: typeof info.rowsAffected === 'number' ? info.rowsAffected : -1,
          metadata: {
            'sdk.name': SDK_NAME,
            'sdk.version': SDK_VERSION,
            release: cfg.release,
          },
        },
      ],
    });
  } catch {
    /* telemetry emission must never break the caller's query */
  }
}

// ───────────────────────────────────────────────────────────────────────────
// (a) Prisma client extension
// ───────────────────────────────────────────────────────────────────────────

/** Minimal shape of the Prisma client we touch — avoids a hard Prisma dep. */
interface PrismaLike {
  $extends?: (ext: unknown) => unknown;
}

/** Marker so a client we already extended is not re-extended (returns as-is). */
const PRISMA_MARKER = '__allstakDbInstrumented';

/**
 * Wrap a Prisma client with a query-timing extension that emits `/ingest/v1/db`.
 * Prisma's `$extends` returns a NEW client (the original is immutable), so the
 * caller must use the returned value:
 *
 * ```ts
 * prisma = instrumentPrisma(prisma);
 * ```
 *
 * Idempotent (a client carrying our marker is returned unchanged) and fail-open:
 * if `$extends` is missing or throws, the ORIGINAL client is returned so the host
 * keeps a working client no matter what.
 *
 * `databaseType` defaults to `'prisma'` and can be overridden by the caller.
 */
export function instrumentPrisma<T>(client: T, cfg: DbConfig, deps: DbDeps, databaseType = 'prisma'): T {
  const c = client as (PrismaLike & { [PRISMA_MARKER]?: true }) | null | undefined;
  if (!c || typeof c !== 'object') return client;
  if (c[PRISMA_MARKER]) return client; // already instrumented
  if (typeof c.$extends !== 'function') return client; // not a Prisma client

  try {
    const extended = c.$extends({
      name: 'allstak-db',
      query: {
        // `$allOperations` covers model operations, $queryRaw, $executeRaw, etc.
        $allOperations: async ({ model, operation, args, query }: any) => {
          const start = Date.now();
          try {
            const result = await query(args);
            emitDbQuery(cfg, deps, {
              query: prismaQueryText(model, operation, args),
              durationMs: Date.now() - start,
              status: 'success',
              databaseType,
              rowsAffected: rowsAffectedOf(result),
            });
            return result;
          } catch (err) {
            emitDbQuery(cfg, deps, {
              query: prismaQueryText(model, operation, args),
              durationMs: Date.now() - start,
              status: 'error',
              errorMessage: errorMessageOf(err),
              databaseType,
            });
            throw err; // never swallow the caller's DB error
          }
        },
      },
    }) as T & { [PRISMA_MARKER]?: true };
    try {
      (extended as { [PRISMA_MARKER]?: true })[PRISMA_MARKER] = true;
    } catch {
      /* read-only proxy — marker is best-effort, idempotency still works via the source */
    }
    // Also mark the SOURCE so a second call on the original is a no-op.
    try {
      c[PRISMA_MARKER] = true;
    } catch {
      /* best-effort */
    }
    return extended;
  } catch {
    return client; // extension build failed — hand back a working client
  }
}

/**
 * Build a normalizable query string for a Prisma operation. Raw operations
 * carry real SQL in `args`; model operations don't expose SQL, so synthesize a
 * stable `model.operation` descriptor (no parameter VALUES are included).
 */
function prismaQueryText(model: string | undefined, operation: string, args: unknown): string {
  // Raw SQL operations: prefer the actual statement so normalization applies.
  if (operation === '$queryRaw' || operation === '$executeRaw' || operation === '$queryRawUnsafe' || operation === '$executeRawUnsafe') {
    const sql = rawSqlOf(args);
    if (sql) return sql;
  }
  return model ? `${model}.${operation}` : operation;
}

/** Extract the SQL text from a Prisma raw-operation args payload, if present. */
function rawSqlOf(args: unknown): string {
  if (typeof args === 'string') return args;
  if (Array.isArray(args) && typeof args[0] === 'string') return args[0];
  // Tagged-template form: { strings: TemplateStringsArray, values: [...] }.
  const tpl = args as { strings?: unknown; sql?: unknown; text?: unknown } | null | undefined;
  if (tpl && Array.isArray(tpl.strings)) return (tpl.strings as string[]).join(' ? ');
  if (tpl && typeof tpl.sql === 'string') return tpl.sql;
  if (tpl && typeof tpl.text === 'string') return tpl.text;
  return '';
}

/** Best-effort rows-affected from a Prisma result (e.g. `{ count }` or arrays). */
function rowsAffectedOf(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object') {
    const count = (result as { count?: unknown }).count;
    if (typeof count === 'number') return count;
  }
  return -1;
}

// ───────────────────────────────────────────────────────────────────────────
// (b) TypeORM DataSource logger adapter
// ───────────────────────────────────────────────────────────────────────────

/** Minimal shape of a TypeORM DataSource we touch — avoids a hard TypeORM dep. */
interface DataSourceLike {
  options?: { type?: unknown; database?: unknown; logger?: unknown; logging?: unknown };
  setOptions?: (options: Record<string, unknown>) => unknown;
  logger?: unknown;
  driver?: { options?: { type?: unknown; database?: unknown } };
}

/** The subset of TypeORM's `Logger` interface we implement. */
interface TypeOrmLogger {
  logQuery(query: string, parameters?: unknown[], queryRunner?: unknown): void;
  logQueryError(error: string | Error, query: string, parameters?: unknown[], queryRunner?: unknown): void;
  logQuerySlow(time: number, query: string, parameters?: unknown[], queryRunner?: unknown): void;
  logSchemaBuild(message: string, queryRunner?: unknown): void;
  logMigration(message: string, queryRunner?: unknown): void;
  log(level: 'log' | 'info' | 'warn', message: unknown, queryRunner?: unknown): void;
}

/** Marker so a data-source we already wired is not re-wired. */
const TYPEORM_MARKER = '__allstakDbInstrumented';

/**
 * Build a TypeORM `Logger` that captures every executed query as `/ingest/v1/db`
 * telemetry, delegating other log methods to an optional `previous` logger so
 * the host's existing logging keeps working. Exported for direct use with
 * TypeORM's `logger` data-source option.
 */
export function createTypeOrmLogger(
  cfg: DbConfig,
  deps: DbDeps,
  meta: { databaseName: string; databaseType: string },
  previous?: Partial<TypeOrmLogger>,
): TypeOrmLogger {
  const delegate = <K extends keyof TypeOrmLogger>(name: K, ...a: any[]): void => {
    const fn = previous?.[name] as ((...args: any[]) => void) | undefined;
    if (typeof fn === 'function') {
      try {
        fn.apply(previous, a);
      } catch {
        /* host logger must not break capture */
      }
    }
  };
  return {
    logQuery(query, parameters, queryRunner) {
      emitDbQuery(cfg, deps, {
        query,
        durationMs: 0, // TypeORM's success path does not expose timing here.
        status: 'success',
        databaseName: meta.databaseName,
        databaseType: meta.databaseType,
      });
      delegate('logQuery', query, parameters, queryRunner);
    },
    logQueryError(error, query, parameters, queryRunner) {
      emitDbQuery(cfg, deps, {
        query,
        durationMs: 0,
        status: 'error',
        errorMessage: errorMessageOf(error),
        databaseName: meta.databaseName,
        databaseType: meta.databaseType,
      });
      delegate('logQueryError', error, query, parameters, queryRunner);
    },
    logQuerySlow(time, query, parameters, queryRunner) {
      // The slow-query path DOES carry timing — capture it with the real duration.
      emitDbQuery(cfg, deps, {
        query,
        durationMs: time,
        status: 'success',
        databaseName: meta.databaseName,
        databaseType: meta.databaseType,
      });
      delegate('logQuerySlow', time, query, parameters, queryRunner);
    },
    logSchemaBuild(message, queryRunner) {
      delegate('logSchemaBuild', message, queryRunner);
    },
    logMigration(message, queryRunner) {
      delegate('logMigration', message, queryRunner);
    },
    log(level, message, queryRunner) {
      delegate('log', level, message, queryRunner);
    },
  };
}

/**
 * Attach the AllStak query logger to a TypeORM DataSource so every executed
 * query emits `/ingest/v1/db`. Mutates the data-source's options/logger in place
 * (preserving any existing logger as a delegate) and returns true when wired.
 * Idempotent per data-source and fail-open. To capture EVERY query the host's
 * `logging` should include `'query'` (and `'error'`); this helper enables that
 * on the running data-source's options when possible without clobbering an
 * explicit boolean/array the host already set.
 */
export function instrumentDataSource(dataSource: unknown, cfg: DbConfig, deps: DbDeps): boolean {
  const ds = dataSource as (DataSourceLike & { [TYPEORM_MARKER]?: true }) | null | undefined;
  if (!ds || typeof ds !== 'object') return false;
  if (ds[TYPEORM_MARKER]) return false; // already instrumented

  try {
    const databaseType = String(ds.options?.type ?? ds.driver?.options?.type ?? 'typeorm');
    const databaseName = String(ds.options?.database ?? ds.driver?.options?.database ?? '');
    const previous = (ds.options?.logger && typeof ds.options.logger === 'object'
      ? (ds.options.logger as Partial<TypeOrmLogger>)
      : undefined);
    const logger = createTypeOrmLogger(cfg, deps, { databaseName, databaseType }, previous);

    // Ensure query/error logging actually fires. Only enable when the host has
    // not explicitly opted out (false / specific array) — never downgrade an
    // 'all' setting, never override an explicit selective list.
    const desiredLogging = normalizeLogging(ds.options?.logging);

    if (typeof ds.setOptions === 'function') {
      ds.setOptions({ logger, ...(desiredLogging !== undefined ? { logging: desiredLogging } : {}) });
    } else if (ds.options) {
      // Older TypeORM without setOptions: mutate the options object directly.
      (ds.options as Record<string, unknown>).logger = logger;
      if (desiredLogging !== undefined) (ds.options as Record<string, unknown>).logging = desiredLogging;
    } else {
      // No options bag — attach the logger reference where TypeORM reads it.
      (ds as Record<string, unknown>).logger = logger;
    }
    try {
      ds[TYPEORM_MARKER] = true;
    } catch {
      /* best-effort */
    }
    return true;
  } catch {
    return false; // wiring failed — leave the data-source untouched
  }
}

/**
 * Decide the `logging` value to set so query + error logs fire, without
 * clobbering the host's intent:
 *   - host left it unset / false → enable ['query', 'error'].
 *   - host set `true` ('all') → leave it ('all' already includes query+error).
 *   - host set a selective array → leave it (respect the explicit choice).
 * Returns `undefined` when no change should be made.
 */
function normalizeLogging(logging: unknown): unknown {
  if (logging === true || logging === 'all') return undefined; // already covers query+error
  if (Array.isArray(logging)) return undefined; // explicit selective list — respect it
  if (typeof logging === 'string') return undefined; // single explicit level — respect it
  // unset / false / undefined → turn on query+error so capture actually fires.
  return ['query', 'error'];
}

// ───────────────────────────────────────────────────────────────────────────
// shared helpers
// ───────────────────────────────────────────────────────────────────────────

/** Coerce an unknown thrown value into a short message string. */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}
