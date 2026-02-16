import { Document } from 'mongoose';

export interface SnippetAbstract extends Document {
  readonly id: String;
  readonly cssOverride: String;
  readonly jsOverride: String;
  readonly htmlOverride: {};
  readonly textReplacementOverride?: Array<{
    token: string;
    replacement: string;
  }>;
  readonly aiCustomized?: boolean;
}
