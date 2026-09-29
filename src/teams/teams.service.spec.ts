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
    transferOwnership: jest.fn(async (_o: string, _f: string, _t: string, payer?: string) => ({
      ...org,
      billingPayerId: payer ?? (org as any).billingPayerId,
    })),
  };
  const sqs = { sendMessage: jest.fn().mockResolvedValue(undefined) };
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
    sqs as any,
    pages as any,
    layouts as any,
    templates as any,
    domains as any,
  );
  return { service, org, inviteModel, orgsService, usersService, sqs, pages, layouts, templates, domains };
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

describe('TeamsService.transferOwnership', () => {
  const paid = { plan: 'pri_1', subscriptionId: 'sub_1', subscriptionStatus: 'active' };

  it('is owner-only', async () => {
    const { service, orgsService } = setup(paid);
    await expect(service.transferOwnership(ORG, MEMBER, OWNER)).rejects.toThrow('permission');
    expect(orgsService.transferOwnership).not.toHaveBeenCalled();
  });

  it('only goes to an existing member', async () => {
    const { service } = setup(paid);
    await expect(
      service.transferOwnership(ORG, OWNER, new Types.ObjectId().toString()),
    ).rejects.toThrow('Member not found');
  });

  it('refuses to transfer to yourself', async () => {
    const { service } = setup(paid);
    await expect(service.transferOwnership(ORG, OWNER, OWNER)).rejects.toThrow('already own');
  });

  it('records the current owner as the payer the first time a paid team changes hands', async () => {
    const { service, orgsService, sqs } = setup(paid);
    await service.transferOwnership(ORG, OWNER, MEMBER);
    expect(orgsService.transferOwnership).toHaveBeenCalledWith(ORG, OWNER, MEMBER, OWNER);
    expect(sqs.sendMessage).toHaveBeenCalledWith(
      'queue',
      expect.objectContaining({
        type: 'org_ownership_received',
        userId: MEMBER,
        billedToSomeoneElse: true,
      }),
    );
  });

  it('keeps the original payer on later transfers', async () => {
    const payer = new Types.ObjectId();
    const { service, orgsService } = setup({ ...paid, billingPayerId: payer });
    await service.transferOwnership(ORG, OWNER, MEMBER);
    expect(orgsService.transferOwnership).toHaveBeenCalledWith(ORG, OWNER, MEMBER, undefined);
  });

  it('records no payer for a team with no subscription', async () => {
    const { service, orgsService } = setup();
    await service.transferOwnership(ORG, OWNER, MEMBER);
    expect(orgsService.transferOwnership).toHaveBeenCalledWith(ORG, OWNER, MEMBER, undefined);
  });

  it('refuses while a downgrade is scheduled', async () => {
    const { service } = setup({
      scheduledDowngrade: { until: new Date(Date.now() + 60_000), productId: 'pro_agency' },
    });
    await expect(service.transferOwnership(ORG, OWNER, MEMBER)).rejects.toThrow('scheduled to move to Pro');
  });

  it('reports a race rather than half-applying', async () => {
    const { service, orgsService } = setup(paid);
    orgsService.transferOwnership.mockResolvedValue(null as any);
    await expect(service.transferOwnership(ORG, OWNER, MEMBER)).rejects.toThrow('changed while');
  });
});
