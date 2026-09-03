import * as mongoose from 'mongoose';

/**
 * A template is a **blank arrangement of snippets** — ordered snippet ids and
 * nothing else. No text, no images, no overrides.
 *
 * That's deliberate. Carrying content would mean copying Shutterstock comp ids
 * (watermarked previews) into every site spun up from a template, which turns
 * the licensing hand-off at finalize into a mess; it would also go stale
 * whenever the underlying snippet changed. Blank also means previews come free:
 * a template card is a stack of the snippet thumbnails already on the assets
 * CDN, so there's no capture pipeline for templates at all.
 *
 * Three kinds, one document:
 *   partial — a couple of snippets that work well together, inserted mid-edit
 *   page    — a whole page's worth of snippets
 *   layout  — one nav + one footer + named subpages, i.e. a whole site shell
 *
 * `partial` and `page` are identical in shape and differ only in intent and how
 * the UI offers them (insert vs. start-from). They're kept separate so the
 * palette can present them as different things.
 *
 * Ownership matches the snippets collection: no `org` means a built-in library
 * template visible to everyone; an `org` means that org saved it.
 */
const SubPageTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    snippetIds: { type: [String], default: [] },
  },
  { _id: false },
);

export const TemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, required: false },
    kind: {
      type: String,
      enum: ['partial', 'page', 'layout'],
      required: true,
    },
    // Free-form category, mirroring snippet.type ('landing', 'about', ...).
    // Drives the filter chips in the palette.
    type: { type: String, required: false },
    tags: { type: [String], default: [] },

    // kind: 'partial' | 'page'
    snippetIds: { type: [String], default: [] },

    // kind: 'layout'. nav and footer are bare snippet id strings, matching how
    // LayoutSchema actually stores them (see layout-edit's updateLayout).
    nav: { type: String, required: false },
    footer: { type: String, required: false },
    subPages: { type: [SubPageTemplateSchema], default: [] },

    // Absent on built-in library templates; set on ones an org saved.
    org: { type: mongoose.Schema.Types.ObjectId, ref: 'org', required: false },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: false,
    },

    // Soft delete, matching pages and layouts. Null (or absent) means live.
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: any) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// The list query is always "library templates plus mine", narrowed by kind.
TemplateSchema.index({ org: 1, kind: 1, deletedAt: 1 });
