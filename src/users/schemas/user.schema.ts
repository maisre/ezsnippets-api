import * as mongoose from 'mongoose';

export const UserSchema = new mongoose.Schema({
  id: Number,
  email: String,
  password: String,
  activeOrg: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'org',
    required: false,
  },
  // Incremented whenever the password changes. Embedded in issued JWTs and
  // checked on every request so a password reset invalidates existing tokens.
  tokenVersion: {
    type: Number,
    default: 0,
  },
});
