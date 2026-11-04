import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

/** Logged-in users only. Write-only from the client's side. */
@UseGuards(JwtAuthGuard)
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  create(@Body() dto: CreateFeedbackDto, @Request() req) {
    return this.feedbackService.create(dto, req.user);
  }
}
