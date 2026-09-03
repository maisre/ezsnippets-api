import { Document } from 'mongoose';

export type TemplateKind = 'partial' | 'page' | 'layout';

export interface SubPageTemplate {
  readonly name: string;
  readonly snippetIds: string[];
}

export interface Template extends Document {
  readonly name: string;
  readonly description?: string;
  readonly kind: TemplateKind;
  readonly type?: string;
  readonly tags: string[];
  readonly snippetIds: string[];
  readonly nav?: string;
  readonly footer?: string;
  readonly subPages: SubPageTemplate[];
  readonly org?: any;
  readonly createdBy?: any;
  readonly deletedAt: Date | null;
}
