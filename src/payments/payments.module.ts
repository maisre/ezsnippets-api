import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({})
export class PaymentsModule {
  static forRootAsync(): DynamicModule {
    return {
      module: PaymentsModule,
      controllers: [PaymentsController],
      imports: [ConfigModule.forRoot()],
      providers: [
        PaymentsService,
        {
          provide: 'STRIPE_API_KEY',
          useFactory: async (configService: ConfigService) =>
            configService.get('STRIPE_API_KEY'),
          inject: [ConfigService],
        },
      ],
    };
  }
}
