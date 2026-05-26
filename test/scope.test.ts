/**
 * Manual capture + scope API tests for @allstak/nestjs.
 *
 * Verifies the additive parity surface:
 *   - captureException / captureMessage route through the module transport
 *     (existing redaction + beforeSend pipeline via dispatch()), no real network
 *   - setUser / setTag / setContext attach to subsequently captured events
 *   - withScope forks a temporary scope that is popped afterwards
 *   - concurrent ALS request scopes do not leak user/tags across requests
 *   - auto-capture (exception filter) includes scope-set user/tags
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Module } from '@nestjs/common';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllStakModule,
  AllStakNestInterceptor,
  AllStakNestExceptionFilter,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setTags,
  setContext,
  setExtra,
  addBreadcrumb,
  withScope,
  configureScope,
} from '../src/index';

interface IngestCall { url: string; body: any; }

function captureFetch(): IngestCall[] {
  const calls: IngestCall[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const u = String(url);
    if (u.includes('/ingest/v1/')) {
      calls.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as any;
    }
    return real(url as any, init);
  }));
  return calls;
}

const cfg = {
  apiKey: 'ask_dev_test',
  host: 'https://api.allstak.sa',
  environment: 'test',
  serviceName: 'scope-test',
};

function errors(calls: IngestCall[]): IngestCall[] {
  return calls.filter((c) => c.url.endsWith('/ingest/v1/errors'));
}

/**
 * Construct an interceptor with the test config so it registers the
 * module-level active capture context for unit-level manual-capture tests.
 */
function activate(): void {
  // eslint-disable-next-line @typescript-eslint/no-new
  new AllStakNestInterceptor(cfg);
}

