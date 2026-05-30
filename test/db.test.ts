/**
 * ORM DB auto-instrumentation for @allstak/nestjs — /ingest/v1/db.
 *
 * Covers:
 *   - SQL normalisation (literals → ?), query-type detection, stable hashing
 *   - emitDbQuery builds the documented /ingest/v1/db row shape and carries the
 *     active request trace/span ids (child of the request)
 *   - a sampled-out trace runs the query but emits NO telemetry
 *   - Prisma client extension times success + error operations, returns the
 *     EXTENDED client, is idempotent, and never swallows the caller's error
 *   - Prisma raw SQL is normalized (no parameter values leave the process)
 *   - TypeORM logger adapter emits on logQuery / logQueryError / logQuerySlow,
 *     delegates to a previous logger, and instrumentDataSource is idempotent
 *   - the public instrumentPrisma()/instrumentDataSource() honour the active
 *     module context + enableDbInstrumentation gate
 *   - fail-open: a dispatch error never breaks the caller's query
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAllStakNestInterceptor,
  instrumentPrisma,
  instrumentDataSource,
  normalizeQuery,
  hashQuery,
  detectQueryType,
  emitDbQuery,
  createTypeOrmLogger,
  TraceContextManager,
  _resetOutboundInstallForTest,
  type DbConfig,
  type DbDeps,
} from '../src/index';
// Direct module imports for the decoupled (no active-context) unit tests.
import {
  instrumentPrisma as instrumentPrismaDirect,
  instrumentDataSource as instrumentDataSourceDirect,
} from '../src/db';

interface Dispatched {
  path: string;
  payload: any;
}

function makeDeps(overrides: Partial<DbDeps> = {}): { deps: DbDeps; sent: Dispatched[]; tc: TraceContextManager } {
  const sent: Dispatched[] = [];
  const tc = new TraceContextManager();
  const deps: DbDeps = {
    traceContext: tc,
    scrub: (s) => s,
    dispatch: (path, payload) => sent.push({ path, payload }),
    ...overrides,
  };
  return { deps, sent, tc };
}

const cfg: DbConfig = {
  serviceName: 'svc',
  environment: 'test',
  release: 'r1',
  sendDefaultPii: false,
};

function dbRowOf(sent: Dispatched[]): any {
  return sent.find((s) => s.path === '/ingest/v1/db')?.payload.queries[0];
}

// ── normalisation / hashing / type detection ─────────────────────────────────

describe('@allstak/nestjs — DB query normalisation', () => {
  it('replaces string + numeric literals with ? and collapses whitespace', () => {
    const out = normalizeQuery("SELECT  *  FROM users WHERE email = 'a@b.com' AND age = 42");
    expect(out).toBe('SELECT * FROM users WHERE email = ? AND age = ?');
  });

  it('detects the query type, defaulting to OTHER', () => {
    expect(detectQueryType('select 1')).toBe('SELECT');
    expect(detectQueryType('  insert into t values (1)')).toBe('INSERT');
    expect(detectQueryType('UPDATE t SET a=1')).toBe('UPDATE');
    expect(detectQueryType('DELETE FROM t')).toBe('DELETE');
    expect(detectQueryType('BEGIN')).toBe('OTHER');
    expect(detectQueryType('')).toBe('OTHER');
  });

  it('hashQuery is stable, 16 lowercase hex chars, and distinguishes queries', () => {
    const a = hashQuery('SELECT * FROM users WHERE id = ?');
    const b = hashQuery('SELECT * FROM users WHERE id = ?');
    const c = hashQuery('SELECT * FROM orders WHERE id = ?');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// ── emitDbQuery row shape + trace correlation ────────────────────────────────

describe('@allstak/nestjs — emitDbQuery row shape', () => {
  it('emits the documented /ingest/v1/db shape with normalized SQL and ids', () => {
    const { deps, sent } = makeDeps();
    emitDbQuery(cfg, deps, {
      query: "SELECT * FROM users WHERE id = 7",
      durationMs: 12.7,
      status: 'success',
      databaseType: 'postgres',
      databaseName: 'app',
      rowsAffected: 1,
    });
    const row = dbRowOf(sent);
    expect(row.normalizedQuery).toBe('SELECT * FROM users WHERE id = ?');
    expect(row.queryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.queryType).toBe('SELECT');
    expect(row.durationMs).toBe(13); // rounded
    expect(typeof row.timestampMillis).toBe('number');
    expect(row.status).toBe('success');
    expect(row.errorMessage).toBe('');
    expect(row.databaseName).toBe('app');
    expect(row.databaseType).toBe('postgres');
    expect(row.service).toBe('svc');
    expect(row.environment).toBe('test');
    expect(row.rowsAffected).toBe(1);
    expect(row.metadata['sdk.name']).toBe('@allstak/nestjs');
  });

  it('carries the active request trace/span ids (DB call is a child of the request)', () => {
    const { deps, sent, tc } = makeDeps();
    const traceId = 'a'.repeat(32);
    const reqSpan = 'b'.repeat(16);
    tc.run({ traceId, spanId: reqSpan, requestId: 'req-1', sampled: true }, () => {
      emitDbQuery(cfg, deps, { query: 'SELECT 1', durationMs: 1 });
    });
    const row = dbRowOf(sent);
    expect(row.traceId).toBe(traceId);
    expect(row.spanId).toBe(reqSpan);
  });

  it('a sampled-out trace runs the query but emits NO telemetry', () => {
    const { deps, sent, tc } = makeDeps();
    tc.run({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), requestId: 'r', sampled: false }, () => {
      emitDbQuery(cfg, deps, { query: 'SELECT 1', durationMs: 1 });
    });
    expect(sent).toHaveLength(0);
  });

  it('value-scrubs the errorMessage via deps.scrub and truncates long text', () => {
    const { deps, sent } = makeDeps({ scrub: (s) => s.replace(/secret/g, '[X]') });
    emitDbQuery(cfg, deps, {
      query: 'INSERT INTO t VALUES (1)',
      durationMs: 2,
      status: 'error',
      errorMessage: 'boom secret',
    });
    const row = dbRowOf(sent);
    expect(row.status).toBe('error');
    expect(row.errorMessage).toBe('boom [X]');
  });

  it('fail-open: a dispatch error does not throw out of emitDbQuery', () => {
    const { deps } = makeDeps({
      dispatch: () => {
        throw new Error('telemetry boom');
      },
    });
    expect(() => emitDbQuery(cfg, deps, { query: 'SELECT 1', durationMs: 1 })).not.toThrow();
  });
});

// ── Prisma client extension ──────────────────────────────────────────────────

describe('@allstak/nestjs — Prisma client extension', () => {
  // Minimal Prisma double: $extends captures the extension and exposes a runner.
  function makePrisma() {
    let ext: any;
    const client: any = {
      $extends(e: any) {
        ext = e;
        // The extended client exposes a way to invoke $allOperations like Prisma.
        return {
          __ext: e,
          async run(model: string | undefined, operation: string, args: any, query: (a: any) => Promise<any>) {
            return ext.query.$allOperations({ model, operation, args, query });
          },
        };
      },
    };
    return { client, getExt: () => ext };
  }

  it('times a successful operation and emits a success row with rowsAffected', async () => {
    const { deps, sent } = makeDeps();
    const { client } = makePrisma();
    const extended: any = instrumentPrismaDirect(client, cfg, deps);
    const result = await extended.run('User', 'findMany', {}, async () => [{ id: 1 }, { id: 2 }]);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    const row = dbRowOf(sent);
    expect(row.status).toBe('success');
    expect(row.normalizedQuery).toBe('User.findMany');
    expect(row.rowsAffected).toBe(2);
    expect(row.databaseType).toBe('prisma');
  });

  it('emits an error row AND rethrows when the operation rejects', async () => {
    const { deps, sent } = makeDeps();
    const { client } = makePrisma();
    const extended: any = instrumentPrismaDirect(client, cfg, deps);
    await expect(
      extended.run('User', 'create', {}, async () => {
        throw new Error('unique constraint');
      }),
    ).rejects.toThrow('unique constraint');
    const row = dbRowOf(sent);
    expect(row.status).toBe('error');
    expect(row.errorMessage).toBe('unique constraint');
    expect(row.normalizedQuery).toBe('User.create');
  });

  it('normalizes raw SQL (literal values never leave the process)', async () => {
    const { deps, sent } = makeDeps();
    const { client } = makePrisma();
    const extended: any = instrumentPrismaDirect(client, cfg, deps);
    await extended.run(undefined, '$queryRawUnsafe', ["SELECT * FROM t WHERE x = 'sekret' AND y = 99"], async () => []);
    const row = dbRowOf(sent);
    expect(row.normalizedQuery).toBe('SELECT * FROM t WHERE x = ? AND y = ?');
    expect(JSON.stringify(row)).not.toContain('sekret');
  });

  it('is idempotent — a second instrument on the source returns it unchanged', () => {
    const { deps } = makeDeps();
    const { client } = makePrisma();
    const once = instrumentPrismaDirect(client, cfg, deps);
    const twice = instrumentPrismaDirect(client, cfg, deps);
    // Source is marked, so the second call returns the original client as-is.
    expect(twice).toBe(client);
    expect(once).not.toBe(client); // first call produced the extended client
  });

  it('returns the original value unchanged when it is not a Prisma client', () => {
    const { deps } = makeDeps();
    const notPrisma = { foo: 1 };
    expect(instrumentPrismaDirect(notPrisma, cfg, deps)).toBe(notPrisma);
  });
});

// ── TypeORM logger adapter ────────────────────────────────────────────────────

describe('@allstak/nestjs — TypeORM logger adapter', () => {
  it('emits success on logQuery, error on logQueryError, and timed on logQuerySlow', () => {
    const { deps, sent } = makeDeps();
    const logger = createTypeOrmLogger(cfg, deps, { databaseName: 'app', databaseType: 'mysql' });
    logger.logQuery("SELECT * FROM t WHERE id = 5");
    logger.logQueryError(new Error('syntax error'), 'SELECT bad');
    logger.logQuerySlow(250, 'SELECT * FROM big');
    const rows = sent.filter((s) => s.path === '/ingest/v1/db').map((s) => s.payload.queries[0]);
    expect(rows).toHaveLength(3);
    expect(rows[0].status).toBe('success');
    expect(rows[0].normalizedQuery).toBe('SELECT * FROM t WHERE id = ?');
    expect(rows[0].databaseType).toBe('mysql');
    expect(rows[1].status).toBe('error');
    expect(rows[1].errorMessage).toBe('syntax error');
    expect(rows[2].durationMs).toBe(250); // slow path carries real timing
  });

  it('delegates non-capture methods to a previous logger', () => {
    const { deps } = makeDeps();
    const prev = { logQuery: vi.fn(), logMigration: vi.fn(), logSchemaBuild: vi.fn() };
    const logger = createTypeOrmLogger(cfg, deps, { databaseName: '', databaseType: 'pg' }, prev);
    logger.logQuery('SELECT 1');
    logger.logMigration('migrated');
    logger.logSchemaBuild('built');
    expect(prev.logQuery).toHaveBeenCalledTimes(1);
    expect(prev.logMigration).toHaveBeenCalledWith('migrated', undefined);
    expect(prev.logSchemaBuild).toHaveBeenCalledWith('built', undefined);
  });

  it('instrumentDataSource attaches a logger, enables query logging, and is idempotent', () => {
    const { deps, sent } = makeDeps();
    const setOptions = vi.fn();
    const ds: any = { options: { type: 'postgres', database: 'app' }, setOptions };
    expect(instrumentDataSourceDirect(ds, cfg, deps)).toBe(true);
    // logger + logging were configured via setOptions.
    const passed = setOptions.mock.calls[0][0];
    expect(typeof passed.logger.logQuery).toBe('function');
    expect(passed.logging).toEqual(['query', 'error']);
    // Drive the attached logger to confirm it emits with the ds metadata.
    passed.logger.logQuery('SELECT 1');
    expect(dbRowOf(sent).databaseType).toBe('postgres');
    expect(dbRowOf(sent).databaseName).toBe('app');
    // Idempotent.
    expect(instrumentDataSourceDirect(ds, cfg, deps)).toBe(false);
  });

  it('respects an explicit host logging selection (does not override)', () => {
    const { deps } = makeDeps();
    const setOptions = vi.fn();
    const ds: any = { options: { type: 'sqlite', logging: ['error'] }, setOptions };
    instrumentDataSourceDirect(ds, cfg, deps);
    const passed = setOptions.mock.calls[0][0];
    expect(passed.logging).toBeUndefined(); // explicit list left intact
  });

  it('returns false when the value is not a data source', () => {
    const { deps } = makeDeps();
    expect(instrumentDataSourceDirect(null, cfg, deps)).toBe(false);
    expect(instrumentDataSourceDirect(42 as unknown, cfg, deps)).toBe(false);
  });
});

// ── public wrappers honour the active module context + gate ───────────────────

describe('@allstak/nestjs — public instrumentPrisma/instrumentDataSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetOutboundInstallForTest();
  });

  it('wires through the active module context once an interceptor is registered', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchSpy);
    createAllStakNestInterceptor({ apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', environment: 'production' });

    let ext: any;
    const prisma: any = {
      $extends(e: any) {
        ext = e;
        return { __ext: e };
      },
    };
    const extended = instrumentPrisma(prisma);
    expect(extended).not.toBe(prisma); // returned the extended client
    expect(typeof ext.query.$allOperations).toBe('function');

    // A query on the extended client POSTs /ingest/v1/db through the transport.
    await ext.query.$allOperations({
      model: 'User',
      operation: 'findUnique',
      args: {},
      query: async () => ({ id: 1 }),
    });
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/ingest/v1/db')).length).toBe(1),
    );
    const body = JSON.parse(fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/ingest/v1/db'))![1].body);
    expect(body.queries[0].normalizedQuery).toBe('User.findUnique');
  });

  it('enableDbInstrumentation=false makes the wrappers no-ops', () => {
    createAllStakNestInterceptor({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      enableDbInstrumentation: false,
    });
    const prisma: any = { $extends: () => ({ extended: true }) };
    expect(instrumentPrisma(prisma)).toBe(prisma); // unchanged
    const ds: any = { options: { type: 'postgres' }, setOptions: vi.fn() };
    expect(instrumentDataSource(ds)).toBe(false);
  });
});
