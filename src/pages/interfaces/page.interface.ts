import { Document, Types } from 'mongoose';
import { SnippetAbstract } from './snippet-abstract.interface';

export interface Page extends Document {
  readonly name: string;
  readonly siteName?: string;
  readonly description?: string;
  readonly textVariant?: 'lorem' | 'generic' | 'customized';
  readonly status?: 'active' | 'archived';
  readonly deletedAt?: Date | null;

  readonly snippets: SnippetAbstract[];
  readonly org: Types.ObjectId;
  readonly createdBy?: Types.ObjectId;

  // Screenshot lifecycle (see page.schema.ts).
  readonly contentUpdatedAt?: Date;
  readonly screenshotAt?: Date | null;
  readonly thumbnailUrl?: string | null;
  readonly screenshotQueuedFor?: Date | null;
  readonly screenshotQueuedAt?: Date | null;
}
