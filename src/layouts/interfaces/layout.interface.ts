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
  readonly status?: 'active' | 'archived';
  readonly deletedAt?: Date | null;
  readonly org: Types.ObjectId;
  readonly createdBy?: Types.ObjectId;

  // Screenshot lifecycle (see layout.schema.ts).
  readonly contentUpdatedAt?: Date;
  readonly screenshotAt?: Date | null;
  readonly thumbnailUrl?: string | null;
  readonly screenshotQueuedFor?: Date | null;
  readonly screenshotQueuedAt?: Date | null;
}
