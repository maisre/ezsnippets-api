import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { TemplatesService } from './templates.service';

const ORG = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();
const SNIPPET_A = new Types.ObjectId().toString();
const SNIPPET_B = new Types.ObjectId().toString();

function build(opts: { limits?: any; known?: string[] } = {}) {
  const saved: any[] = [];

  // Stands in for the Mongoose model: `new model(doc)` then `.save()`.
  const templateModel: any = function (doc: any) {
    Object.assign(this, doc);
    this.save = async () => {
      saved.push(doc);
      return doc;
    };
  };
  templateModel.countDocuments = jest.fn().mockReturnValue({
    exec: async () => 0,
  });

  const snippetsService: any = {
    findExistingIds: async (ids: string[]) =>
      new Set(ids.filter((id) => (opts.known ?? [SNIPPET_A, SNIPPET_B]).includes(id))),
  };
  const orgsService: any = {
    isUserMember: async () => true,
    findOne: async () => ({
      // `plan` is what hasActiveSubscription actually gates on.
      plan: 'Pro',
      productId: 'prd_test',
      subscriptionStatus: 'active',
    }),
  };
  const plansService: any = {
    getLimits: () => opts.limits ?? { maxSavedTemplates: -1 },
  };

  const service = new TemplatesService(
    templateModel,
    snippetsService,
    orgsService,
    plansService,
  );

  return { service, saved };
}

describe('TemplatesService.create', () => {
  it('stores only snippet ids, dropping any content a client sends', async () => {
    const { service, saved } = build();

    await service.create(
      {
        name: 'Hero + features',
        kind: 'partial',
        snippetIds: [SNIPPET_A, SNIPPET_B],
        // A client sending overrides shouldn't be able to smuggle content in.
        ...( { textReplacementOverride: [{ token: 't', replacement: 'x' }] } as any),
      } as any,
      ORG,
      USER,
    );

    expect(saved[0].snippetIds).toEqual([SNIPPET_A, SNIPPET_B]);
    expect(saved[0]).not.toHaveProperty('textReplacementOverride');
  });

  it('refuses a template referencing a snippet that does not exist', async () => {
    const { service } = build({ known: [SNIPPET_A] });

    await expect(
      service.create(
        { name: 'Broken', kind: 'page', snippetIds: [SNIPPET_A, SNIPPET_B] } as any,
        ORG,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an empty template', async () => {
    const { service } = build();

    await expect(
      service.create({ name: 'Nothing', kind: 'page', snippetIds: [] } as any, ORG, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps nav, footer and subpages for a layout template', async () => {
    const { service, saved } = build();

    await service.create(
      {
        name: 'Restaurant site',
        kind: 'layout',
        nav: SNIPPET_A,
        footer: SNIPPET_B,
        subPages: [{ name: 'Home', snippetIds: [SNIPPET_A] }],
      } as any,
      ORG,
      USER,
    );

    expect(saved[0].nav).toBe(SNIPPET_A);
    expect(saved[0].footer).toBe(SNIPPET_B);
    expect(saved[0].subPages).toEqual([{ name: 'Home', snippetIds: [SNIPPET_A] }]);
  });

  it('blocks saving on a tier with no saved-template allowance', async () => {
    const { service } = build({ limits: { maxSavedTemplates: 0 } });

    await expect(
      service.create(
        { name: 'Mine', kind: 'partial', snippetIds: [SNIPPET_A] } as any,
        ORG,
        USER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TemplatesService.snippetIdsOf', () => {
  const { service } = build();

  it('flattens a layout template across nav, footer and subpages', () => {
    expect(
      service.snippetIdsOf({
        kind: 'layout',
        nav: 'n',
        footer: 'f',
        subPages: [{ snippetIds: ['a'] }, { snippetIds: ['b', 'c'] }],
      }),
    ).toEqual(['n', 'f', 'a', 'b', 'c']);
  });

  it('returns the flat list for a page template', () => {
    expect(service.snippetIdsOf({ kind: 'page', snippetIds: ['a', 'b'] })).toEqual([
      'a',
      'b',
    ]);
  });
});
