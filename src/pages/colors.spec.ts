import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PagesService } from './pages.service';
import {
  DEFAULT_THEME_COLORS,
  SETTABLE_COLOR_VARIABLES,
  parseColorVariables,
} from '../common/theme-colors';

// The service validates both ids as ObjectIds, so fixtures need real ones.
const PAGE_ID = '507f1f77bcf86cd799439011';
const ORG_ID = '507f1f77bcf86cd799439012';

// The "Midnight" palette from the composer's Theme card.
const MIDNIGHT: Record<string, string> = {
  '--surface': '#0c0f14',
  '--on-surface': '#e8ebf2',
  '--primary-color1': '#181d29',
  '--on-primary1': '#e8ebf2',
  '--secondary-color1': '#4a5a85',
  '--on-secondary1': '#ffffff',
  '--accent-color1': '#e8912b',
  '--on-accent1': '#15181e',
};

const body = (colors: Record<string, string>) => ({
  colorVariables: Object.entries(colors).map(([variable, value]) => ({
    variable,
    value,
  })),
});

function buildService(stored: any | null) {
  const calls: Array<{ filter: any; set: any }> = [];
  const pageModel: any = {
    findOneAndUpdate: (filter: any, update: any) => {
      calls.push({ filter, set: update.$set });
      if (stored) Object.assign(stored, update.$set);
      return { exec: async () => stored };
    },
  };
  const pubsub: any = { publish: jest.fn().mockResolvedValue(undefined) };
  const noop: any = {};
  const service = new PagesService(
    pageModel,
    pubsub,
    noop, // openai
    noop, // snippets
    noop, // orgs
    noop, // plans
    noop, // shutterstock
    noop, // aiUsage
    noop, // templates
  );
  return { service, calls, pubsub };
}

describe('parseColorVariables', () => {
  it('accepts a full palette and stores the template default as original', () => {
    const parsed = parseColorVariables(body(MIDNIGHT));

    expect(parsed).toHaveLength(8);
    for (const entry of parsed) {
      expect(entry.value).toBe(MIDNIGHT[entry.variable]);
      expect(entry.original).toBe(
        DEFAULT_THEME_COLORS[entry.variable as keyof typeof DEFAULT_THEME_COLORS],
      );
    }
  });

  it('produces what ez-view reads back', () => {
    // ez-view's schema requires all three fields as non-empty strings, its save
    // DTO accepts only `--name` variables with 6-digit hex values, and its
    // renderer writes `${variable}: ${value};` into a :root block. Anything
    // stored here has to satisfy all three, or the page editor either fails
    // validation on its next save or renders a broken declaration.
    for (const entry of parseColorVariables(body(MIDNIGHT))) {
      expect(Object.keys(entry).sort()).toEqual(['original', 'value', 'variable']);
      expect(entry.variable).toMatch(/^--[\w-]+$/);
      expect(entry.value).toMatch(/^#[0-9a-f]{6}$/);
      expect(entry.original).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has a default for every settable variable', () => {
    expect(Object.keys(DEFAULT_THEME_COLORS).sort()).toEqual(
      [...SETTABLE_COLOR_VARIABLES].sort(),
    );
  });

  it('lowercases hex values', () => {
    const [entry] = parseColorVariables(body({ '--surface': '#ABCDEF' }));
    expect(entry.value).toBe('#abcdef');
  });

  it('never trusts a client-supplied original', () => {
    const [entry] = parseColorVariables({
      colorVariables: [
        { variable: '--surface', value: '#000000', original: 'red; } body { x' },
      ],
    });
    expect(entry.original).toBe('#ffffff');
  });

  it('accepts an empty list (back to the template defaults)', () => {
    expect(parseColorVariables({ colorVariables: [] })).toEqual([]);
  });

  it.each([
    ['a missing body', undefined],
    ['a missing list', {}],
    ['a non-array list', { colorVariables: { '--surface': '#ffffff' } }],
    ['an unknown variable', body({ '--gray-100': '#ffffff' })],
    ['a non-variable name', body({ color: '#ffffff' })],
    ['3-digit hex', body({ '--surface': '#fff' })],
    ['8-digit hex', body({ '--surface': '#ffffffff' })],
    ['a named colour', body({ '--surface': 'white' })],
    ['rgb()', body({ '--surface': 'rgb(0, 0, 0)' })],
    ['a CSS injection', body({ '--surface': '#ffffff; } body { display: none' })],
    ['a non-string value', { colorVariables: [{ variable: '--surface', value: 0 }] }],
    ['a null entry', { colorVariables: [null] }],
    [
      'a duplicate variable',
      {
        colorVariables: [
          { variable: '--surface', value: '#ffffff' },
          { variable: '--surface', value: '#000000' },
        ],
      },
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => parseColorVariables(input)).toThrow(BadRequestException);
  });
});

describe('PagesService.setColorVariables', () => {
  it('writes the palette, scoped to the org, and marks the page changed', async () => {
    const stored: any = { colorVariables: [], contentUpdatedAt: new Date(0) };
    const { service, calls, pubsub } = buildService(stored);
    const colors = parseColorVariables(body(MIDNIGHT));

    const result = await service.setColorVariables(PAGE_ID, ORG_ID, colors);

    expect(calls).toHaveLength(1);
    // Org-scoped and blind to soft-deleted pages: another org's page id must
    // read as "not found", not get repainted.
    expect(calls[0].filter).toEqual({ _id: PAGE_ID, org: ORG_ID, deletedAt: null });
    expect(calls[0].set.colorVariables).toEqual(colors);
    // The thumbnail pipeline keys off contentUpdatedAt.
    expect(calls[0].set.contentUpdatedAt.getTime()).toBeGreaterThan(0);
    // Nothing but the palette and the timestamp is touched.
    expect(Object.keys(calls[0].set).sort()).toEqual([
      'colorVariables',
      'contentUpdatedAt',
    ]);
    expect(result.colorVariables).toEqual(colors);
    expect(pubsub.publish).toHaveBeenCalledWith('page-updates', {
      action: 'updated',
      roomId: PAGE_ID,
    });
  });

  it('404s when the page is not in the org', async () => {
    const { service, pubsub } = buildService(null);

    await expect(
      service.setColorVariables(PAGE_ID, ORG_ID, []),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('404s on a malformed id without querying', async () => {
    const { service, calls } = buildService({});

    await expect(
      service.setColorVariables('not-an-id', ORG_ID, []),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toHaveLength(0);
  });
});
