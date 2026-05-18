# @allstak/nestjs

**AllStak error tracking and request telemetry for NestJS.**

[![npm version](https://img.shields.io/npm/v/@allstak/nestjs.svg)](https://www.npmjs.com/package/@allstak/nestjs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

AllStak SDK for NestJS (beta) — captures errors, inbound request telemetry, and distributed traces via a NestJS module. Independently installable with no dependency on other `@allstak/*` packages at runtime.

## Installation

```sh
npm install @allstak/nestjs
```

## Quick Start (Module pattern — recommended)

Use `AllStakModule.forRoot()` for automatic global registration of the
interceptor and exception filter:

```ts
import { Module } from "@nestjs/common";
import { AllStakModule } from "@allstak/nestjs";

@Module({
  imports: [
    AllStakModule.forRoot({
      dsn: process.env.ALLSTAK_DSN,
      endpoint: "https://api.allstak.sa",
      release: process.env.RELEASE,
      environment: process.env.NODE_ENV,
      serviceName: "my-api",
    }),
  ],
})
export class AppModule {}
```

This registers `AllStakNestInterceptor` (via `APP_INTERCEPTOR`) and
`AllStakNestExceptionFilter` (via `APP_FILTER`) globally. No additional
provider wiring is needed.

## Manual Wiring (alternative)

If you prefer explicit control, you can register the interceptor and filter
as providers yourself:

```ts
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { AllStakNestInterceptor, AllStakNestExceptionFilter } from "@allstak/nestjs";

const allstakConfig = {
  dsn: process.env.ALLSTAK_DSN,
  endpoint: "https://api.allstak.sa",
  release: process.env.RELEASE,
  environment: process.env.NODE_ENV,
};

@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useFactory: () => new AllStakNestInterceptor(allstakConfig) },
    { provide: APP_FILTER, useFactory: () => new AllStakNestExceptionFilter(allstakConfig) },
  ],
})
export class AppModule {}
```

## Configuration Reference

| Option          | Type     | Default                   | Description                                  |
| --------------- | -------- | ------------------------- | -------------------------------------------- |
| `apiKey`        | `string` | —                         | AllStak API key (alternative to `dsn`)       |
| `dsn`           | `string` | —                         | AllStak DSN (alternative to `apiKey`)        |
| `host`          | `string` | `https://api.allstak.sa`  | Ingest API base URL (alternative to `endpoint`) |
| `endpoint`      | `string` | `https://api.allstak.sa`  | Ingest API base URL (alternative to `host`)  |
| `environment`   | `string` | `""`                      | Environment tag (e.g. `production`, `staging`) |
| `release`       | `string` | `""`                      | Release/version identifier                   |
| `serviceName`   | `string` | `""`                      | Logical service name for filtering           |

Either `apiKey` or `dsn` must be set — without one, telemetry is silently dropped.

## Trace Propagation

The interceptor automatically participates in W3C `traceparent` propagation.
Inbound requests carrying `traceparent`, `x-allstak-trace-id`, or
`x-request-id` headers are honored, and every response includes `traceparent`,
`x-allstak-trace-id`, and `x-allstak-request-id` headers for downstream
continuation.

Trace context is attached to the request object as `req.allstakTraceId`,
`req.allstakSpanId`, and `req.allstakRequestId`.

## License

MIT © AllStak

## Production readiness

### Install

`npm install @allstak/nestjs`

### Quick Start

Use the minimal setup shown above in this README, set an AllStak API key through environment/configuration, and verify telemetry in a non-production project before enabling it for users. Do not hardcode API keys in source code.

### Configuration

Configure the API key, ingest host, environment, release, service name, sample rates, and optional capture settings explicitly for each deployment. Default production host is `https://api.allstak.sa` unless this SDK documents otherwise.

### Environment Variables

Prefer environment variables for secrets and deployment-specific values: `ALLSTAK_API_KEY`, `ALLSTAK_HOST`, `ALLSTAK_ENVIRONMENT`, `ALLSTAK_RELEASE`, and SDK-specific build/source-map tokens where applicable. Client-side frameworks must only expose public client keys using their framework-specific public env var conventions.

### Framework Compatibility

NestJS >=9 is declared. Runtime package tests cover core interceptor/filter behavior, but public stable certification is incomplete.

### What Data Is Captured

Depending on the SDK and enabled integrations, AllStak can capture exceptions, logs, breadcrumbs, HTTP request metadata, traces/spans, release/environment tags, user context supplied by the application, cron/job heartbeat status, and source-map artifact metadata. Body/header capture is optional where supported and should stay disabled unless explicitly needed.

### Privacy / PII / Redaction

Do not send secrets, passwords, tokens, payment data, national IDs, or raw request/response bodies unless the SDK documentation for this package explicitly says the field is redacted and the behavior has been verified in your app. Authorization, cookie, token, password, secret, API key, and similar fields should be masked by default where capture is implemented. Add `beforeSend`/filter hooks or equivalent application-side scrubbing for domain-specific PII.

### Production Safety

The SDK must fail open: telemetry failures must not crash or materially block the host application. Keep queues bounded, retries bounded, debug logging off in production, and capture rates conservative until overhead is measured in your application. Live dashboard certification was **not verified** in the 2026-05-17 release-gate audit because live credentials were not available.

### Troubleshooting

If telemetry is missing, verify the package version, API key, ingest host, environment, release, network access to `https://api.allstak.sa`, sampling settings, framework integration order, and whether the SDK is disabled after an auth failure. For source maps, verify release/dist values and artifact upload responses.

### Release / Source Map Setup

Server-side source maps are not production-certified for this SDK.

### Version Compatibility

Keep the package manifest version, runtime SDK version constant, changelog entry, git tag, and registry version aligned. Do not publish from a dirty checkout.

### Known Limitations

Published on npm as a beta package. Keep beta labeling until live NestJS dashboard proof and docs are complete. Live dashboard proof, performance overhead, retry-storm behavior, and full production hardening must be revalidated before claiming production-stable readiness.

### Stability Status

Current status: **experimental beta**. This SDK is not production-stable unless a later certification report explicitly says so with live dashboard evidence.

