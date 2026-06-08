// Centralized "can this principal edit this resource?" check. Authorize by
// RESOURCE scope, never by "is a logged-in user" — this is what keeps a future
// 3rd-party guest token (scoped to a single page) a cheap, additive change.

export interface EditPrincipal {
  // A normal user's active org (edits anything that org owns).
  activeOrg?: string;
  // Future: a guest token scoped to exactly one page.
  guestPageId?: string;
}

export function canEditPage(
  principal: EditPrincipal,
  page: { _id: unknown; org: unknown },
): boolean {
  if (principal.guestPageId) {
    return String(principal.guestPageId) === String(page._id);
  }
  return (
    !!principal.activeOrg && String(page.org) === String(principal.activeOrg)
  );
}
