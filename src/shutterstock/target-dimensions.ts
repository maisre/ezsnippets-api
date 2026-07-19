/**
 * Intended slot dimensions for the snippet library's image placeholder tokens,
 * used to pick the stock result whose aspect ratio best fits the slot.
 *
 * DUPLICATE: ez-view holds the same table in
 * src/image-resolver/image-resolver.service.ts, where it drives the
 * placehold.co fallback at render time. Keep the two in sync when the snippet
 * library gains new image tokens — a token missing here just means no aspect
 * preference (see targetAspectFor), so a drift degrades quietly rather than
 * breaking.
 */
const TARGET_DIMENSIONS = new Map<string, string>([
  ['image::1', '600x400'],
  ['image::2', '800x835'],
  ['image::3', '300x200'],
  ['image::4', '800x533'],
  ['image::5', '1920x1300'],
  ['image::6', '120x60'],
  ['image::7', '128x128'],
  ['image::8', '60x60'],
  ['image::9', '300x300'],
  ['image::10', '180x60'],
  ['image::11', '400x300'],
  ['image::12', '400x400'],
  ['image::13', '150x50'],
  ['image::14', '500x333'],
  ['image::15', '400x225'],
  ['image::16', '200x200'],
  ['image::17', '600x450'],
  ['image::18', '500x350'],
  ['image::19', '80x80'],
  ['image::20', '120x80'],
  ['image::21', '150x150'],
  ['image::22', '6000x3977'],
  ['image::23', '2340x3223'],
  ['image::24', '3673x5207'],
  ['image::25', '3836x2874'],
  ['image::26', '4480x6509'],
  ['image::27', '350x300'],
]);

/**
 * Target aspect (width / height) for a placeholder token, or null when the
 * token is unknown — in which case the caller should not express a preference
 * rather than guessing.
 */
export function targetAspectFor(replacement: string): number | null {
  const dims = TARGET_DIMENSIONS.get(replacement);
  if (!dims) return null;

  const [w, h] = dims.split('x').map(Number);
  if (!w || !h) return null;
  return w / h;
}

/**
 * Coarse shape label for a slot, used to steer the search query itself
 * (Shutterstock ranks very differently for "banner" vs "portrait" subjects).
 */
export function slotShapeFor(replacement: string): 'wide' | 'tall' | 'square' | null {
  const aspect = targetAspectFor(replacement);
  if (aspect === null) return null;
  if (aspect >= 1.4) return 'wide';
  if (aspect <= 0.75) return 'tall';
  return 'square';
}
