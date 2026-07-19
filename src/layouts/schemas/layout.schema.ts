import * as mongoose from 'mongoose';
import { SubPage } from '../interfaces/page-content.interface';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export const LayoutSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    siteName: { type: String, required: false },
    description: { type: String, required: false },
    nav: { type: Object, required: false },
    footer: { type: Object, required: false },
    subPages: Array<SubPage>,
    // Archived layouts are parked: they stop counting toward the org's plan
    // limit but stay listed in the dashboard and can be restored (which
    // re-checks the limit).
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },
    // Soft delete. Null (or absent, on pre-existing documents) means live.
    deletedAt: { type: Date, default: null },
    org: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'org',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: false,
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
