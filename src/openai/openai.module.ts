import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OpenaiService } from './openai.service';

@Module({})
export class OpenaiModule {
  static forRootAsync(): DynamicModule {
    return {
      module: OpenaiModule,
      imports: [ConfigModule.forRoot()],
      providers: [
        OpenaiService,
        {
          provide: 'OPENAI_API_KEY',
          useFactory: async (configService: ConfigService) =>
            configService.get('OPENAI_API_KEY'),
          inject: [ConfigService],
        },
      ],
      exports: [OpenaiService],
    };
  }
}
