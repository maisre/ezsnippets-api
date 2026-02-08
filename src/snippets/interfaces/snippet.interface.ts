import { Document, Types } from 'mongoose';

export interface Snippet extends Document {
  readonly html: String;
  readonly css: String;
  readonly js: String;
  readonly type: String;
  readonly org?: Types.ObjectId;
  readonly createdBy?: Types.ObjectId;
}
