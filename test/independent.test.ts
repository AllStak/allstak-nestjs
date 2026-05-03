import { describe, expect, it, vi } from 'vitest';
import { createAllStakNestInterceptor } from '../src/index';

describe('@allstak/nestjs standalone package', () => {
  it('emits an ingest payload without importing another AllStak SDK', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    let finish: (() => void) | undefined;
    const interceptor = createAllStakNestInterceptor({
      apiKey: 'ask_dev_test',
      host: 'https://api.dev.allstak.sa',
      environment: 'development',
      release: 'tier1-test',
      serviceName: 'nestjs-test',
    });
    interceptor.intercept({
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', originalUrl: '/orders?debug=1', headers: { host: 'api.example.test' } }),
        getResponse: () => ({ statusCode: 201, on: (_event: string, cb: () => void) => { finish = cb; } }),
      }),
    }, { handle: () => ({}) });
    finish?.();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.dev.allstak.sa/ingest/v1/http-requests');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).requests[0].path).toBe('/orders');
  });
});
