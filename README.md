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
