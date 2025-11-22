import * as mongoose from 'mongoose';
import { SnippetAbstract } from '../interfaces/snippet-abstract.interface';

export const PageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: false,
    },
    snippets: Array<SnippetAbstract>,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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
