import { Document } from 'mongoose';
import { SnippetAbstract } from './snippet-abstract.interface';

export interface Page extends Document {
  readonly snippets: SnippetAbstract[];
}
