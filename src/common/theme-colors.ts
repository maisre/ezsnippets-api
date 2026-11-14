import { BadRequestException } from '@nestjs/common';

/**
 * Page theme colours.
 *
 * A page stores its palette as `colorVariables: [{ variable, value, original }]`
 * on the page document. ez-view renders them as a `:root { ... }` override block
 * (view-page/page.controller.ts) and its content editor writes them on save;
 * ez-api writes the same shape from the composer's Theme card.
 *
 * SOURCE OF TRUTH is ez-view, and both lists below must be kept in sync by hand:
 *  - the settable names: `SETTABLE_COLOR_VARIABLES` in
 *    ez-view/src/view-page/page.controller.ts
 *  - the default values: the first `:root` block of
 *    ez-view/src/templates/css-template.txt
 */
export const SETTABLE_COLOR_VARIABLES = [
  '--surface',
  '--on-surface',
  '--primary-color1',
  '--on-primary1',
  '--secondary-color1',
  '--on-secondary1',
  '--accent-color1',
  '--on-accent1',
] as const;

export type SettableColorVariable = (typeof SETTABLE_COLOR_VARIABLES)[number];

/**
 * css-template.txt's value for each settable variable. Stored as `original`
 * on every entry, which is what ez-view's own editor stores there. ez-view
 * re-derives `original` from the template on read, so a stale copy here can't
 * change what renders — it only has to be present, because ez-view's schema
 * marks the field required.
 */
export const DEFAULT_THEME_COLORS: Record<SettableColorVariable, string> = {
  '--surface': '#ffffff',
  '--on-surface': '#15181e',
  '--primary-color1': '#eef1f6',
  '--on-primary1': '#15181e',
  '--secondary-color1': '#1d2a44',
  '--on-secondary1': '#ffffff',
  '--accent-color1': '#8e4e00',
  '--on-accent1': '#ffffff',
};

export interface ColorVariable {
  variable: string;
  value: string;
  original: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate a `PUT /pages/:id/colors` body and build what gets stored.
 *
 * ez-api has no global ValidationPipe, so this is checked by hand (same reason
 * as dto/scratch-pad.dto.ts). It is strict on purpose: these values are written
 * verbatim into a `<style>` block by ez-view, so anything other than a known
 * custom property name and a 6-digit hex colour is rejected rather than
 * escaped. `original` is never taken from the client.
 *
 * The list replaces the page's stored colours wholesale. An empty list clears
 * them, which puts the page back on the template defaults.
 */
export function parseColorVariables(body: unknown): ColorVariable[] {
  const list = (body as any)?.colorVariables;
  if (!Array.isArray(list)) {
    throw new BadRequestException('"colorVariables" must be an array.');
  }

  const seen = new Set<string>();
  return list.map((entry) => {
    const variable = entry?.variable;
    const value = entry?.value;
    if (
      typeof variable !== 'string' ||
      !(SETTABLE_COLOR_VARIABLES as readonly string[]).includes(variable)
    ) {
      throw new BadRequestException(
        `"variable" must be one of: ${SETTABLE_COLOR_VARIABLES.join(', ')}.`,
      );
    }
    if (seen.has(variable)) {
      throw new BadRequestException(`"${variable}" is listed more than once.`);
    }
    seen.add(variable);
    if (typeof value !== 'string' || !HEX.test(value)) {
      throw new BadRequestException(
        `"${variable}" must be a 6-digit hex colour like #1d2a44.`,
      );
    }
    return {
      variable,
      value: value.toLowerCase(),
      original: DEFAULT_THEME_COLORS[variable as SettableColorVariable],
    };
  });
}
