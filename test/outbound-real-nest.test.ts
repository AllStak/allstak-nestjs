/**
 * End-to-end outbound-propagation validation for @allstak/nestjs against a real
 * NestJS 11 app on the Express adapter.
 *
 * The whole point of outbound instrumentation: a downstream `fetch` made WHILE
 * handling an inbound request must continue the SAME trace, so the distributed
 * trace survives the first hop. This boots a real Nest app, makes an inbound
 * request whose handler performs an outbound fetch to a second (downstream)
 * server, and asserts:
 *   - the downstream server received a `traceparent` whose trace id equals the
 *     inbound request's trace id (child span id, same trace)
 *   - an outbound HttpRequestPayload(direction:'outbound') is emitted to ingest
 *   - the SDK's own ingest egress is NOT instrumented (no recursion)
 */
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllStakModule } from '../src/index';

interface IngestCall {
  url: string;
  body: any;
}

/** Intercept ONLY ingest URLs (capture them); everything else hits the network. */
function captureIngest(): IngestCall[] {
  const calls: IngestCall[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: any, init: any) => {
      const u = String(typeof url === 'object' && url?.url ? url.url : url);
      if (u.includes('/ingest/v1/')) {
        calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
        return { ok: true, status: 200 } as any;
      }
      return real(url, init);
    }),
  );
  return calls;
}

/** A bare downstream HTTP server that records the headers it receives. */
function startDownstream(): Promise<{ port: number; lastHeaders: () => http.IncomingHttpHeaders; close: () => void }> {
  let lastHeaders: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('expected bound port');
      resolve({
        port: addr.port,
        lastHeaders: () => lastHeaders,
        close: () => server.close(),
      });
    });
  });
}

describe('@allstak/nestjs outbound propagation against real NestJS 11', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a fetch made inside a handler continues the inbound trace + emits an outbound row', async () => {
    const downstream = await startDownstream();
    const cfg = {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      environment: 'test',
      release: 'outbound-validation@1.0.0',
      serviceName: 'outbound-validation',
      enableOutboundHttp: true,
    };

    @Controller()
    class CallerController {
      @Get('/call')
      async call(): Promise<{ relayed: boolean }> {
        // Outbound call to the downstream server while handling the request.
        await fetch(`http://127.0.0.1:${downstream.port}/downstream`);
        return { relayed: true };
      }
    }

    @Module({ imports: [AllStakModule.forRoot(cfg)], controllers: [CallerController] })
    class AppModule {}

    const calls = captureIngest();
    const expressApp = express();
    const app = await NestFactory.create<NestExpressApplication>(
      AppModule,
      new ExpressAdapter(expressApp),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    if (!addr || typeof addr === 'string') throw new Error('expected bound port');

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/call`);
      expect(res.status).toBe(200);
      const inboundTraceId = res.headers.get('x-allstak-trace-id');
      expect(inboundTraceId).toMatch(/^[0-9a-f]{32}$/);

      // The downstream server received a traceparent on the SAME trace.
      const dh = downstream.lastHeaders();
      const tp = dh['traceparent'] as string | undefined;
      expect(tp).toBeTruthy();
      expect(tp!).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(tp!.split('-')[1]).toBe(inboundTraceId); // same trace id continued
      expect(dh['allstak-baggage']).toContain(`allstak-trace_id=${inboundTraceId}`);

      // An outbound HttpRequestPayload row was emitted for the egress call.
      await vi.waitFor(() => {
        const outbound = calls
          .filter((c) => c.url.endsWith('/ingest/v1/http-requests'))
          .flatMap((c) => c.body?.requests ?? [])
          .find((r: any) => r.direction === 'outbound');
        expect(outbound).toBeTruthy();
      }, { timeout: 1500 });

      const outboundRow = calls
        .filter((c) => c.url.endsWith('/ingest/v1/http-requests'))
        .flatMap((c) => c.body.requests)
        .find((r: any) => r.direction === 'outbound');
      expect(outboundRow.traceId).toBe(inboundTraceId);
      expect(outboundRow.host).toBe(`127.0.0.1:${downstream.port}`);
      expect(outboundRow.path).toBe('/downstream');
      expect(outboundRow.method).toBe('GET');
      expect(outboundRow.statusCode).toBe(200);

      // The inbound request span is the parent of the outbound span.
      const inboundRow = calls
        .filter((c) => c.url.endsWith('/ingest/v1/http-requests'))
        .flatMap((c) => c.body.requests)
        .find((r: any) => r.direction === 'inbound');
      expect(inboundRow).toBeTruthy();
      expect(outboundRow.parentSpanId).toBe(inboundRow.spanId);
    } finally {
      await app.close();
      downstream.close();
    }
  });
});
