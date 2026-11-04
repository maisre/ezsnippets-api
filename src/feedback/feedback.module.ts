import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { feedbackProviders } from './feedback.provider';

@Module({
  imports: [DatabaseModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, ...feedbackProviders],
})
export class FeedbackModule {}
