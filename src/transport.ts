import { redactMap } from './redaction';
import { SDK_NAME, SDK_VERSION } from './version';

const DEFAULT_HOST = 'https://api.allstak.sa';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CONCURRENT = 64;

export interface TransportOptions {
  host: string;
  apiKey: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  fetch?: typeof fetch;
}

/**
 * Per-module-instance transport. State (in-flight, dropped) lives on the
 * instance so multiple AllStakModule.forRoot() calls in the same process
 * (multi-tenant / test setups) do not share counters or budgets.
 */
export class AllStakNestTransport {
  private readonly host: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly fetchImpl: typeof fetch;
  private inFlight = 0;
  private dropped = 0;
  private shuttingDown = false;

  constructor(opts: TransportOptions) {
    this.host = (opts.host || DEFAULT_HOST).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.fetchImpl = (opts.fetch || globalThis.fetch) as typeof fetch;
  }

  stats(): { inFlight: number; dropped: number } {
    return { inFlight: this.inFlight, dropped: this.dropped };
  }

  async shutdown(timeoutMs = 1500): Promise<void> {
    this.shuttingDown = true;
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async send(path: string, payload: unknown): Promise<void> {
    if (!this.apiKey) return;
    if (this.shuttingDown) return;
    if (this.inFlight >= this.maxConcurrent) {
      this.dropped++;
      return;
    }
    this.inFlight++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        // Scrub the full wire payload before serialization. The module
        // already applies redactMap to metadata at construction; this
        // chokepoint catches any top-level sensitive keys (e.g. callers
        // who bypass setMetadata) and provides defense-in-depth.
        // Pure (no mutation), fail-open on sanitizer error.
        let body: string;
        try {
          const scrubbed = redactMap(payload as Record<string, unknown>) ?? payload;
          // `sessionId` is a release-health correlation id (NOT an auth/session
          // token), but the default denylist redacts `session*id` because in
          // headers/cookies a "session id" is sensitive. Restore the top-level
          // release-health field so the backend can attribute the session;
          // nested/metadata/header session-ids stay redacted.
          if (
            scrubbed &&
            payload &&
            typeof payload === 'object' &&
            typeof (payload as Record<string, unknown>).sessionId === 'string'
          ) {
            (scrubbed as Record<string, unknown>).sessionId = (payload as Record<string, unknown>).sessionId;
          }
          body = JSON.stringify(scrubbed);
        } catch {
          body = JSON.stringify(payload);
        }
        await this.fetchImpl(`${this.host}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AllStak-Key': this.apiKey,
            'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // fail-open
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }
}
