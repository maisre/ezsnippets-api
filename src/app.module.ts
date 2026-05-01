import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
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
import { PlansModule } from './plans/plans.module';
import { SqsModule } from './sqs/sqs.module';

@Module({
  imports: [
    SentryModule.forRoot(),
    SqsModule,
    RedisModule,
    AuthModule,
    UsersModule,
    PagesModule,
    SnippetsModule,
    PaymentsModule.forRootAsync(),
    LayoutsModule,
    OrgsModule,
    PlansModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    AppService,
  ],
})
export class AppModule {}
