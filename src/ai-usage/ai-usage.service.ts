import {
  Inject,
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { AiUsageDoc } from './schemas/ai-usage.schema';
import { AI_USAGE_MODEL } from './ai-usage.providers';

/**
 * The AI operations we meter. A closed set rather than a free string because the
 * name becomes a key inside the `ops` sub-document, and Mongo field names can't
 * contain dots or start with `$`.
 */
export type AiOperation =
  | 'page.customize'
  | 'page.customize-images'
  | 'layout.customize'
  | 'layout.customize-images'
  | 'chat.snippet-edit'
  | 'chat.image-search';

/** Ceiling when AI_DAILY_LIMIT is unset. */
export const DEFAULT_AI_DAILY_LIMIT = 1000;

/** UTC calendar day. UTC, not local, so the reset point doesn't move with DST. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Per-org daily ceiling on AI requests.
 *
 * This exists because every AI call bills us per request to a third party, and
 * until this was written nothing anywhere in the stack counted them — an account
 * could run the customize endpoint in a loop and the first we'd know was the
 * OpenAI invoice. The Terms of Service give us grounds to act on that; this
 * gives us the means.
 *
 * The limit is intentionally set far above expected use. It's a backstop against
 * runaway cost, not a product limit — the `ops` breakdown in the collection is
 * there so we can replace this guess with a real number, per plan, once we can
 * see what people actually do.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);
  private readonly dailyLimit: number;

  constructor(
    @Inject(AI_USAGE_MODEL) private readonly aiUsageModel: Model<AiUsageDoc>,
    configService: ConfigService,
  ) {
    const configured = Number(configService.get('AI_DAILY_LIMIT'));
    this.dailyLimit =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_AI_DAILY_LIMIT;
  }

  /**
   * Record one AI request against an org and refuse it if the org is over its
   * ceiling for the day.
   *
   * Increments first and checks the result, rather than reading then writing:
   * two requests arriving together would both pass a read-first check. The cost
   * of that ordering is that refused attempts still increment `count`, which is
   * why `blocked` is tracked alongside it.
   *
   * @throws HttpException 429 when the org is over its daily ceiling.
   */
  async consume(org: string, operation: AiOperation): Promise<void> {
    if (!org) {
      // No org means no way to attribute the cost. Callers are all
      // authenticated, so this is a programming error rather than a user one.
      this.logger.warn(`AI operation ${operation} attempted with no org`);
      return;
    }

    const day = utcDay();
    const doc = await this.increment(org, day, operation);

    if (doc.count > this.dailyLimit) {
      await this.aiUsageModel
        .updateOne({ org, day }, { $inc: { blocked: 1 } })
        .exec();
      this.logger.warn(
        `Org ${org} over AI daily limit (${doc.count}/${this.dailyLimit}) on ${operation}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message:
            "You've hit today's limit for AI requests. It resets at midnight UTC — if you need a higher ceiling, email support@ez-snippets.com.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Today's usage for an org, or null if it hasn't used AI today. */
  async getUsage(org: string, day: string = utcDay()): Promise<AiUsageDoc | null> {
    return this.aiUsageModel.findOne({ org, day }).lean<AiUsageDoc>().exec();
  }

  /** The ceiling in force, so callers can report it without re-reading config. */
  get limit(): number {
    return this.dailyLimit;
  }

  /**
   * Atomic upsert-and-increment. Concurrent upserts on a brand-new org-day race
   * on the unique index and one of them loses with a duplicate-key error; by
   * then the document exists, so the retry is guaranteed to take the update
   * path.
   */
  private async increment(
    org: string,
    day: string,
    operation: AiOperation,
  ): Promise<AiUsageDoc> {
    const update = {
      $inc: { count: 1, [`ops.${opKey(operation)}`]: 1 },
      $set: { updatedAt: new Date() },
      $setOnInsert: { blocked: 0 },
    };

    const apply = () =>
      this.aiUsageModel
        .findOneAndUpdate({ org, day }, update, { upsert: true, new: true })
        .lean<AiUsageDoc>()
        .exec();

    let doc: AiUsageDoc | null;
    try {
      doc = await apply();
    } catch (error: unknown) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      // Lost the race to create the document. It exists now, so this retry
      // takes the update path and can't collide again.
      doc = await apply();
    }

    if (!doc) {
      // `upsert: true, new: true` always yields a document; if it somehow
      // didn't, we can't prove the org is under its ceiling, so don't pretend.
      throw new Error(`Could not record AI usage for org ${org} on ${day}`);
    }
    return doc;
  }
}

/**
 * Operation name as a Mongo field name. The dots in `page.customize` would be
 * read as a path and nest the counter three levels deep, so they become
 * underscores and `ops` stays a flat map of `page_customize -> count`.
 */
function opKey(operation: AiOperation): string {
  return operation.replace(/\./g, '_');
}
