import { Document } from 'mongoose';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export interface SubPage extends Document {
  readonly name: string;
  readonly snippets: SnippetAbstract[];
}
