import * as mongoose from 'mongoose';

/**
 * A pending invitation to join a team org. The emailed link carries a raw
 * token; only its sha256 is stored, the same way password resets are, so a
 * database read can't be turned into a way in.
 *
 * Accepted invites are kept (acceptedAt set) as a record of who let whom in;
 * revoked ones are deleted. Pending = no acceptedAt and not yet expired, and
 * pending invites hold a seat — see TeamsService.seatsUsed.
 */
export const OrgInviteSchema = new mongoose.Schema({
  org: { type: mongoose.Schema.Types.ObjectId, ref: 'org', required: true },
  // Lower-cased and trimmed. Accepting requires the signed-in account's email
  // to match, so a forwarded link can't be redeemed by someone else.
  email: { type: String, required: true },
  role: { type: String, enum: ['admin', 'member'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
});

OrgInviteSchema.index({ org: 1, email: 1 });
