/**
 * Server-mode release-health "single session" tracker for @allstak/nestjs.
 *
 * Mirrors the AllStak Java SDK's {@code SessionTracker}/{@code Session} model
 * (see allstak-java-sdk .../session/SessionTracker.java) idiomatically in
 * TypeScript: one session per process / app launch.
 *
 *   - On {@link SessionTracker.start} the SDK records `sessionStart`, sets the
 *     in-memory status to `ok`, and POSTs `/ingest/v1/sessions/start` with the
 *     resolved release + SDK identity. Sessions are NEVER sampled.
 *   - {@link SessionTracker.recordError} bumps status to `errored` (a HANDLED
 *     error kept the process running); {@link SessionTracker.recordCrash}
 *     escalates to the terminal `crashed` status (an UNHANDLED/fatal error).
 *     Both are in-memory only — no per-error network I/O.
 *   - On {@link SessionTracker.end} the SDK computes `durationMs = now -
 *     sessionStart` and POSTs `/ingest/v1/sessions/end` with the final status.
 *
 * Every method is fail-open: a transport / network failure must never throw
 * into the host application's init or shutdown path. One instance per
 * AllStakModule registration; both `start` and `end` are idempotent.
 */

import type { AllStakNestTransport } from './transport';

/**
 * Lifecycle status of a release-health session. Vocabulary matches the AllStak
 * backend's `/ingest/v1/sessions/end` contract and Sentry's release-health
 * conventions:
 *
 *   - `ok`       — session ran with at most non-fatal logs.
 *   - `errored`  — at least one HANDLED error landed, but the process survived.
 *   - `crashed`  — an UNHANDLED / fatal error ended the process (terminal).
 *   - `abnormal` — process ended without a normal flush (reserved).
 */
export type SessionStatus = 'ok' | 'errored' | 'crashed' | 'abnormal';

const PATH_START = '/ingest/v1/sessions/start';
const PATH_END = '/ingest/v1/sessions/end';

/** Generate a session id (UUID v4 when available, hex fallback otherwise). */
function generateSessionId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* fall through to hex */
    }
  }
  const bytes = 16;
  if (c?.getRandomValues) {
    const data = new Uint8Array(bytes);
    c.getRandomValues(data);
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * A single release-health session. One per process in the default single-mode
 * deployment. Mutable status / error counter so the interceptor + filter can
 * mark it errored/crashed without locking (single-threaded JS, but mirrors the
 * reference model's transition rules exactly).
 */
export class Session {
  readonly id: string;
  readonly startedAt: number;
  private statusValue: SessionStatus = 'ok';
  private errors = 0;

  constructor(id: string = generateSessionId(), startedAt: number = Date.now()) {
    this.id = id;
    this.startedAt = startedAt;
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  get errorCount(): number {
    return this.errors;
  }

  /**
   * Increment the error counter and bump status to `errored` unless the session
   * has already escalated to a terminal status (`crashed`/`abnormal`).
   */
  recordError(): void {
    this.errors++;
    if (this.statusValue === 'ok') this.statusValue = 'errored';
  }

  /** Mark a terminal `crashed` status (overrides `errored`). */
  recordCrash(): void {
    this.statusValue = 'crashed';
    this.errors++;
  }

  /** Promote to `abnormal` only if still `ok` or `errored`. */
  recordAbnormalExit(): void {
    if (this.statusValue === 'ok' || this.statusValue === 'errored') {
      this.statusValue = 'abnormal';
    }
  }

  /** Duration from start to now, floored at 0. */
  durationMs(now: number = Date.now()): number {
    return Math.max(0, now - this.startedAt);
  }
}

export interface SessionTrackerConfig {
  /** Resolved release (fallback to SDK version upstream). When empty the
   *  network calls are skipped but in-memory status still tracks. */
  release: string;
  environment?: string;
  userId?: string;
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
}

/**
 * Server-mode "single session" tracker. One instance per AllStakModule
 * registration. Re-entrancy safe: a second {@link start} returns the existing
 * session; once {@link end}ed the tracker does not re-arm.
 */
export class SessionTracker {
  private readonly config: SessionTrackerConfig;
  private readonly transport: AllStakNestTransport;
  private active: Session | null = null;
  private ended = false;

  constructor(config: SessionTrackerConfig, transport: AllStakNestTransport) {
    this.config = config;
    this.transport = transport;
  }

  /**
   * Idempotent. Returns the session that became active (or the existing one).
   * The `/sessions/start` POST is fire-and-forget through the SDK transport so
   * init never blocks on a network round-trip. Sessions are NEVER sampled.
   */
  start(): Session {
    if (this.active) return this.active;
    const session = new Session();
    this.active = session;
    // No release ⇒ release-health cannot attribute the session. Keep the
    // in-memory tracker so errored/crashed transitions still set a sensible
    // final status, but skip the network call (mirrors the reference SDK).
    if (!this.config.release) return session;
    const payload: Record<string, unknown> = {
      sessionId: session.id,
      release: this.config.release,
      environment: this.config.environment,
      userId: this.config.userId ?? null,
      sdkName: this.config.sdkName,
      sdkVersion: this.config.sdkVersion,
      platform: this.config.platform,
    };
    // Fail-open: transport.send never throws, but guard regardless so a
    // synchronous failure cannot escape into the host's init path.
    try {
      void this.transport.send(PATH_START, payload);
    } catch {
      /* never block init */
    }
    return session;
  }

  /** The active session, or null if not started or already ended. */
  current(): Session | null {
    return this.ended ? null : this.active;
  }

  /** Record a HANDLED error against the active session. No network I/O. */
  recordError(): void {
    this.current()?.recordError();
  }

  /** Record an UNHANDLED/fatal crash. No network I/O — the end POST carries it. */
  recordCrash(): void {
    this.current()?.recordCrash();
  }

  /**
   * Terminate the session and POST `/sessions/end`. Idempotent. When
   * `finalStatus` is omitted the session's accumulated status is used. Best
   * effort and fail-open: must not block or throw on the shutdown path.
   */
  end(finalStatus?: SessionStatus): void {
    if (this.ended) return;
    const session = this.active;
    this.active = null;
    if (!session) return;
    this.ended = true;
    const status = finalStatus ?? session.status;
    if (!this.config.release) return;
    const payload: Record<string, unknown> = {
      sessionId: session.id,
      durationMs: Math.min(Number.MAX_SAFE_INTEGER, session.durationMs()),
      status,
    };
    try {
      void this.transport.send(PATH_END, payload);
    } catch {
      /* never block shutdown */
    }
  }
}
