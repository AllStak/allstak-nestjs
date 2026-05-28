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
- Unhandled exceptions with stack traces.
- Server spans for each request.
- Trace propagation response headers for downstream services.

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

## Release health

`AllStakModule.forRoot(...)` opens a single release-health session per process
on module init (`/ingest/v1/sessions/start`) and closes it on graceful shutdown
(`/ingest/v1/sessions/end`) with the final status (`ok` / `errored` / `crashed`).
Sessions are never sampled and the whole path is fail-open. Call
`app.enableShutdownHooks()` so the closing event fires. Set
`enableAutoSessionTracking: false` to opt out.

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
