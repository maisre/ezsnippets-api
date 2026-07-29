import * as mongoose from 'mongoose';

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
