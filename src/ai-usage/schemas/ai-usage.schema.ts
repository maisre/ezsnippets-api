import * as mongoose from 'mongoose';

/**
 * One document per org per UTC day, holding every AI request that org made.
 *
 * The point of this collection is as much measurement as enforcement. The
 * ceiling we launch with is a guess — deliberately far above what we think
 * normal use looks like — and `ops` is what tells us where to move it once real
 * accounts have been using the feature for a while.
 *
 * `count` is incremented on every *attempt*, including the ones we then refuse,
 * because the increment has to happen before we know the answer for the check to
 * be race-free. `blocked` records how many of those were refused, so genuine
 * usage is `count - blocked` and a hammering client is visible as the gap
 * between the two.
 */
export interface AiUsageDoc {
  org: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  count: number;
  blocked: number;
  /** Per-operation attempt counts, e.g. `{ page_customize: 12 }`. */
  ops: Record<string, number>;
  updatedAt?: Date;
}

export const AiUsageSchema = new mongoose.Schema(
  {
    org: { type: String, required: true },
    day: { type: String, required: true },
    count: { type: Number, default: 0 },
    blocked: { type: Number, default: 0 },
    ops: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date },
  },
  { versionKey: false },
);

// The counter's correctness depends on there being exactly one document per
// org-day: without this, two concurrent upserts can each create their own and
// the ceiling is silently doubled.
AiUsageSchema.index({ org: 1, day: 1 }, { unique: true });

// Supports "what did everyone do on day X" when we come back to set real limits.
AiUsageSchema.index({ day: 1 });
