export class CustomizeImagesDto {
  /**
   * Optional art direction folded into the query-derivation prompt, e.g.
   * "warm, natural light, no people". Never passed to Shutterstock verbatim.
   */
  direction?: string;

  /**
   * By default only empty image slots are filled, so images a user picked by
   * hand survive. Set true to redo every slot.
   */
  replaceExisting?: boolean;

  /**
   * Restrict the run to snippets that were never AI image-populated (added
   * after an earlier run). Snippets already marked aiImagesPopulated are left
   * untouched. Independent of replaceExisting, which controls per-slot redo.
   */
  onlyMissing?: boolean;
}
