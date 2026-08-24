import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { AiUsageService } from './ai-usage.service';
import { aiUsageProviders } from './ai-usage.providers';

@Module({
  imports: [ConfigModule.forRoot(), DatabaseModule],
  providers: [AiUsageService, ...aiUsageProviders],
  exports: [AiUsageService],
})
export class AiUsageModule {}
