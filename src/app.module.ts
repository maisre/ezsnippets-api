import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { isDirectInternalRequest } from './common/trust-proxy';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PagesModule } from './pages/pages.module';
import { SnippetsModule } from './snippets/snippets.module';
import { PaymentsModule } from './payments/payments.module';
import { LayoutsModule } from './layouts/layouts.module';
import { RedisModule } from './redis/redis.module';
import { OrgsModule } from './orgs/orgs.module';
import { TeamsModule } from './teams/teams.module';
import { PlansModule } from './plans/plans.module';
import { SqsModule } from './sqs/sqs.module';
import { UploadsModule } from './uploads/uploads.module';
import { TemplatesModule } from './templates/templates.module';
import { DomainsModule } from './domains/domains.module';
import { FeedbackModule } from './feedback/feedback.module';

const UNTHROTTLED_PATHS = new Set([
  '/payments/webhook',
  '/domains/caddy-check',
  '/domains/reverify',
]);

@Module({
  imports: [
    SentryModule.forRoot(),
    // Per client IP (see common/trust-proxy), in memory — fine for the single
    // box; counters reset on deploy. The default is a ceiling against floods
    // and scraping, high enough that an office or a carrier NAT sharing one IP
    // never notices: a dashboard load is ~10 calls, the editor's heartbeat one
    // a few minutes. Auth routes set much tighter limits (AppController).
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      // Machine callers with fixed source IPs: Paddle's webhook (retries can
      // burst), and Caddy's TLS ask + the background cron, both secret-gated
      // and arriving from a single internal address.
      // Also any container calling ez-api directly over the compose network
      // (see isDirectInternalRequest) — those share one internal IP.
      skipIf: (ctx) => {
        const req = ctx.switchToHttp().getRequest<Request>();
        return UNTHROTTLED_PATHS.has(req.path) || isDirectInternalRequest(req);
      },
    }),
    SqsModule,
    RedisModule,
    AuthModule,
    UsersModule,
    PagesModule,
    SnippetsModule,
    PaymentsModule.forRootAsync(),
    LayoutsModule,
    OrgsModule,
    TeamsModule,
    PlansModule,
    UploadsModule,
    TemplatesModule,
    DomainsModule,
    FeedbackModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    AppService,
  ],
})
export class AppModule {}
