import * as mongoose from 'mongoose';
import { SubPage } from '../interfaces/page-content.interface';
import { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export const LayoutSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    siteName: { type: String, required: false },
    description: { type: String, required: false },
    nav: { type: Object, required: false },
    footer: { type: Object, required: false },
    subPages: Array<SubPage>,
    // Editor scratch pad, layout-wide rather than per-subpage: parking a hero
    // off Home and dropping it on About is the main thing this buys. Same type
    // as a subpage's `snippets`, so a park or restore is an array move and
    // overrides survive intact.
    //
    // Capped at SCRATCH_PAD_LIMIT, and excluded from getLicensing() and the
    // .zip export: a parked snippet is not on the layout. See
    // common/scratch-pad.
    scratchPad: { type: Array<SnippetAbstract>, default: [] },
    // Archived layouts are parked: they stop counting toward the org's plan
    // limit but stay listed in the dashboard and can be restored (which
    // re-checks the limit).
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },
    // Human-readable URL segment, served from the root of the org's custom
    // domain (view.theirs.com/stans-hvac). Shares one namespace with page
    // slugs — see common/slug-conflict.ts. Null means id-only access.
    slug: { type: String, default: null },
    // Soft delete. Null (or absent, on pre-existing documents) means live.
    deletedAt: { type: Date, default: null },
    org: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'org',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: false,
    },

    // --- Dashboard thumbnail / screenshot lifecycle ---
    // Mirrors the fields on PageSchema; see page.schema.ts for the full
    // rationale (why contentUpdatedAt is separate from `updatedAt`, etc.).
    // NOTE: ez-view has no standalone layout render route yet, so the
    // ez-background scanner does not enqueue layouts today — these fields are
    // in place so the worker can pick them up once that route exists.
    contentUpdatedAt: { type: Date, default: Date.now },
    screenshotAt: { type: Date, default: null },
    thumbnailUrl: { type: String, default: null },
    screenshotQueuedFor: { type: Date, default: null },
    screenshotQueuedAt: { type: Date, default: null },
  },
  {
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

LayoutSchema.index({ contentUpdatedAt: 1, screenshotAt: 1 });

// Unique per ORG, not globally: the custom hostname already identifies the org.
// Partial so the many layouts with no slug don't all collide on null.
LayoutSchema.index(
  { org: 1, slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
);
