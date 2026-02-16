import * as mongoose from 'mongoose';
import { SnippetAbstract } from '../interfaces/snippet-abstract.interface';

export const PageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    siteName: { type: String, required: false },
    description: { type: String, required: false },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: false,
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
