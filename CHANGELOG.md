# Changelog

All notable changes to @allstak/nestjs will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
