import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { paymentsProviders } from './payments.providers';
import { OrgsModule } from '../orgs/orgs.module';
import { PlansModule } from '../plans/plans.module';
import { PaddleModule } from '../paddle/paddle.module';
import { DatabaseModule } from '../database/database.module';

@Module({})
export class PaymentsModule {
  static forRootAsync(): DynamicModule {
    return {
      module: PaymentsModule,
      controllers: [PaymentsController],
      imports: [
        ConfigModule.forRoot(),
        PaddleModule,
        OrgsModule,
        PlansModule,
        DatabaseModule,
      ],
      providers: [
        ...paymentsProviders,
        PaymentsService,
        // API key and environment now live in PaddleModule, which owns the
        // shared client. Only the webhook secret is payments-specific.
        {
          provide: 'PADDLE_WEBHOOK_SECRET',
          useFactory: (configService: ConfigService) =>
            configService.get('PADDLE_WEBHOOK_SECRET'),
          inject: [ConfigService],
        },
        {
          provide: 'EMAIL_QUEUE_URL',
          useFactory: (configService: ConfigService) =>
            configService.get('EMAIL_QUEUE_URL'),
          inject: [ConfigService],
        },
      ],
    };
  }
}