describe('@allstak/nestjs manual capture + scope (unit)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => {
    configureScope((s) => s.clear());
    vi.unstubAllGlobals();
  });

  it('captureException routes through the module transport', async () => {
    const calls = captureFetch();
    activate();
    captureException(new Error('manual boom'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    const ev = errors(calls)[0].body;
    expect(ev.message).toBe('manual boom');
    expect(ev.exceptionClass).toBe('Error');
    expect(ev.metadata['sdk.name']).toBeTruthy();
  });

  it('captureMessage sends a message event', async () => {
    const calls = captureFetch();
    activate();
    captureMessage('hello world', 'warning');
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    const ev = errors(calls)[0].body;
    expect(ev.message).toBe('hello world');
    expect(ev.level).toBe('warning');
    expect(ev.exceptionClass).toBe('Message');
  });

  it('setUser / setTag / setContext / setExtra attach to captured events', async () => {
    const calls = captureFetch();
    activate();
    setUser({ id: 'u-42', email: 'a@b.co' });
    setTag('feature', 'checkout');
    setTags({ region: 'eu' });
    setExtra('orderId', 'o-9');
    setContext('app', { build: '1.2.3' });
    captureException(new Error('with scope'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    const meta = errors(calls)[0].body.metadata;
    expect(meta.userId).toBe('u-42');
    expect(meta.userEmail).toBe('a@b.co');
    expect(meta['tag.feature']).toBe('checkout');
    expect(meta['tag.region']).toBe('eu');
    expect(meta['extra.orderId']).toBe('o-9');
    expect(meta['context.app']).toEqual({ build: '1.2.3' });
  });

  it('addBreadcrumb attaches breadcrumbs to captured events', async () => {
    const calls = captureFetch();
    activate();
    addBreadcrumb({ type: 'custom', message: 'step-1' });
    captureException(new Error('crumbs'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    const crumbs = errors(calls)[0].body.breadcrumbs;
    expect(crumbs.some((c: any) => c.message === 'step-1')).toBe(true);
  });

  it('withScope forks a temporary scope that is popped afterwards', async () => {
    const calls = captureFetch();
    activate();
    withScope((scope) => {
      scope.setTag('temp', 'yes');
      captureException(new Error('inside'));
    });
    captureException(new Error('outside'));
    await vi.waitFor(() => expect(errors(calls).length).toBe(2));
    const inside = errors(calls).find((c) => c.body.message === 'inside')!.body;
    const outside = errors(calls).find((c) => c.body.message === 'outside')!.body;
    expect(inside.metadata['tag.temp']).toBe('yes');
    expect(outside.metadata['tag.temp']).toBeUndefined();
  });

  it('beforeSend still runs on manual captures (pipeline preserved)', async () => {
    const calls: IngestCall[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const u = String(url);
      if (u.includes('/ingest/v1/')) {
        calls.push({ url: u, body: JSON.parse(init.body) });
        return { ok: true, status: 200 } as any;
      }
      return real(url as any, init);
    }));
    // eslint-disable-next-line @typescript-eslint/no-new
    new AllStakNestInterceptor({
      ...cfg,
      beforeSend: (ev) => { (ev.payload as any).tagged = true; return ev; },
    });
    captureException(new Error('pipe'));
    await vi.waitFor(() => expect(errors(calls).length).toBeGreaterThan(0));
    expect(errors(calls)[0].body.tagged).toBe(true);
  });
});

// ── Request isolation via real Nest app ────────────────────────────────────

@Controller()
class ScopedController {
  @Get('/a')
  async a(): Promise<never> {
    setUser({ id: 'user-A' });
    setTag('which', 'A');
    await new Promise((r) => setTimeout(r, 30));
    throw new Error('boom-A');
  }
  @Get('/b')
  async b(): Promise<never> {
    setUser({ id: 'user-B' });
    setTag('which', 'B');
    await new Promise((r) => setTimeout(r, 10));
    throw new Error('boom-B');
  }
}

@Module({
  controllers: [ScopedController],
  providers: [
    { provide: APP_INTERCEPTOR, useFactory: () => new AllStakNestInterceptor(cfg) },
    { provide: APP_FILTER, useFactory: () => new AllStakNestExceptionFilter(cfg) },
  ],
})
class ScopedAppModule {}

async function buildApp(): Promise<{ app: NestExpressApplication; port: number }> {
  const expressApp = express();
  const app = await NestFactory.create<NestExpressApplication>(
    ScopedAppModule,
    new ExpressAdapter(expressApp),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address();
  if (!addr || typeof addr === 'string') throw new Error('expected bound port');
  return { app, port: addr.port };
}

describe('@allstak/nestjs scope request isolation (real Nest)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('concurrent request scopes do not leak; auto-capture (filter) includes scope user/tags', async () => {
    const calls = captureFetch();
    const { app, port } = await buildApp();
    try {
      const [ra, rb] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/a`),
        fetch(`http://127.0.0.1:${port}/b`),
      ]);
      expect(ra.status).toBe(500);
      expect(rb.status).toBe(500);
      // Both requests emit /errors; each must carry its OWN request-scoped
      // user/tag, and NEVER the other request's. (NestJS may invoke the global
      // filter more than once per request — pre-existing behavior — so we
      // assert per-message scope correctness + no cross-request leak rather
      // than an exact count.)
      await vi.waitFor(() => {
        const errs = errors(calls);
        expect(errs.some((c) => c.body.message === 'boom-A')).toBe(true);
        expect(errs.some((c) => c.body.message === 'boom-B')).toBe(true);
      }, { timeout: 1500 });
      const errs = errors(calls);
      // The scoped capture for /a carries user-A; for /b carries user-B.
      const aScoped = errs.find((c) => c.body.message === 'boom-A' && c.body.metadata.userId);
      const bScoped = errs.find((c) => c.body.message === 'boom-B' && c.body.metadata.userId);
      expect(aScoped!.body.metadata.userId).toBe('user-A');
      expect(aScoped!.body.metadata['tag.which']).toBe('A');
      expect(bScoped!.body.metadata.userId).toBe('user-B');
      expect(bScoped!.body.metadata['tag.which']).toBe('B');
      // Critical isolation guarantee: no boom-A event ever carries user-B, and
      // vice versa.
      for (const c of errs) {
        if (c.body.message === 'boom-A') expect(c.body.metadata.userId).not.toBe('user-B');
        if (c.body.message === 'boom-B') expect(c.body.metadata.userId).not.toBe('user-A');
      }
    } finally { await app.close(); }
  });
});
