import { BadRequestException } from '@nestjs/common';
import { OrgsService } from './orgs.service';
import { FAVORITE_SNIPPETS_LIMIT } from './favorites';

// Both ids are validated as ObjectIds, so the fixtures have to be real ones.
const ORG_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';
const SNIPPET_ID = '507f1f77bcf86cd799439013';
const OTHER_SNIPPET_ID = '507f1f77bcf86cd799439014';

/**
 * A stand-in for the org model that honours the two Mongo behaviours the
 * favorites code actually leans on: the `$ne` filter guarding the push, and
 * `$pull`'s remove-if-present. Faking those loosely would let a regression in
 * either one pass the suite.
 */
function buildService(favoriteSnippets: any[] = []) {
  const org: any = { _id: ORG_ID, favoriteSnippets: [...favoriteSnippets] };

  const matchesGuard = (filter: any) => {
    const guard = filter?.['favoriteSnippets.snippetId']?.$ne;
    if (guard === undefined) return true;
    return !org.favoriteSnippets.some((f: any) => f.snippetId === guard);
  };

  const orgModel: any = {
    findById: jest.fn((id: string) => ({
      exec: async () => (id === ORG_ID ? org : null),
    })),
    findOneAndUpdate: jest.fn((filter: any, update: any) => ({
      exec: async () => {
        if (filter._id !== ORG_ID || !matchesGuard(filter)) return null;
        org.favoriteSnippets.push(update.$push.favoriteSnippets);
        return org;
      },
    })),
    findByIdAndUpdate: jest.fn((id: string, update: any) => ({
      exec: async () => {
        if (id !== ORG_ID) return null;
        const { snippetId } = update.$pull.favoriteSnippets;
        org.favoriteSnippets = org.favoriteSnippets.filter(
          (f: any) => f.snippetId !== snippetId,
        );
        return org;
      },
    })),
  };

  return { service: new OrgsService(orgModel), org, orgModel };
}

describe('OrgsService favorites', () => {
  it('starts empty', async () => {
    const { service } = buildService();
    await expect(service.listFavorites(ORG_ID)).resolves.toEqual([]);
  });

  it('adds a favorite with the member who starred it', async () => {
    const { service } = buildService();

    const favorites = await service.addFavorite(ORG_ID, USER_ID, SNIPPET_ID);

    expect(favorites).toHaveLength(1);
    expect(favorites[0].snippetId).toBe(SNIPPET_ID);
    expect(String(favorites[0].createdBy)).toBe(USER_ID);
    expect(favorites[0].addedAt).toBeInstanceOf(Date);
  });

  // A double-clicked star must not produce two rows, and must not surface an
  // error to a user who only sees a toggle.
  it('is idempotent when the same snippet is starred twice', async () => {
    const { service, orgModel } = buildService();

    await service.addFavorite(ORG_ID, USER_ID, SNIPPET_ID);
    const favorites = await service.addFavorite(ORG_ID, USER_ID, SNIPPET_ID);

    expect(favorites).toHaveLength(1);
    // The second call short-circuits on the read; no second write is attempted.
    expect(orgModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  // The guard in the query filter is what protects against a duplicate landing
  // when two requests interleave, so it has to be exercised on its own.
  it('does not duplicate when the guard rejects the write', async () => {
    const { service, org, orgModel } = buildService();

    // Simulate the concurrent starrer: the stored doc already has the row, but
    // the read that the cap check works from saw the list before it landed.
    // The $ne filter is the only thing standing between that and a duplicate.
    org.favoriteSnippets.push({ snippetId: SNIPPET_ID });
    orgModel.findById.mockImplementationOnce(() => ({
      exec: async () => ({ ...org, favoriteSnippets: [] }),
    }));

    const favorites = await service.addFavorite(ORG_ID, USER_ID, SNIPPET_ID);

    expect(orgModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(favorites).toHaveLength(1);
  });

  it('removes a favorite', async () => {
    const { service } = buildService([
      { snippetId: SNIPPET_ID },
      { snippetId: OTHER_SNIPPET_ID },
    ]);

    const favorites = await service.removeFavorite(ORG_ID, SNIPPET_ID);

    expect(favorites.map((f) => f.snippetId)).toEqual([OTHER_SNIPPET_ID]);
  });

  it('treats removing something unfavorited as a no-op success', async () => {
    const { service } = buildService([{ snippetId: OTHER_SNIPPET_ID }]);

    const favorites = await service.removeFavorite(ORG_ID, SNIPPET_ID);

    expect(favorites.map((f) => f.snippetId)).toEqual([OTHER_SNIPPET_ID]);
  });

  it('rejects an add past the cap', async () => {
    const full = Array.from({ length: FAVORITE_SNIPPETS_LIMIT }, (_, i) => ({
      snippetId: `507f1f77bcf86cd7994${String(390 + i).padStart(5, '0')}`,
    }));
    const { service } = buildService(full);

    await expect(
      service.addFavorite(ORG_ID, USER_ID, SNIPPET_ID),
    ).rejects.toThrow(BadRequestException);
  });

  // At the cap, re-starring something already on the list still has to work —
  // otherwise a full list can't be toggled off through the same control.
  it('still accepts a re-add at the cap', async () => {
    const full = Array.from({ length: FAVORITE_SNIPPETS_LIMIT }, (_, i) => ({
      snippetId: `507f1f77bcf86cd7994${String(390 + i).padStart(5, '0')}`,
    }));
    const { service } = buildService(full);

    const favorites = await service.addFavorite(
      ORG_ID,
      USER_ID,
      full[0].snippetId,
    );

    expect(favorites).toHaveLength(FAVORITE_SNIPPETS_LIMIT);
  });

  it('rejects a snippetId that is not an ObjectId', async () => {
    const { service, orgModel } = buildService();

    await expect(
      service.addFavorite(ORG_ID, USER_ID, 'not-an-id'),
    ).rejects.toThrow(BadRequestException);
    expect(orgModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
