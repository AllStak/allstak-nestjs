# Changelog

All notable changes to @allstak/nestjs will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]## [0.1.0] — 2026-05-29

This entry collects the feature waves landed on top of `0.1.0-beta.3`. They are
staged in the manifest under `0.1.0-beta.4`; the release version is chosen at the
publish gate.

### Added — Release-health session tracking (start/end + crash-free)
- `SessionTracker`/`Session` open one release-health session per process at module
  startup (`POST /ingest/v1/sessions/start`) and close it on graceful shutdown
  (`POST /ingest/v1/sessions/end`) with `durationMs` and a final status. Status is
  tracked locally as `ok` → `errored` (a handled error) → `crashed` (an unhandled /
  fatal error); no per-error network I/O. Sessions are NEVER sampled. Mirrors the
  AllStak Java SDK's `SessionTracker` model idiomatically in TypeScript.
- Gated by `enableAutoSessionTracking` (default `true`; auto-skipped under a unit-test
  runtime — `NODE_ENV=test` / `VITEST`). New `platform`/`userId` config attach to the
  session-start payload. Every method is fail-open and idempotent.
- Exports `Session`, `SessionTracker`, and the `SessionStatus` type.

### Added — Offline / persistent transport queue (survive restart + outage)
- New `persistence.ts` `EventSpool`: when an event cannot be delivered (network error,
  retry exhausted, offline, or shutdown with events still buffered) the transport writes
  the ALREADY-PII-SCRUBBED wire body to a bounded filesystem spool instead of dropping it,
  then drains and replays it on the next init through the normal retry/backoff pipeline.
  One JSON file per envelope; bounded by count / total bytes / max age (defaults
  ~100 entries, 5 MB, 48h) with drop-oldest eviction.
- Gated by `enableOfflineQueue` (default `true`) with `offlineQueueDir` override
  (defaults to `<os.tmpdir()>/allstak-nestjs-spool`). Session lifecycle calls are
  never persisted (live-only). Scrub-before-persist is enforced; on a read-only FS or
  a serverless/edge runtime with no `fs` the spool degrades silently to the prior
  in-memory drop-on-overflow behaviour — it never throws or blocks init.
- Exports `EventSpool`, `SpoolOptions`, `SpooledEnvelope`, `OfflineQueueOptions`,
  and `TransportOptions`.

### Added — Value-pattern PII scrubbing + `sendDefaultPii`
- `redaction.ts` adds value-pattern scrubbing (data-scrubbing parity) over string
  VALUES regardless of key, on top of the existing key-pattern redaction. Credit-card
  numbers that pass the Luhn checksum and hyphenated US SSNs are ALWAYS scrubbed; email
  addresses and IPv4/IPv6 literals are scrubbed UNLESS `sendDefaultPii === true`.
- New `sendDefaultPii` config (default `false`, matching). When `false`, auto-collected
  client IP is dropped/masked; when `true`, the email/IP value scrubbers are disabled and
  client IP is allowed through. Explicit `setUser({ id, email, … })` identity is ALWAYS sent
  verbatim regardless of the flag. The value scrubber is recursion-bounded and fail-open.
- Exports `scrubString`, `scrubValues`, and the `ValueScrubOptions` type.

### Added — Outbound HTTP instrumentation (distributed-trace propagation)
- Global `fetch` wrapper that injects W3C `traceparent` + `baggage` on egress, continuing the active request trace as a child span, and emits a `http.client` span + an `HttpRequestPayload(direction:'outbound')` through the existing transport/redaction/beforeSend pipeline. Installed once, fail-open, gated by `enableOutboundHttp` (default `true`).
- Optional `@nestjs/axios` integration via `instrumentHttpService(httpService)` — does the same on axios requests. `@nestjs/axios`/axios are NOT hard-dependencies; the host passes its `HttpService` in.
- The SDK's own ingest host is always skipped (no self-instrumentation / feedback loop).
- New `tracing.ts` factors the W3C wire-format helpers out of `index.ts` (no behaviour change) and adds an `AsyncLocalStorage`-backed active-trace context the interceptor publishes so egress calls join the in-flight trace.

### Tests
- New suites: `test/session.test.ts`, `test/persistence.test.ts`, `test/outbound.test.ts`,
  `test/outbound-real-nest.test.ts` (end-to-end against NestJS 11 with a real downstream
  server), plus expanded `test/redaction.test.ts` value-pattern coverage. 120/120 vitest pass.

## [0.1.0-beta.3] — 2026-05-18

### Consolidation
Lands the full SDK source on the canonical AllStak repo (transport.ts, redaction.ts, version.ts). Prior beta.1 publish was built from source files that never made it to AllStak/allstak-nestjs on git. No public API change.

### Added — Transport-level wire scrub + canonical denylist parity
- `redaction.ts` extended with 7 canonical terms: bearer, jwt, pwd, credit_card, card_number, cvv, ssn. Now matches the rest of the AllStak ecosystem.
- `transport.ts` scrubs the full payload at the wire chokepoint (before JSON.stringify) — defense-in-depth on top of the existing metadata scrub. Pure, fail-open.

### Live canary E2E
- Event `1c179d5e-965b-4e80-83f1-4c995b02a33d` against `api.allstak.sa`. ClickHouse `leak_pos = 0` across all 4 columns. Canary `should_not_leak_nestjs` planted in 11 fields + 3-level-nested token — all scrubbed.

### Tests
- 14/14 vitest pass.

## [0.1.0-beta.1] - 2026-04-25

### Added
- Initial public release.
