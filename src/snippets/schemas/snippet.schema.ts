import * as mongoose from 'mongoose';

export const SnippetSchema = new mongoose.Schema(
  {
    html: String,
    css: String,
    js: String,
    type: String,
    textReplacement: Array<String>,
    imageReplacement: Array<String>,
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
