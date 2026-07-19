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
    // Set only when `replacement` is a Shutterstock preview comp. Pages are
    // mockups shown to a client using watermarked comps; once the client
    // approves, this id list is what the licensing hand-off is assembled from.
    //
    // MUST be written atomically with `replacement` — an override replaced by
    // an upload or a different stock image has to clear/overwrite this, or the
    // user would later be told to license an image no longer on their page.
    shutterstockId?: string;
  }>;
  readonly aiCustomized?: boolean;
  // True once image slots have been auto-populated from stock. Tracked
  // separately from aiCustomized so the text and image buttons stay independent.
  readonly aiImagesPopulated?: boolean;
}
