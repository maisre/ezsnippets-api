import * as mongoose from 'mongoose';

// A starred library snippet. `_id` is off because the entry is already keyed by
// snippetId — an extra ObjectId per row would be one more field the editor has
// to ignore, and one more thing to accidentally start treating as the key.
const FavoriteSnippetSchema = new mongoose.Schema(
  {
    snippetId: { type: String, required: true },
    // Who starred it. In a shared Agency workspace "who added this?" is the
    // first question asked about someone else's shortlist entry.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export const OrgSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    personal: { type: Boolean, default: false },
    members: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'user',
          required: true,
        },
        role: {
          type: String,
          enum: ['owner', 'admin', 'member'],
          required: true,
        },
      },
    ],
    paddleCustomerId: { type: String },
    subscriptionId: { type: String },
    plan: { type: String },
    productId: { type: String },
    subscriptionStatus: { type: String },
    cardBrand: { type: String },
    cardLast4: { type: String },
    cardExpMonth: { type: Number },
    cardExpYear: { type: Number },
    currentPeriodEnd: { type: Number },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    subscriptionEventAt: { type: Date },
    billingBlocked: { type: Boolean, default: false },
    // Local mirror of Paddle adjustments (refunds, credits, chargebacks) so
    // billing questions can be answered from the org doc instead of the Paddle
    // dashboard. Paddle remains the system of record. Capped at the most recent
    // 20 by recordBillingEvent, and stripped from API responses below.
    billingEvents: [
      {
        action: { type: String },
        amount: { type: String },
        currency: { type: String },
        status: { type: String },
        reason: { type: String },
        adjustmentId: { type: String },
        transactionId: { type: String },
        occurredAt: { type: Date },
      },
    ],
    // Snippet ids the org has starred in the editor palette. Ids only — see
    // favorites.ts for why. Unlike billingEvents this stays in the API
    // response: the palette reads it straight off the org the client already
    // holds, rather than paying for a second round trip to render a star.
    favoriteSnippets: [FavoriteSnippetSchema],
  },
  {
    toJSON: {
      transform: (_doc, ret: any) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        // GET /orgs returns this doc to every member of the org, not just
        // owners — the billing log is for us, not for them.
        delete ret.billingEvents;
        return ret;
      },
    },
  },
);
