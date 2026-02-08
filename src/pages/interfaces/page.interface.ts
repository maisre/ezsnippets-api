import { Document, Types } from 'mongoose';
import { SnippetAbstract } from './snippet-abstract.interface';

export interface Page extends Document {
  readonly name: string;
  readonly siteName?: string;
  readonly description?: string;
  readonly aiCustomized?: boolean;
  readonly projectId?: Types.ObjectId;
  readonly snippets: SnippetAbstract[];
  readonly org: Types.ObjectId;
  readonly createdBy?: Types.ObjectId;
}
