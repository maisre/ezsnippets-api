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
  // Page-scoped image overrides (uploaded/stock image URLs chosen in the
  // editor). Stored on the page, never on the shared snippet.
  readonly imageReplacementOverride?: Array<{
    token: string;
    replacement: string;
  }>;
  readonly aiCustomized?: boolean;
}
