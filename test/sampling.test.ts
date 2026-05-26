import { describe, expect, it, vi } from 'vitest';
import {
  createAllStakNestExceptionFilter,
  createAllStakNestInterceptor,
} from '../src/index';

function makeFilterContext() {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        originalUrl: '/x',
        headers: {},
        allstakTraceId: 'c'.repeat(32),
        allstakRequestId: 'r',
        allstakSpanId: 'd'.repeat(16),
      }),
      getResponse: () => ({ statusCode: 500 }),
    }),
  };
}

function makeInterceptorContext(captured: { setHeader: Record<string, string> }, headers: Record<string, string> = {}) {
  const handlers: Record<string, () => void> = {};
  const response = {
    statusCode: 200,
    on: (event: 'finish' | 'close', cb: () => void) => {
      handlers[event] = cb;
    },
    setHeader: (name: string, value: string) => {
      captured.setHeader[name.toLowerCase()] = value;
    },
  };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', originalUrl: '/orders', headers: { host: 'h', ...headers } }),
      getResponse: () => response,
    }),
  };
  return { ctx, handlers };
}

describe('@allstak/nestjs — error sampleRate', () => {
  it('sampleRate 0 drops the error (no send) but still rethrows', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const filter = createAllStakNestExceptionFilter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      sampleRate: 0,
      random: () => 0,
    });
    expect(() => filter.catch(new Error('boom'), makeFilterContext())).toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sampleRate 1 keeps the error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const filter = createAllStakNestExceptionFilter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      sampleRate: 1,
      random: () => 0.999999,
    });
    expect(() => filter.catch(new Error('boom'), makeFilterContext())).toThrow();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });

  it('sampling drops happen BEFORE beforeSend — beforeSend not called for dropped errors', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const beforeSend = vi.fn((event) => event);
    const filter = createAllStakNestExceptionFilter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      sampleRate: 0,
      random: () => 0,
      beforeSend,
    });
    expect(() => filter.catch(new Error('boom'), makeFilterContext())).toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(beforeSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('@allstak/nestjs — error beforeSend fail-open', () => {
  it('a throwing beforeSend still sends the original error event', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const filter = createAllStakNestExceptionFilter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      beforeSend: () => {
        throw new Error('callback blew up');
      },
    });
    expect(() => filter.catch(new Error('payload survives'), makeFilterContext())).toThrow();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe('payload survives');
  });
});

describe('@allstak/nestjs — tracesSampleRate drives traceparent flag', () => {
  it('origin trace: tracesSampleRate 0 propagates -00 and emits no request/span', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const captured = { setHeader: {} as Record<string, string> };
    const { ctx, handlers } = makeInterceptorContext(captured);
    const interceptor = createAllStakNestInterceptor({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      tracesSampleRate: 0,
      random: () => 0,
    });
    interceptor.intercept(ctx, { handle: () => ({}) });
    handlers.finish?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(captured.setHeader.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('origin trace: tracesSampleRate 1 propagates -01 and emits request + span', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const captured = { setHeader: {} as Record<string, string> };
    const { ctx, handlers } = makeInterceptorContext(captured);
    const interceptor = createAllStakNestInterceptor({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      tracesSampleRate: 1,
      random: () => 0.999999,
    });
    interceptor.intercept(ctx, { handle: () => ({}) });
    handlers.finish?.();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(captured.setHeader.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('child trace inherits inbound sampled flag (-00) regardless of tracesSampleRate', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const captured = { setHeader: {} as Record<string, string> };
    const { ctx, handlers } = makeInterceptorContext(captured, {
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`,
    });
    const interceptor = createAllStakNestInterceptor({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      tracesSampleRate: 1, // would sample IN if origin, but inbound flag wins
      random: () => 0,
    });
    interceptor.intercept(ctx, { handle: () => ({}) });
    handlers.finish?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(captured.setHeader.traceparent).toBe(`00-${'a'.repeat(32)}-${captured.setHeader.traceparent.split('-')[2]}-00`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('child trace inherits inbound sampled flag (-01) and emits', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const captured = { setHeader: {} as Record<string, string> };
    const { ctx, handlers } = makeInterceptorContext(captured, {
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    });
    const interceptor = createAllStakNestInterceptor({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      tracesSampleRate: 0, // would sample OUT if origin, but inbound flag wins
      random: () => 0,
    });
    interceptor.intercept(ctx, { handle: () => ({}) });
    handlers.finish?.();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(captured.setHeader.traceparent).toMatch(/-01$/);
  });
});
