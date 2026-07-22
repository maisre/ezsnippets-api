export class CustomizeDto {
  /**
   * Restrict the run to snippets that were never AI text-customized (added
   * after an earlier run). Snippets already marked aiCustomized keep their
   * existing text overrides untouched. Omit/false to re-customize everything.
   */
  onlyMissing?: boolean;
}
