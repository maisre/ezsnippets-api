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
          provide: 'PADDLE_API_KEY',
          useFactory: (configService: ConfigService) =>
            configService.get('PADDLE_API_KEY'),
          inject: [ConfigService],
        },
        {
          provide: 'PADDLE_WEBHOOK_SECRET',
          useFactory: (configService: ConfigService) =>
            configService.get('PADDLE_WEBHOOK_SECRET'),
          inject: [ConfigService],
        },
        {
          provide: 'PADDLE_ENVIRONMENT',
          useFactory: (configService: ConfigService) =>
            configService.get('PADDLE_ENVIRONMENT') ?? 'sandbox',
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
