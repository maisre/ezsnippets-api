import * as mongoose from 'mongoose';
import { SnippetAbstract } from '../interfaces/snippet-abstract.interface';

export const PageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    siteName: { type: String, required: false },
    description: { type: String, required: false },
    // Which text variant the page renders: lorem placeholder, generic English,
    // or the AI/user customized override stored per-token on each snippet
    // abstract. Defaults to 'generic' so pages preview representative English.
    textVariant: {
      type: String,
      enum: ['lorem', 'generic', 'customized'],
      default: 'generic',
    },
    snippets: Array<SnippetAbstract>,
    org: { type: mongoose.Schema.Types.ObjectId, ref: 'org', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: false },
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
