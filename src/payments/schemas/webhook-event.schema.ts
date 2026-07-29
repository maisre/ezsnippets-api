import * as mongoose from 'mongoose';

// One record per Paddle webhook event we've accepted. Paddle retries failed
// deliveries (up to 60 times over 3 days on live) and doesn't promise it won't
// deliver the same event twice, so the unique index on eventId is what stops a
// replay from re-sending emails or re-applying a stale status.
export const WebhookEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  eventType: { type: String, required: true },
  occurredAt: { type: Date },
  // Paddle gives up retrying after 3 days, so a month-old record can't still be
  // needed for dedup. TTL index keeps the collection from growing forever.
  createdAt: { type: Date, default: Date.now, expires: '30d' },
});
