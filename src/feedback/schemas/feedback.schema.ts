import * as mongoose from 'mongoose';

export const FEEDBACK_KINDS = ['bug', 'snippet', 'idea', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** Only asked when the feedback is about a snippet. */
export const SNIPPET_REASONS = ['broken', 'content', 'wish', 'other'] as const;
export type SnippetReason = (typeof SNIPPET_REASONS)[number];

export const FEEDBACK_STATUSES = ['unread', 'read', 'done'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/**
 * One piece of user feedback. One-way: nothing here is shown back to the user.
 * Reviewed with scripts/feedback.js, which lists `unread` items and can mark
 * them read.
 *
 * `context` is captured by the client so a report can be reproduced without
 * asking. From an editor it carries the page or layout and the snippet ids on
 * it, in order — enough to re-render what the user was looking at.
 */
export const FeedbackSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    org: { type: mongoose.Schema.Types.ObjectId, ref: 'org', required: true },
    // Copied in so a review doesn't need a join just to see who wrote it.
    email: { type: String },
    kind: { type: String, enum: FEEDBACK_KINDS, required: true },
    reason: { type: String, enum: SNIPPET_REASONS },
    message: { type: String, required: true },
    // The library snippet the feedback is about, when the user picked one.
    snippet: { type: String },
    context: {
      url: String,
      page: String,
      layout: String,
      subPage: String,
      snippetIds: [String],
      viewport: String,
      userAgent: String,
    },
    status: {
      type: String,
      enum: FEEDBACK_STATUSES,
      default: 'unread',
      index: true,
    },
  },
  {
    timestamps: true,
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
