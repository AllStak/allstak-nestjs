import { redactMap } from './redaction';
import { SDK_NAME, SDK_VERSION } from './version';
import { EventSpool, type SpoolOptions, type SpooledEnvelope } from './persistence';

const DEFAULT_HOST = 'https://api.allstak.sa';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CONCURRENT = 64;

/**
 * Session lifecycle paths are best-effort LIVE-ONLY: a replayed stale session
 * would skew release-health durations, so they are NEVER persisted to the
 * offline spool (only error/log/span/http/db telemetry is). Kept in sync with
 * src/session.ts PATH_START / PATH_END.
 */
const NON_PERSISTABLE_PATHS = new Set(['/ingest/v1/sessions/start', '/ingest/v1/sessions/end']);

export interface OfflineQueueOptions extends SpoolOptions {
  /**
   * Persist undeliverable events to a filesystem spool so buffered telemetry
   * survives a process restart and network outage, then replay them on the next
   * init. Default true (server runtime). Set false to opt out — the transport
   * keeps its existing in-memory drop-on-overflow behaviour.
   */
  enabled?: boolean;
}

export interface TransportOptions {
  host: string;
  apiKey: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  fetch?: typeof fetch;
  /**
   * Offline / persistent event queue config. Pass `false` (or `{ enabled:
   * false }`) to disable persistence; pass a `dir`/cap overrides object to
   * configure the spool. Default: enabled with sane server defaults.
   */
  offlineQueue?: OfflineQueueOptions | boolean;
}

/**
 * Per-module-instance transport. State (in-flight, dropped) lives on the
 * instance so multiple AllStakModule.forRoot() calls in the same process
 * (multi-tenant / test setups) do not share counters or budgets.
 *
 * Delivery model:
 *   - Fire-and-forget over fetch, fail-open (never throws into capture).
 *   - On a delivery FAILURE — network error, overflow, 429, or 5xx — the
 *     already-PII-scrubbed wire body is written to a bounded persistent spool
 *     (see {@link EventSpool}) instead of being dropped, EXCEPT for session
 *     lifecycle paths which are live-only.
 *   - On construction the transport asynchronously drains any spooled entries
 *     from a previous process/outage and re-sends them. An entry is removed
 *     only once it is accepted (2xx) or permanently undeliverable (a 4xx other
 *     than 429); transient failures leave it on disk for the next drain.
 */
export class AllStakNestTransport {
  private readonly host: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly fetchImpl: typeof fetch;
  private readonly spool: EventSpool | null;
  private inFlight = 0;
  private dropped = 0;
  private persisted = 0;
  private shuttingDown = false;
  private drained = false;

  constructor(opts: TransportOptions) {
    this.host = (opts.host || DEFAULT_HOST).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.fetchImpl = (opts.fetch || globalThis.fetch) as typeof fetch;
    this.spool = this.makeSpool(opts.offlineQueue);
    // Drain a previous process's spool asynchronously — never block init.
    if (this.spool) void this.drain();
  }

  private makeSpool(offlineQueue: TransportOptions['offlineQueue']): EventSpool | null {
    // Default ON. Opt out with `false` or `{ enabled: false }`.
    if (offlineQueue === false) return null;
    const cfg: OfflineQueueOptions = typeof offlineQueue === 'object' ? offlineQueue : {};
    if (cfg.enabled === false) return null;
    // Under a unit-test runtime, default OFF so transports built by other test
    // suites don't share/replay the real shared tmpdir spool and skew exact
    // fetch-count assertions. Tests that exercise persistence opt back in by
    // passing an explicit, isolated `dir` (via `offlineQueueDir`), which clears
    // the guard; configs without a dir stay in-memory under the test runtime.
    if (!cfg.dir && isLikelyTestRuntime()) return null;
    try {
      const spool = new EventSpool(cfg);
      // If the FS is unavailable/unwritable the spool degrades to disabled;
      // drop the reference so the hot path stays a plain in-memory transport.
      return spool.isEnabled() ? spool : null;
    } catch {
      return null; // construction must never throw into init
    }
  }

  stats(): { inFlight: number; dropped: number; persisted: number; spooled: number } {
    return {
      inFlight: this.inFlight,
      dropped: this.dropped,
      persisted: this.persisted,
      spooled: this.spool?.size() ?? 0,
    };
  }

  /** Resolved spool directory, or null when persistence is disabled/degraded. */
  spoolLocation(): string | null {
    return this.spool?.location() ?? null;
  }

