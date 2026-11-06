export class CustomizeImagesDto {
  /**
   * 'quick' (default in the editor): one Shutterstock search for `keywords`,
   * results handed out by slot shape, no AI. 'smart' (the default when omitted,
   * so older clients keep today's behaviour): OpenAI writes a query per slot,
   * falling back to quick if OpenAI fails.
   */
  mode?: 'quick' | 'smart';

  /**
   * Quick-fill search keywords, e.g. "craft brewery taproom". When blank, the
   * site name (or page/layout name) is used instead.
   */
  keywords?: string;

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
