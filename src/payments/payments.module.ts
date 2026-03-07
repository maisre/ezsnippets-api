import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { OrgsModule } from '../orgs/orgs.module';

@Module({})
export class PaymentsModule {
  static forRootAsync(): DynamicModule {
    return {
      module: PaymentsModule,
      controllers: [PaymentsController],
      imports: [ConfigModule.forRoot(), OrgsModule],
      providers: [
        PaymentsService,
        {
          provide: 'STRIPE_API_KEY',
          useFactory: (configService: ConfigService) =>
            configService.get('STRIPE_API_KEY'),
          inject: [ConfigService],
        },
        {
          provide: 'STRIPE_WEBHOOK_SECRET',
          useFactory: (configService: ConfigService) =>
            configService.get('STRIPE_WEBHOOK_SECRET'),
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
