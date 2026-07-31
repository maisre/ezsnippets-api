import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import { PaddleEnv } from '../plans/plan-catalog';

export const PADDLE_CLIENT = 'PADDLE_CLIENT';
export const PADDLE_ENV = 'PADDLE_ENV';

/**
 * One Paddle client and one environment for the app.
 *
 * PADDLE_ENV is resolved here and injected everywhere else — including the
 * product-id lookup in plan-catalog.ts — so the client and the entitlement
 * mapping cannot end up pointing at different Paddle accounts. That
 * combination would look configured and put every real subscription on the
 * fallback tier.
 *
 * The client is constructed even when PADDLE_API_KEY is unset so the app still
 * boots locally without billing configured; calls fail at request time, which
 * the catalog degrades around.
 */
@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    {
      provide: PADDLE_ENV,
      useFactory: (configService: ConfigService): PaddleEnv =>
        configService.get('PADDLE_ENVIRONMENT') === 'production'
          ? 'production'
          : 'sandbox',
      inject: [ConfigService],
    },
    {
      provide: PADDLE_CLIENT,
      useFactory: (env: PaddleEnv, configService: ConfigService) =>
        new Paddle(configService.get('PADDLE_API_KEY') ?? '', {
          environment:
            env === 'production' ? Environment.production : Environment.sandbox,
        }),
      inject: [PADDLE_ENV, ConfigService],
    },
  ],
  exports: [PADDLE_CLIENT, PADDLE_ENV],
})
export class PaddleModule {}
