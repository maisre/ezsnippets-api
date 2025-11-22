import * as mongoose from 'mongoose';
import { SubPage } from '../interfaces/page-content.interface';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export const LayoutSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    nav: { type: Object, required: false },
    footer: { type: Object, required: false },
    subPages: Array<SubPage>,
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
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