  async shutdown(timeoutMs = 1500): Promise<void> {
    this.shuttingDown = true;
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Scrub the full wire payload before serialization. The module already
   * applies redactMap to metadata at construction; this chokepoint catches any
   * top-level sensitive keys (e.g. callers who bypass setMetadata) and provides
   * defense-in-depth. Pure (no mutation), fail-open on sanitizer error. The
   * returned string is what is BOTH sent on the wire AND written to the spool,
   * guaranteeing nothing un-redacted is ever persisted to disk.
   */
  private scrubToBody(payload: unknown): string {
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
      return JSON.stringify(scrubbed);
    } catch {
      return JSON.stringify(payload);
    }
  }

  async send(path: string, payload: unknown): Promise<void> {
    if (!this.apiKey) return;
    // Scrub once, up front, so any path that ends in the spool persists the
    // exact same redacted bytes that would have gone on the wire.
    const body = this.scrubToBody(payload);
    if (this.shuttingDown) {
      // Process is going down with this event still buffered: persist (scrubbed)
      // rather than drop, so the next init replays it.
      this.persistBody(path, body);
      return;
    }
    if (this.inFlight >= this.maxConcurrent) {
      // Overflow: persist instead of silently dropping.
      if (!this.persistBody(path, body)) this.dropped++;
      return;
    }
    await this.deliver(path, body, undefined);
  }

  /**
   * POST a pre-scrubbed body. `spoolId` is set when this is a drained replay:
   * on success or permanent-failure the spool entry is removed; on a transient
   * failure it is left for the next drain. For a fresh (non-drained) send, a
   * transient failure persists the body.
   */
  private async deliver(path: string, body: string, spoolId: string | undefined): Promise<void> {
    this.inFlight++;
    let outcome: 'ok' | 'transient' | 'permanent' = 'transient';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.host}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AllStak-Key': this.apiKey,
            'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
          },
          body,
          signal: controller.signal,
        });
        outcome = classifyResponse(res);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      outcome = 'transient'; // network error / abort / offline — retriable
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }

    if (spoolId !== undefined) {
      // Drained replay: remove on success OR permanent failure; keep on transient.
      if (outcome !== 'transient') this.spool?.remove(spoolId);
    } else if (outcome === 'transient') {
      // Fresh send failed transiently — persist (scrubbed) for the next drain.
      this.persistBody(path, body);
    }
  }

  /** Persist a scrubbed body unless it is a live-only session path. */
  private persistBody(path: string, body: string): boolean {
    if (!this.spool) return false;
    if (NON_PERSISTABLE_PATHS.has(path)) return false; // sessions are live-only
    const ok = this.spool.persist(path, body);
    if (ok) this.persisted++;
    return ok;
  }

  /**
   * Load and re-send spooled envelopes from a previous process/outage. Runs
   * once per transport, asynchronously, and is fully fail-open. Respects the
   * concurrency budget; entries that don't fit are left for a later drain
   * (e.g. triggered when another send frees capacity is not implemented — the
   * next process init will retry, which is the durable guarantee that matters).
   */
  async drain(): Promise<void> {
    if (this.drained || !this.spool || !this.apiKey) return;
    this.drained = true;
    let entries: SpooledEnvelope[];
    try {
      entries = this.spool.load();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (this.shuttingDown) return;
      // Defensive: never replay a session path even if one slipped onto disk.
      if (NON_PERSISTABLE_PATHS.has(entry.path)) {
        this.spool.remove(entry.id);
        continue;
      }
      // Respect the in-flight budget; leave the rest for the next init.
      if (this.inFlight >= this.maxConcurrent) break;
      // Replay through the same transport (retry/backoff/circuit-breaker live in
      // the host fetch + the persist-on-transient loop). Awaited so removal is
      // ordered and the budget is honoured.
      await this.deliver(entry.path, entry.body, entry.id);
    }
  }
}

/** True only on a unit-test runtime (mirrors the guard in src/index.ts). */
function isLikelyTestRuntime(): boolean {
  try {
    return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  } catch {
    return false;
  }
}

/**
 * Map an HTTP response to a delivery outcome:
 *   - 2xx                       → accepted (remove from spool).
 *   - 429 or 5xx (or no status) → transient (retriable; keep/persist).
 *   - other 4xx                 → permanent (undeliverable; remove, don't retry).
 */
function classifyResponse(res: { ok?: boolean; status?: number } | undefined): 'ok' | 'transient' | 'permanent' {
  const status = res?.status;
  if (typeof status !== 'number') {
    // No status (mock or opaque) — treat a truthy `ok` as success, else transient.
    return res?.ok ? 'ok' : 'transient';
  }
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429) return 'transient';
  if (status >= 400 && status < 500) return 'permanent';
  return 'transient'; // 5xx and anything else retriable
}
