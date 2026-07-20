import * as mongoose from 'mongoose';
import { SnippetAbstract } from '../interfaces/snippet-abstract.interface';

export const PageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    siteName: { type: String, required: false },
    description: { type: String, required: false },
    // Which text variant the page renders: lorem placeholder, generic English,
    // or the AI/user customized override stored per-token on each snippet
    // abstract. Defaults to 'generic' so pages preview representative English.
    textVariant: {
      type: String,
      enum: ['lorem', 'generic', 'customized'],
      default: 'generic',
    },
    snippets: Array<SnippetAbstract>,
    // Archived pages are parked: they stop counting toward the org's plan limit
    // and stop rendering publicly in ez-view, but stay listed in the dashboard
    // and can be restored (which re-checks the limit).
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },
    // Soft delete. Null (or absent, on pre-existing documents) means live.
    deletedAt: { type: Date, default: null },
    org: { type: mongoose.Schema.Types.ObjectId, ref: 'org', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: false },

    // --- Dashboard thumbnail / screenshot lifecycle ---
    // See ez-background/src/consumers/screenshot for the debounced capture job.
    //
    // contentUpdatedAt is bumped ONLY when rendered content changes (see the
    // service's touchContent()). It is deliberately NOT Mongoose's `updatedAt`:
    // ez-background writes thumbnailUrl/screenshotAt back on this same document,
    // and if that write moved contentUpdatedAt it would re-trigger a capture
    // forever. The screenshot worker never writes contentUpdatedAt.
    contentUpdatedAt: { type: Date, default: Date.now },
    // Stamped by the worker to the contentUpdatedAt value it captured. When it
    // is null or older than contentUpdatedAt, a fresh screenshot is owed.
    screenshotAt: { type: Date, default: null },
    // Rendered card image (the frontend dashboard already reads this).
    thumbnailUrl: { type: String, default: null },
    // Enqueue bookkeeping so a burst of ticks can't re-send the same job while
    // one is in flight; screenshotQueuedAt doubles as a lease so a render that
    // dies gets picked up again. See screenshot.cron.ts.
    screenshotQueuedFor: { type: Date, default: null },
    screenshotQueuedAt: { type: Date, default: null },
  },
  {
    toJSON: {
      transform: (_doc, ret: any) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Backs the ez-background scanner's "which docs are due for a screenshot?"
// query: it filters/sorts on contentUpdatedAt and compares against screenshotAt.
PageSchema.index({ contentUpdatedAt: 1, screenshotAt: 1 });
