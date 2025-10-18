import { Document, Types } from 'mongoose';
import { SnippetAbstract } from './snippet-abstract.interface';

export interface Page extends Document {
  readonly name: string;
  readonly projectId?: Types.ObjectId;
  readonly snippets: SnippetAbstract[];
  readonly owner: Types.ObjectId;
}
