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
