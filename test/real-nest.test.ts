/**
 * Real-framework validation for @allstak/nestjs.
 *
 * Boots an actual NestJS 11 application backed by the Express HTTP adapter,
 * registers our Interceptor + ExceptionFilter as globals, and asserts:
 *   - inbound traceparent → response correlation headers
 *   - successful responses produce an ingest /http-requests payload
 *   - thrown handler errors produce an ingest /errors payload AND the
 *     customer's 500 response is preserved
 *   - ingest outage does not break customer responses
 *   - registering the interceptor + filter via Nest DI does not cause
 *     duplicate emission per request
 *
 * The original-mocked-fetch capturing pattern is reused, but every request
 * goes through the real Nest express adapter on a bound port.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  Module,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllStakModule,
  AllStakNestExceptionFilter,
  AllStakNestInterceptor,
} from '../src/index';

interface IngestCall {
  url: string;
  body: any;
}

function captureFetch(): IngestCall[] {
  const calls: IngestCall[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      // Only intercept AllStak ingest URLs; let any other fetch (Nest probes
      // etc.) fall through to the real implementation.
      const u = String(url);
      if (u.includes('/ingest/v1/')) {
        calls.push({ url: u, body: JSON.parse(init.body) });
        return { ok: true, status: 200 } as any;
      }
      return real(url as any, init);
    }),
  );
  return calls;
}

const cfg = {
  apiKey: 'ask_dev_test',
  host: 'https://api.dev.allstak.sa',
  environment: 'test',
  release: 'nest-validation@1.0.0',
  serviceName: 'nest-validation',
};

@Controller()
class HelloController {
  @Get('/health')
  health(): { ok: boolean } { return { ok: true }; }
  @Get('/boom')
  boom(): never { throw new Error('intentional boom'); }
}

@Module({
  controllers: [HelloController],
  providers: [
    { provide: APP_INTERCEPTOR, useFactory: () => new AllStakNestInterceptor(cfg) },
    { provide: APP_FILTER,      useFactory: () => new AllStakNestExceptionFilter(cfg) },
  ],
})
class AppModule {}

async function buildApp(): Promise<{ app: NestExpressApplication; port: number }> {
  const expressApp = express();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(expressApp),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected bound port');
  return { app, port: addr.port };
}

describe('@allstak/nestjs against real NestJS 11', () => {
  beforeEach(() => {
    /* counter reset no longer needed — transport state is per-instance */
    vi.unstubAllGlobals();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('happy path: response carries correlation headers and emits ingest payload', async () => {
    const calls = captureFetch();
    const { app, port } = await buildApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-allstak-trace-id')).toMatch(/^[0-9a-f]{32}$/);
      expect(res.headers.get('x-allstak-request-id')).toBeTruthy();
      expect(res.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 1000 });
      const httpReq = calls.find((c) => c.url.endsWith('/ingest/v1/http-requests'));
      expect(httpReq).toBeTruthy();
      const row = httpReq!.body.requests[0];
      expect(row.method).toBe('GET');
      expect(row.path).toBe('/health');
      expect(row.statusCode).toBe(200);
      expect(row.traceId).toBe(res.headers.get('x-allstak-trace-id'));
    } finally { await app.close(); }
  });

  it('honors inbound traceparent and propagates the same trace id back', async () => {
    captureFetch();
    const { app, port } = await buildApp();
    try {
      const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {
          traceparent: `00-${traceId}-bbbbbbbbbbbbbbbb-01`,
          'x-allstak-request-id': 'req-from-upstream',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-allstak-trace-id')).toBe(traceId);
      expect(res.headers.get('x-allstak-request-id')).toBe('req-from-upstream');
    } finally { await app.close(); }
  });

  it('thrown handler errors produce an ingest /errors payload and a 500 response', async () => {
    const calls = captureFetch();
    const { app, port } = await buildApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/boom`);
      expect(res.status).toBe(500);
      await vi.waitFor(() => {
        expect(calls.find((c) => c.url.endsWith('/ingest/v1/errors'))).toBeTruthy();
      }, { timeout: 1000 });
      const errCall = calls.find((c) => c.url.endsWith('/ingest/v1/errors'))!;
      expect(errCall.body.message).toBe('intentional boom');
      expect(errCall.body.metadata.httpPath).toBe('/boom');
      expect(errCall.body.traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally { await app.close(); }
  });

  it('ingest outage does not break customer responses', async () => {
    // Capture the real fetch BEFORE stubbing, otherwise the stub
    // delegates back to itself and recurses forever.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any) => {
        const u = String(url);
        if (u.includes('/ingest/v1/')) throw new Error('DNS failure');
        return realFetch(url as any, init);
      }),
    );
    const { app, port } = await buildApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally { await app.close(); }
  });

  it('one request emits exactly one /http-requests payload (no duplicate emission)', async () => {
    const calls = captureFetch();
    const { app, port } = await buildApp();
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 1000 });
      const httpReqs = calls.filter((c) => c.url.endsWith('/ingest/v1/http-requests'));
      expect(httpReqs).toHaveLength(1);
    } finally { await app.close(); }
  });
});

// ── AllStakModule.forRoot() tests ──────────────────────────────────────────

@Module({
  imports: [AllStakModule.forRoot(cfg)],
  controllers: [HelloController],
})
class ForRootAppModule {}

async function buildForRootApp(): Promise<{ app: NestExpressApplication; port: number }> {
  const expressApp = express();
  const app = await NestFactory.create<NestExpressApplication>(
    ForRootAppModule,
    new ExpressAdapter(expressApp),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected bound port');
  return { app, port: addr.port };
}

describe('@allstak/nestjs AllStakModule.forRoot()', () => {
  beforeEach(() => {
    /* counter reset no longer needed — transport state is per-instance */
    vi.unstubAllGlobals();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('forRoot registers interceptor and produces correlation headers + ingest payload', async () => {
    const calls = captureFetch();
    const { app, port } = await buildForRootApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-allstak-trace-id')).toMatch(/^[0-9a-f]{32}$/);
      expect(res.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 1000 });
      const httpReq = calls.find((c) => c.url.endsWith('/ingest/v1/http-requests'));
      expect(httpReq).toBeTruthy();
      const row = httpReq!.body.requests[0];
      expect(row.method).toBe('GET');
      expect(row.path).toBe('/health');
      expect(row.statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('forRoot registers exception filter and produces /errors payload', async () => {
    const calls = captureFetch();
    const { app, port } = await buildForRootApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/boom`);
      expect(res.status).toBe(500);
      await vi.waitFor(() => {
        expect(calls.find((c) => c.url.endsWith('/ingest/v1/errors'))).toBeTruthy();
      }, { timeout: 1000 });
      const errCall = calls.find((c) => c.url.endsWith('/ingest/v1/errors'))!;
      expect(errCall.body.message).toBe('intentional boom');
    } finally { await app.close(); }
  });
});
