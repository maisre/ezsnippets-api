/**
 * Shared rules for the editor scratch pad.
 *
 * The scratch pad is a shelf on a page or layout holding snippets the user has
 * pulled off while deciding on look and feel. Parked snippets keep their full
 * `SnippetAbstract` — overrides, image replacements and `shutterstockId` — so a
 * park followed by a restore is lossless.
 *
 * Two consequences worth stating once, here, rather than rediscovering them:
 *
 *  - Parked snippets are NOT on the page. They must never reach the finalize
 *    licensing hand-off or the .zip export, or the customer is told to license
 *    images that aren't in what they're shipping.
 *
 *  - Moves are performed server-side (see the services' park/restore methods).
 *    The editor owns membership and order but not the page-scoped
 *    customizations — that is the whole reason PagesService.mergeSnippets
 *    exists — so a client-driven move would drop overrides on the floor.
 */

/**
 * Most parked snippets carry image overrides, and the page document is loaded
 * in full every time the editor opens. Twenty is roomy for deciding between
 * candidates while keeping the document small enough that nobody notices.
 */
export const SCRATCH_PAD_LIMIT = 20;

export const SCRATCH_PAD_FULL_MESSAGE =
  `Scratch pad is full (${SCRATCH_PAD_LIMIT}). ` +
  `Restore or remove something before parking another snippet.`;

/**
 * Bounds-check an index against an array length.
 *
 * Every scratch pad route addresses snippets positionally, so an out-of-range
 * index is the normal failure mode for a stale editor tab — two tabs open on
 * the same page, one parks, the other still shows the old list. It has to read
 * as a 400 the editor can recover from, not a 500.
 */
export function isValidIndex(index: unknown, length: number): boolean {
  return (
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < length
  );
}

/**
 * Where a restored snippet lands in a target array.
 *
 * Unlike the indexes above, an insertion point is legitimately allowed to equal
 * the array length — that means "append", which is where a restore with no
 * explicit position should go.
 */
export function clampInsertIndex(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index)) return length;
  if (index < 0) return 0;
  if (index > length) return length;
  return index;
}
