/**
 * Shared rules for org-wide favorite snippets.
 *
 * Favorites are a shortlist the editor's snippet palette pins to the top. They
 * hang off the org rather than the user on purpose: every other piece of
 * content in this product is org-owned, and the Agency tier sells the org as a
 * shared team workspace — a shortlist one designer builds is meant to be the
 * shortlist their teammate opens. A solo customer's org is their personal org,
 * so the same field reads as a personal list without a second code path.
 *
 * Only the snippet id is stored. Copying the snippet body in would freeze a
 * point-in-time copy of library content that we edit in bulk, and would carry
 * `shutterstockId`s into a document that has nothing to do with licensing.
 */

/**
 * A shortlist is a shortlist. The cap exists less to bound the document — a
 * hundred ids is a few KB on a doc that already carries billing history — than
 * to stop "favorite" from degrading into a second copy of the library, which is
 * what a palette section with no ceiling turns into.
 */
export const FAVORITE_SNIPPETS_LIMIT = 100;

export const FAVORITES_FULL_MESSAGE =
  `You've favorited the maximum of ${FAVORITE_SNIPPETS_LIMIT} snippets. ` +
  `Remove one before adding another.`;
