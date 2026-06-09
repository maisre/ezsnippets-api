import * as Sentry from '@sentry/nestjs';

const environment = process.env.SENTRY_ENVIRONMENT || 'development';

// In development, reporting is off unless SENTRY_ENABLE_DEV=true — this lets a
// DSN live permanently in your local .env without spamming the project. Staging
// and prod set SENTRY_ENVIRONMENT via the deploy, so they're always on (the flag
// only applies to the development environment and can't silence them).
const enabled =
  !!process.env.SENTRY_DSN &&
  (environment !== 'development' || process.env.SENTRY_ENABLE_DEV === 'true');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled,
  environment,
  release: process.env.RELEASE_SHA,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
