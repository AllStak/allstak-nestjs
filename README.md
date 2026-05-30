# @allstak/nestjs

AllStak SDK for NestJS. Adds a global interceptor and exception filter for request telemetry, errors, spans, and trace propagation.

## Install

```bash
npm install @allstak/nestjs
```

Peer dependencies:

```bash
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Setup

```ts
import { Module } from '@nestjs/common';
import { AllStakModule } from '@allstak/nestjs';

@Module({
  imports: [
    AllStakModule.forRoot({
      apiKey: process.env.ALLSTAK_API_KEY,
      environment: process.env.NODE_ENV ?? 'production',
      release: process.env.ALLSTAK_RELEASE,
      serviceName: 'api',
      captureRequestHeaders: true,
    }),
  ],
})
export class AppModule {}
```

## Async config

```ts
AllStakModule.forRootAsync({
  useFactory: () => ({
    apiKey: process.env.ALLSTAK_API_KEY,
    environment: process.env.NODE_ENV ?? 'production',
    release: process.env.ALLSTAK_RELEASE,
    serviceName: 'api',
  }),
});
```

## What is captured

- Inbound HTTP request telemetry.
- Outbound HTTP request telemetry (global `fetch`, plus optional `@nestjs/axios`).
- Unhandled exceptions with stack traces.
- Process-level fatal errors (uncaught exceptions / unhandled rejections) that escape the request pipeline.
- Database queries (opt-in Prisma / TypeORM instrumentation) with the active trace.
- Server + client spans for each request and downstream call.
- W3C `traceparent` + `baggage` propagation on inbound responses AND outbound calls.

## Configuration

| Option | Description |
| --- | --- |
| `apiKey` | Project API key. |
| `dsn` | Alias for `apiKey`. |
| `environment` | Deployment environment. |
| `release` | App version or commit SHA. |
| `serviceName` | Logical service name. |
| `captureRequestHeaders` | Capture redacted inbound headers. Default: `false`. |
| `beforeSend` | Optional hook to modify or drop outbound telemetry. |
| `enableAutoSessionTracking` | Open one release-health session per process on startup and close it on shutdown. Default: `true`. |
| `platform` | Platform tag on the session start payload. Default: `node`. |
| `userId` | User id attached to the session start payload when known at init. |
| `enableOfflineQueue` | Persist undeliverable telemetry to a bounded filesystem spool and replay it on the next init. Default: `true`. |
| `offlineQueueDir` | Spool directory. Default: `<os.tmpdir()>/allstak-nestjs-spool`. |
| `enableOutboundHttp` | Instrument outbound HTTP (global `fetch`): inject trace headers on egress and emit outbound spans/requests. Default: `true`. |
| `enableGlobalErrorHandlers` | Install `process.on('uncaughtException'/'unhandledRejection')` so fatal errors that escape the request pipeline are captured at `fatal` level and the session is marked crashed. Default: `true`. |
| `enableDbInstrumentation` | Gate the opt-in `instrumentPrisma()` / `instrumentDataSource()` ORM query instrumentation. Default: `true`. |

## Release health

`AllStakModule.forRoot(...)` opens a single release-health session per process
on module init (`/ingest/v1/sessions/start`) and closes it on graceful shutdown
(`/ingest/v1/sessions/end`) with the final status (`ok` / `errored` / `crashed`).
Sessions are never sampled and the whole path is fail-open. Call
`app.enableShutdownHooks()` so the closing event fires. Set
`enableAutoSessionTracking: false` to opt out.

## Offline queue

When telemetry cannot be delivered (network outage, retry exhausted, or the
process shuts down with events still buffered) the SDK persists the
**already-redacted** wire body to a bounded filesystem spool
(`<os.tmpdir()>/allstak-nestjs-spool` by default) instead of dropping it. On the
next init it asynchronously drains the spool and re-sends each entry through the
normal transport, removing it only once accepted (2xx) or permanently
undeliverable (a 4xx other than 429). The spool is bounded by count, total
bytes, and max age, evicting the oldest entries first. Session lifecycle calls
(`/sessions/start`, `/sessions/end`) are live-only and never persisted. If the
spool directory is not writable (read-only FS, serverless, edge runtime with no
`fs`) the SDK degrades silently to in-memory — it never throws or blocks init.
Set `enableOfflineQueue: false` to opt out, or `offlineQueueDir` to point at a
durable path.

## Outbound HTTP tracing

Distributed traces only stay connected if egress carries the trace context. The
SDK wraps the global `fetch` so every outbound call made while handling a request
becomes a **child span of that request's trace**: it injects W3C `traceparent` +
`baggage` (continuing the inbound trace id and sampled flag) and emits a
`http.client` span plus an outbound HTTP request row. The SDK's own ingest host
is always skipped, and the wrapper is fully fail-open — an instrumentation error
never breaks the caller's request. Set `enableOutboundHttp: false` to opt out.

For `@nestjs/axios` (an optional/peer integration the SDK never hard-depends on),
instrument the `HttpService` once after the module is registered:

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { instrumentHttpService } from '@allstak/nestjs';

@Injectable()
export class HttpTracing implements OnModuleInit {
  constructor(private readonly http: HttpService) {}
  onModuleInit(): void {
    instrumentHttpService(this.http); // axios requests now propagate the trace
  }
}
```

## Global error handlers

The interceptor and exception filter only see errors that flow through the
NestJS request pipeline. A truly unhandled error thrown off that path — in a
timer, an event-emitter callback, or a forgotten `await` — would otherwise
terminate the process with nothing captured. On module init the SDK installs
`process.on('uncaughtException')` and `process.on('unhandledRejection')` so such
a failure is captured at `fatal` level, the release-health session is marked
`crashed`, and buffered telemetry is flushed before exit.

Node's existing behaviour is preserved: for an uncaught exception the SDK
re-emits out-of-band **only** when it is the sole listener (so Node's default
crash-and-exit still applies); when your app has its own `uncaughtException`
listener the SDK does not force an exit — your handler owns that decision.
Unhandled rejections are captured without changing the process's rejection mode.
The whole path is fail-open. Set `enableGlobalErrorHandlers: false` to opt out.

## Database queries (Prisma / TypeORM)

Opt-in ORM instrumentation emits a `/ingest/v1/db` row for every query —
normalized SQL (literal values stripped to `?`, so no parameter values leave the
process), duration, status, and the **active request trace/span ids** so a query
made while handling a request becomes a child of that request's trace. Prisma
and TypeORM are optional/peer integrations the SDK never hard-depends on; you
pass your client / data-source in once, mirroring `instrumentHttpService()`.

```ts
// Prisma — $extends returns a NEW client, so assign it back.
import { instrumentPrisma } from '@allstak/nestjs';
prisma = instrumentPrisma(prisma);

// TypeORM — attaches a query logger to your DataSource.
import { instrumentDataSource } from '@allstak/nestjs';
instrumentDataSource(dataSource);
```

Both helpers are idempotent and fail-open. Set `enableDbInstrumentation: false`
to make them no-ops.

## Privacy

Sensitive header and metadata keys are redacted before telemetry is sent. Add `redactKeys` for application-specific fields.

## Troubleshooting

- No request events: confirm `AllStakModule.forRoot(...)` is imported by your root module.
- No errors: confirm no custom exception filter is swallowing exceptions before global filters run.
- Missing correlation: preserve incoming `traceparent`, `baggage`, and `x-request-id` headers at your proxy.

## Contributing and Support

- Report bugs with the GitHub bug report template: https://github.com/AllStak/allstak-nestjs/issues/new/choose
- Open pull requests using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT
