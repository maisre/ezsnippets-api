import { ConflictException } from '@nestjs/common';
import { Connection, Types } from 'mongoose';

/**
 * Pages and layouts share ONE URL namespace on a custom domain: both are served
 * from the root as `view.theirs.com/<slug>`. So a slug has to be unique across
 * both collections within an org, which no single-collection index can express.
 *
 * Each collection keeps its own partial unique index — that is what atomically
 * prevents two pages (or two layouts) colliding. This adds the cross-collection
 * half: before writing, check the *other* collection.
 *
 * The residual race (two simultaneous writes claiming the same slug, one on a
 * page and one on a layout) is left unguarded rather than adding a third
 * collection and a transaction for it. It is a single-org self-inflicted edge
 * case, and ez-view's resolver is deterministic about the outcome — it checks
 * pages before layouts — so the URL still resolves to exactly one thing.
 */
export async function assertSlugAvailable(
  connection: Connection,
  orgId: string,
  slug: string,
  otherCollection: 'pages' | 'layouts',
): Promise<void> {
  const clash = await connection
    .collection(otherCollection)
    .findOne({ org: new Types.ObjectId(orgId), slug });

  if (clash) {
    const kind = otherCollection === 'pages' ? 'page' : 'site';
    throw new ConflictException(`A ${kind} already uses "${slug}".`);
  }
}
