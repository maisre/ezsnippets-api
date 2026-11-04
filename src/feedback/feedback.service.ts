import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Model } from 'mongoose';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import {
  FEEDBACK_KINDS,
  FeedbackKind,
  SNIPPET_REASONS,
  SnippetReason,
} from './schemas/feedback.schema';

export const MAX_MESSAGE_LENGTH = 5000;
/** Generous for a person, low enough that a stuck client can't fill the DB. */
export const MAX_PER_HOUR = 20;
const MAX_CONTEXT_SNIPPETS = 200;

/** Trim and cap an optional string; anything that isn't a string is dropped. */
function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

@Injectable()
export class FeedbackService {
  constructor(@Inject('FEEDBACK_MODEL') private feedbackModel: Model<any>) {}

  async create(
    dto: CreateFeedbackDto,
    user: { userId: string; email?: string; activeOrg: string },
  ): Promise<{ ok: true }> {
    const kind = dto?.kind as FeedbackKind;
    if (!FEEDBACK_KINDS.includes(kind)) {
      throw new BadRequestException('Pick what kind of feedback this is.');
    }
    const message = str(dto.message, MAX_MESSAGE_LENGTH + 1);
    if (!message) {
      throw new BadRequestException('Write a message before sending.');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(
        `Keep it under ${MAX_MESSAGE_LENGTH} characters.`,
      );
    }
    // A reason only means something on snippet feedback.
    const reason =
      kind === 'snippet' &&
      SNIPPET_REASONS.includes(dto.reason as SnippetReason)
        ? dto.reason
        : undefined;

    const recent = await this.feedbackModel.countDocuments({
      user: user.userId,
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
    });
    if (recent >= MAX_PER_HOUR) {
      throw new HttpException(
        'That’s a lot of feedback in one hour — thank you! Try again a bit later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ctx = dto.context ?? {};
    const snippetIds = Array.isArray(ctx.snippetIds)
      ? ctx.snippetIds
          .map((id) => str(id, 64))
          .filter((id): id is string => !!id)
          .slice(0, MAX_CONTEXT_SNIPPETS)
      : [];

    await this.feedbackModel.create({
      user: user.userId,
      org: user.activeOrg,
      email: user.email,
      kind,
      reason,
      message,
      snippet: str(dto.snippet, 64),
      context: {
        url: str(ctx.url, 500),
        page: str(ctx.page, 64),
        layout: str(ctx.layout, 64),
        subPage: str(ctx.subPage, 200),
        snippetIds,
        viewport: str(ctx.viewport, 32),
        userAgent: str(ctx.userAgent, 500),
      },
    });
    return { ok: true };
  }
}
