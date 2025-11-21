import { Document, Types } from 'mongoose';
import { PageContent } from './page-content.interface';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export interface Layout extends Document {
  readonly name: string;
  readonly nav?: SnippetAbstract;
  readonly footer?: SnippetAbstract;
  readonly pageContent: PageContent[];
  readonly owner: Types.ObjectId;
  readonly projectId?: string;
}
