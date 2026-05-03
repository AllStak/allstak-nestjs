# @allstak/nestjs

Beta standalone AllStak SDK for NestJS request and exception capture.

This package is independently installable and does not depend on another `@allstak/*` SDK at runtime.

```sh
npm install @allstak/nestjs@beta
```

```ts
import { AllStakNestExceptionFilter, AllStakNestInterceptor } from "@allstak/nestjs";

const options = {
  dsn: process.env.ALLSTAK_DSN,
  endpoint: "https://api.allstak.sa",
  release: process.env.RELEASE,
  environment: process.env.NODE_ENV,
};
```
