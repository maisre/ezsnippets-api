import { canEditPage } from './edit-access';

describe('canEditPage', () => {
  const page = { _id: 'page1', org: 'orgA' };

  it('allows a user whose active org owns the page', () => {
    expect(canEditPage({ activeOrg: 'orgA' }, page)).toBe(true);
  });

  it('denies a user from a different org', () => {
    expect(canEditPage({ activeOrg: 'orgB' }, page)).toBe(false);
  });

  it('denies a principal with no org and no guest scope', () => {
    expect(canEditPage({}, page)).toBe(false);
  });

  it('allows a guest token scoped to this exact page', () => {
    expect(canEditPage({ guestPageId: 'page1' }, page)).toBe(true);
  });

  it('denies a guest token scoped to a different page', () => {
    expect(canEditPage({ guestPageId: 'page2' }, page)).toBe(false);
  });
});
