import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Environment, Paddle } from '@paddle/paddle-node-sdk';

export const PADDLE_CLIENT = 'PADDLE_CLIENT';

/**
 * One Paddle client for the app. Both billing (webhooks, checkout, portal) and
 * the price catalog talk to Paddle, and neither should own the env plumbing.
 *
 * Constructed even when PADDLE_API_KEY is unset so the app still boots locally
 * without billing configured — calls fail at request time, which the catalog
 * degrades around and the payments endpoints surface as errors.
 */
@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    {
      provide: PADDLE_CLIENT,
      useFactory: (configService: ConfigService) =>
        new Paddle(configService.get('PADDLE_API_KEY') ?? '', {
          environment:
            configService.get('PADDLE_ENVIRONMENT') === 'production'
              ? Environment.production
              : Environment.sandbox,
        }),
      inject: [ConfigService],
    },
  ],
  exports: [PADDLE_CLIENT],
})
export class PaddleModule {}
