import * as mongoose from 'mongoose';
import { SubPage } from '../interfaces/page-content.interface';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export const LayoutSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    siteName: { type: String, required: false },
    description: { type: String, required: false },
    aiCustomized: { type: Boolean, required: false, default: false },
    nav: { type: Object, required: false },
    footer: { type: Object, required: false },
    subPages: Array<SubPage>,
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
