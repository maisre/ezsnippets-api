import * as Sentry from '@sentry/nestjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  release: process.env.RELEASE_SHA,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
