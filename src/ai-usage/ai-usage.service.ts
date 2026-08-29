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
 * The ceiling is now per-plan: callers pass the org's `aiDailyLimit` from
 * PlanLimits. AI_DAILY_LIMIT, when set, overrides every tier — it's the local
 * testing hatch and the emergency global clamp, not the normal path. When
 * neither is available the DEFAULT_AI_DAILY_LIMIT backstop applies, which is
 * deliberately far above expected use: an unresolved plan should not stop a
 * paying customer working, it should just stop a runaway loop.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);
  private readonly configuredLimit: number | null;

  constructor(
    @Inject(AI_USAGE_MODEL) private readonly aiUsageModel: Model<AiUsageDoc>,
    configService: ConfigService,
  ) {
    const configured = Number(configService.get('AI_DAILY_LIMIT'));
    this.configuredLimit =
      Number.isFinite(configured) && configured > 0 ? configured : null;
  }

  /**
   * The ceiling actually applied to a request: the global override if one is
   * configured, else the tier's allowance, else the backstop.
   */
  limitFor(tierLimit?: number): number {
    if (this.configuredLimit !== null) return this.configuredLimit;
    if (tierLimit !== undefined && Number.isFinite(tierLimit) && tierLimit > 0) {
      return tierLimit;
    }
    return DEFAULT_AI_DAILY_LIMIT;
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
   * @param tierLimit the org's `aiDailyLimit` from its plan. Optional so that
   *   a caller that can't resolve a plan still gets the backstop rather than
   *   no metering at all.
   * @throws HttpException 429 when the org is over its daily ceiling.
   */
  async consume(
    org: string,
    operation: AiOperation,
    tierLimit?: number,
  ): Promise<void> {
    if (!org) {
      // No org means no way to attribute the cost. Callers are all
      // authenticated, so this is a programming error rather than a user one.
      this.logger.warn(`AI operation ${operation} attempted with no org`);
      return;
    }

    const day = utcDay();
    const limit = this.limitFor(tierLimit);
    const doc = await this.increment(org, day, operation);

    if (doc.count > limit) {
      await this.aiUsageModel
        .updateOne({ org, day }, { $inc: { blocked: 1 } })
        .exec();
      this.logger.warn(
        `Org ${org} over AI daily limit (${doc.count}/${limit}) on ${operation}`,
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
