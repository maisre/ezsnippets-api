import * as mongoose from 'mongoose';

/**
 * A customer-owned hostname that serves this org's pages through ez-view.
 *
 * Its own collection rather than an array on the org doc: the hostname needs a
 * unique index across *every* org (two customers must not be able to claim the
 * same name), and ez-view looks a hostname up on every single page request, so
 * it wants its own indexed collection to hit.
 */
export const CustomDomainSchema = new mongoose.Schema(
  {
    org: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'org',
      required: true,
      index: true,
    },
    // Always stored lowercased — the service normalises before writing, and
    // ez-view lowercases the request Host before looking up.
    hostname: { type: String, required: true, unique: true },
    // pending: created, DNS not confirmed yet (nothing is served).
    // active:  CNAME confirmed; ez-view serves this org's pages here and the
    //          Caddy ask endpoint will approve a certificate for it.
    // failed:  repeated verification failures — see lastError.
    status: {
      type: String,
      enum: ['pending', 'active', 'failed'],
      default: 'pending',
    },
    // Why the last check failed, surfaced verbatim in the account UI so the
    // customer can fix their DNS without contacting support.
    lastError: { type: String, default: null },
    // Consecutive failures. A single flaky resolver must not take a live
    // customer site down, so the cron only flips active -> failed after this
    // crosses a threshold.
    failureCount: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: false,
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
