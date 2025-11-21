import { Document } from 'mongoose';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export interface PageContent extends Document {
  readonly title: string;
  readonly snippets: SnippetAbstract[];
}

