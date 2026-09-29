import { Types } from 'mongoose';
import { TeamsService } from './teams.service';

const OWNER = new Types.ObjectId().toString();
const MEMBER = new Types.ObjectId().toString();
const ORG = new Types.ObjectId().toString();

function setup(orgOverrides: Record<string, unknown> = {}) {
  const org = {
    _id: ORG,
    name: 'Studio',
    personal: false,
    members: [
      { user: new Types.ObjectId(OWNER), role: 'owner' },
      { user: new Types.ObjectId(MEMBER), role: 'member' },
    ],
    ...orgOverrides,
  };
  const inviteModel = {
    deleteMany: jest.fn().mockReturnValue({ exec: () => Promise.resolve({}) }),
  };
  const orgsService = {
    findOne: jest.fn().mockResolvedValue(org),
    markDeleted: jest.fn().mockResolvedValue(undefined),
    findPersonalOrg: jest.fn().mockResolvedValue({ _id: 'personal' }),
  };
  const usersService = {
    findById: jest.fn().mockResolvedValue({ activeOrg: ORG }),
    updateActiveOrg: jest.fn().mockResolvedValue(undefined),
  };
  const authService = { issueSessionToken: jest.fn().mockResolvedValue('tok') };
  const removal = () => ({ removeAllForOrg: jest.fn().mockResolvedValue(1) });
  const [pages, layouts, templates, domains] = [removal(), removal(), removal(), removal()];

  const service = new TeamsService(
    inviteModel as any,
    'queue',
    'http://frontend',
    orgsService as any,
    usersService as any,
    {} as any,
    authService as any,
    {} as any,
    pages as any,
    layouts as any,
    templates as any,
    domains as any,
  );
  return { service, org, inviteModel, orgsService, usersService, pages, layouts, templates, domains };
}

describe('TeamsService.deleteTeam', () => {
  it('refuses anyone but the owner', async () => {
    const { service, orgsService } = setup();
    await expect(service.deleteTeam(ORG, MEMBER, 'Studio')).rejects.toThrow('permission');
    expect(orgsService.markDeleted).not.toHaveBeenCalled();
  });

  it('refuses a personal workspace', async () => {
    const { service } = setup({ personal: true });
    await expect(service.deleteTeam(ORG, OWNER, 'Studio')).rejects.toThrow('personal');
  });

  it('requires the workspace name to confirm', async () => {
    const { service } = setup();
    await expect(service.deleteTeam(ORG, OWNER, 'studio')).rejects.toThrow('Type the workspace name');
  });

  it.each([
    ['active', { plan: 'pri_1', subscriptionId: 'sub_1', subscriptionStatus: 'active' }],
    ['trialing', { plan: 'pri_1', subscriptionId: 'sub_1', subscriptionStatus: 'trialing' }],
    ['paused', { plan: 'pri_1', subscriptionId: 'sub_1', subscriptionStatus: 'paused' }],
    ['comped', { plan: 'pri_1' }],
  ])('refuses while the plan is %s', async (_label, sub) => {
    const { service, orgsService } = setup(sub);
    await expect(service.deleteTeam(ORG, OWNER, 'Studio')).rejects.toThrow('still has a plan');
    expect(orgsService.markDeleted).not.toHaveBeenCalled();
  });

  it('deletes an abandoned-checkout or lapsed team and detaches everyone', async () => {
    const { service, orgsService, usersService, inviteModel, pages, layouts, templates, domains } =
      setup({ plan: 'pri_1', subscriptionId: 'sub_1', subscriptionStatus: 'canceled' });

    await expect(service.deleteTeam(ORG, OWNER, ' Studio ')).resolves.toEqual({ access_token: 'tok' });

    for (const svc of [pages, layouts, templates, domains]) {
      expect(svc.removeAllForOrg).toHaveBeenCalledWith(ORG);
    }
    expect(inviteModel.deleteMany).toHaveBeenCalledWith({ org: ORG, acceptedAt: { $exists: false } });
    expect(orgsService.markDeleted).toHaveBeenCalledWith(expect.objectContaining({ _id: ORG }), OWNER);
    // Both members had it as their active workspace; both go back to personal.
    expect(usersService.updateActiveOrg).toHaveBeenCalledWith(OWNER, 'personal');
    expect(usersService.updateActiveOrg).toHaveBeenCalledWith(MEMBER, 'personal');
  });
});
