import * as mongoose from 'mongoose';

export const PlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    priceIds: [{ type: String }],
    limits: {
      maxPages: { type: Number, required: true },
      maxLayouts: { type: Number, required: true },
      maxSnippets: { type: Number, required: true },
    },
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
