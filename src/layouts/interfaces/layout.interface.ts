import { Document, Types } from 'mongoose';
import { SubPage } from './page-content.interface';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export interface Layout extends Document {
  readonly name: string;
  readonly siteName?: string;
  readonly description?: string;
  readonly nav?: SnippetAbstract;
  readonly footer?: SnippetAbstract;
  readonly subPages: SubPage[];
  readonly org: Types.ObjectId;
  readonly createdBy?: Types.ObjectId;
  readonly projectId?: string;
}
