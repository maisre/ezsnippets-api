import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Model, Types } from 'mongoose';
import { OrgsService } from '../orgs/orgs.service';
import { Org, OrgMember } from '../orgs/interfaces/org.interface';
import { UsersService } from '../users/users.service';
import { PlansService } from '../plans/plans.service';
import { AuthService } from '../auth/auth.service';
import { SqsService } from '../sqs/sqs.service';
import { PagesService } from '../pages/pages.service';
import { LayoutsService } from '../layouts/layouts.service';
import { TemplatesService } from '../templates/templates.service';
import { DomainsService } from '../domains/domains.service';
import { ORG_INVITE_MODEL } from './teams.providers';
import {
  downgradeGraceProductId,
  hasActiveSubscription,
  isWorkspaceOpen,
} from '../plans/subscription-status';

type Role = OrgMember['role'];
/** Roles an invite or a role change may grant. Ownership isn't transferable yet. */
const GRANTABLE_ROLES: Role[] = ['admin', 'member'];

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 80;
// Deliberately loose: the real check is that the invitee can sign in with it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TeamView {
  org: { id: string; name: string; personal: boolean };
  myRole: Role;
  members: { userId: string; email: string | null; role: Role }[];
  /** limit is null when the org has no active plan (no invites possible). */
  seats: { used: number; limit: number | null };
  /** Pending invites — only returned to owners and admins. */
  invites?: {
    id: string;
    email: string;
    role: Role;
    expiresAt: Date;
    createdAt: Date;
  }[];
}

/**
 * Membership of team orgs: invites, roles, removal.
 *
 * Roles in v1:
 *  - owner — everything, including billing (PaymentsService.assertOwner).
 *  - admin — manages members and invites, but can't touch other admins or
 *    the owner, and can't mint new admins.
 *  - member — all content work; no member management.
 *
 * Personal orgs never take members: they're one person's private workspace,
 * and the seat count on their plan is 1.
 */
@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    @Inject(ORG_INVITE_MODEL) private readonly inviteModel: Model<any>,
    @Inject('EMAIL_QUEUE_URL') private readonly emailQueueUrl: string,
    @Inject('FRONTEND_URL') private readonly frontendUrl: string,
    private readonly orgsService: OrgsService,
    private readonly usersService: UsersService,
    private readonly plansService: PlansService,
    private readonly authService: AuthService,
    private readonly sqsService: SqsService,
    private readonly pagesService: PagesService,
    private readonly layoutsService: LayoutsService,
    private readonly templatesService: TemplatesService,
    private readonly domainsService: DomainsService,
  ) {}

  // --- reads ---------------------------------------------------------------

  async getTeam(orgId: string, userId: string): Promise<TeamView> {
    const { org, role } = await this.requireRole(orgId, userId, [
      'owner',
      'admin',
      'member',
    ]);

    const users = await this.usersService.findByIds(
      org.members.map((m) => String(m.user)),
    );
    const emailOf = new Map(users.map((u) => [String(u._id), u.email]));

    const view: TeamView = {
      org: { id: String(org._id), name: org.name, personal: org.personal },
      myRole: role,
      members: org.members.map((m) => ({
        userId: String(m.user),
        email: emailOf.get(String(m.user)) ?? null,
        role: m.role,
      })),
      seats: {
        used: await this.seatsUsed(org),
        limit: (await this.plansService.entitlementFor(org))?.limits.maxSeats ?? null,
      },
    };

    if (role !== 'member') {
      const pending = await this.pendingInvites(orgId);
      view.invites = pending.map((i) => ({
        id: String(i._id),
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      }));
    }
    return view;
  }

  // --- invites -------------------------------------------------------------

  /**
   * Invite someone by email. Re-inviting an address with a pending invite
   * re-issues that invite (fresh link, fresh expiry) instead of holding a
   * second seat — so "resend" is just calling this again.
   */
  async invite(
    orgId: string,
    actorId: string,
    rawEmail: unknown,
    rawRole: unknown,
  ): Promise<{ id: string; email: string; role: Role; expiresAt: Date }> {
    const { org, role: actorRole } = await this.requireRole(orgId, actorId, [
      'owner',
      'admin',
    ]);
    if (org.personal) {
      throw new BadRequestException(
        'Personal workspaces can’t have members. Invite people to a team workspace.',
      );
    }

    const email = normalizeEmail(rawEmail);
    const role = parseRole(rawRole ?? 'member');
    if (actorRole === 'admin' && role === 'admin') {
      throw new ForbiddenException('Only the owner can invite admins');
    }

    const existingUser = await this.usersService.findByEmailInsensitive(email);
    if (
      existingUser &&
      org.members.some((m) => String(m.user) === String(existingUser._id))
    ) {
      throw new ConflictException(`${email} is already a member`);
    }

    const pending = await this.inviteModel
      .findOne({
        org: orgId,
        email,
        acceptedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
      .exec();

    // A pending invite already holds its seat; only a new one needs room.
    if (!pending) await this.assertSeatAvailable(org);

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const fields = {
      role,
      tokenHash: hashToken(rawToken),
      invitedBy: new Types.ObjectId(actorId),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    };
    const invite = pending
      ? await this.inviteModel
          .findByIdAndUpdate(pending._id, fields, { new: true })
          .exec()
      : await this.inviteModel.create({ org: orgId, email, ...fields });

    const inviter = await this.usersService.findById(actorId);
    const acceptUrl = `${this.frontendUrl}/invite/${rawToken}`;
    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'org_invite',
      email,
      orgName: org.name,
      inviterEmail: inviter?.email ?? null,
      role,
      acceptUrl,
    });
    // The link is a credential, so it's only logged where there's no real
    // mail delivery to test with.
    this.logger.log(
      `Invite ${invite._id} ${pending ? 're-issued' : 'sent'} to ${email} for org ${orgId}` +
        (process.env.NODE_ENV === 'production' ? '' : `: ${acceptUrl}`),
    );

    return {
      id: String(invite._id),
      email,
      role,
      expiresAt: invite.expiresAt,
    };
  }

  async revokeInvite(
    orgId: string,
    actorId: string,
    inviteId: string,
  ): Promise<void> {
    await this.requireRole(orgId, actorId, ['owner', 'admin']);
    if (!Types.ObjectId.isValid(inviteId)) {
      throw new NotFoundException('Invite not found');
    }
    const res = await this.inviteModel
      .deleteOne({ _id: inviteId, org: orgId, acceptedAt: { $exists: false } })
      .exec();
    if (!res.deletedCount) throw new NotFoundException('Invite not found');
  }

  /**
   * What the invite link shows before anyone signs in. Public: the token is
   * the credential, and the invitee needs to see which email to sign up with.
   */
  async previewInvite(rawToken: string): Promise<{
    orgName: string;
    email: string;
    role: Role;
    inviterEmail: string | null;
  }> {
    const invite = await this.findUsableInvite(rawToken);
    const org = await this.orgsService.findOne(String(invite.org));
    if (!org) throw new NotFoundException('This invite is no longer valid');
    const inviter = invite.invitedBy
      ? await this.usersService.findById(String(invite.invitedBy))
      : null;
    return {
      orgName: org.name,
      email: invite.email,
      role: invite.role,
      inviterEmail: inviter?.email ?? null,
    };
  }

  /**
   * Join the org and make it the caller's workspace. Returns a token scoped to
   * it, since the caller's current token names their previous org.
   */
  async acceptInvite(
    rawToken: string,
    userId: string,
    userEmail: string,
  ): Promise<{ orgId: string; access_token: string }> {
    const invite = await this.findUsableInvite(rawToken);
    if (normalizeEmail(userEmail) !== invite.email) {
      throw new ForbiddenException(
        `This invite is for ${invite.email}. Sign in with that email to accept it.`,
      );
    }

    const orgId = String(invite.org);
    const org = await this.orgsService.findOne(orgId);
    if (!org) throw new NotFoundException('This invite is no longer valid');
    // A closed team takes its pending invites with it. Refused before
    // addMember so nobody is added to a workspace they can't switch into.
    if (!isWorkspaceOpen(org)) {
      throw new GoneException(
        'This team workspace no longer has an active plan, so its invites have lapsed.',
      );
    }

    // Null when they're already a member — accept is then just a switch.
    const joined = await this.orgsService.addMember(orgId, userId, invite.role);
    await this.inviteModel
      .updateOne(
        { _id: invite._id },
        { acceptedAt: new Date(), acceptedBy: new Types.ObjectId(userId) },
      )
      .exec();

    this.logger.log(`User ${userId} joined org ${orgId} as ${invite.role}`);
    if (joined) {
      // Tell whoever sent it — or the owner, if the inviter has since left.
      const inviterId = invite.invitedBy ? String(invite.invitedBy) : null;
      const inviterStillMember =
        inviterId && joined.members.some((m) => String(m.user) === inviterId);
      await this.notify({
        type: 'org_invite_accepted',
        ...(inviterStillMember ? { userId: inviterId } : { orgId }),
        orgName: org.name,
        memberEmail: invite.email,
        role: invite.role,
      });
    }
    const access_token = await this.authService.switchOrg(userId, orgId);
    return { orgId, access_token };
  }

  // --- members -------------------------------------------------------------

  async setRole(
    orgId: string,
    actorId: string,
    targetId: string,
    rawRole: unknown,
  ): Promise<void> {
    const { org } = await this.requireRole(orgId, actorId, ['owner']);
    const role = parseRole(rawRole);
    const target = findMember(org, targetId);
    if (target.role === 'owner') {
      throw new BadRequestException('The owner’s role can’t be changed');
    }
    await this.orgsService.setMemberRole(orgId, targetId, role);
  }

  async removeMember(
    orgId: string,
    actorId: string,
    targetId: string,
  ): Promise<void> {
    if (actorId === targetId) {
      throw new BadRequestException('Use leave to remove yourself');
    }
    const { org, role: actorRole } = await this.requireRole(orgId, actorId, [
      'owner',
      'admin',
    ]);
    const target = findMember(org, targetId);
    if (target.role === 'owner') {
      throw new ForbiddenException('The owner can’t be removed');
    }
    if (actorRole === 'admin' && target.role === 'admin') {
      throw new ForbiddenException('Only the owner can remove an admin');
    }
    await this.detach(orgId, targetId);
    // Their tokens stop working immediately; without this they'd just see a
    // 401 and land in their personal workspace with no idea why.
    await this.notify({
      type: 'org_member_removed',
      userId: targetId,
      orgName: org.name,
    });
  }

  /**
   * Hand the team to an existing member. The old owner becomes an admin, so
   * they can stay or leave afterwards like anyone else.
   *
   * Billing does not move: the subscription keeps charging whoever paid for
   * it, and the new owner gets the billing portal for that Paddle customer
   * (card last four, invoices, address) until they change the details there.
   * The UI says so before confirming. billingPayerId records who that payer
   * is, the first time the team changes hands, so nothing later mistakes the
   * new owner for them — see PaymentsService.assertPayer.
   *
   * Everything derived from ownership follows by itself: the included
   * personal Pro (PlansService.entitlementFor) and the billing emails, which
   * go to the owner.
   */
  async transferOwnership(
    orgId: string,
    actorId: string,
    rawTargetId: unknown,
  ): Promise<void> {
    const { org } = await this.requireRole(orgId, actorId, ['owner']);
    if (org.personal) {
      throw new BadRequestException('A personal workspace can’t change hands.');
    }
    const targetId = typeof rawTargetId === 'string' ? rawTargetId : '';
    if (targetId === actorId) {
      throw new BadRequestException('You already own this workspace.');
    }
    findMember(org, targetId);
    // The scheduled downgrade has already put the subscription on the current
    // owner's personal workspace; a new owner couldn't undo it.
    if (downgradeGraceProductId(org)) {
      throw new ConflictException(
        'This team is scheduled to move to Pro. Keep the Agency plan first, or transfer it once the change has happened.',
      );
    }

    const payer = org.billingPayerId
      ? undefined
      : org.subscriptionId
        ? actorId
        : undefined;
    const updated = await this.orgsService.transferOwnership(orgId, actorId, targetId, payer);
    if (!updated) {
      throw new ConflictException('The team changed while you were doing that. Reload and try again.');
    }

    const previous = await this.usersService.findById(actorId);
    await this.notify({
      type: 'org_ownership_received',
      userId: targetId,
      orgName: org.name,
      fromEmail: previous?.email ?? null,
      billedToSomeoneElse: !!(updated.subscriptionId && updated.billingPayerId && String(updated.billingPayerId) !== targetId),
    });
    this.logger.log(`Org ${orgId} ownership transferred ${actorId} -> ${targetId}`);
  }

  /** Returns a token for the caller's personal org — their current one is now dead. */
  async leave(
    orgId: string,
    userId: string,
  ): Promise<{ access_token: string }> {
    const role = await this.orgsService.getMemberRole(orgId, userId);
    if (!role) throw new NotFoundException('Workspace not found');
    if (role === 'owner') {
      throw new BadRequestException('The owner can’t leave their own workspace');
    }
    await this.detach(orgId, userId);
    this.logger.log(`User ${userId} (${role}) left org ${orgId}`);
    return { access_token: await this.authService.issueSessionToken(userId) };
  }

  async rename(orgId: string, actorId: string, rawName: unknown): Promise<Org> {
    await this.requireRole(orgId, actorId, ['owner', 'admin']);
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new BadRequestException(
        `Name must be 1–${MAX_NAME_LENGTH} characters`,
      );
    }
    return (await this.orgsService.rename(orgId, name))!;
  }

  // --- deletion ------------------------------------------------------------

  /**
   * Delete a team workspace. Owner only, and never while a Paddle subscription
   * on it is still alive — that has to be cancelled and run out first, or the
   * customer would keep paying for a workspace that's gone.
   *
   * Pages, layouts and templates are soft-deleted (recoverable by support);
   * custom domains are hard-deleted so their hostnames are free again; pending
   * invites are dropped. Everyone is detached, so the org drops out of every
   * membership check, and the caller gets a token for their personal org.
   *
   * `confirmName` must match the workspace name, as a server-side backstop to
   * the UI's type-the-name confirmation.
   */
  async deleteTeam(
    orgId: string,
    actorId: string,
    confirmName: unknown,
  ): Promise<{ access_token: string }> {
    const { org } = await this.requireRole(orgId, actorId, ['owner']);
    if (org.personal) {
      throw new BadRequestException('Your personal workspace can’t be deleted.');
    }
    if (typeof confirmName !== 'string' || confirmName.trim() !== org.name) {
      throw new BadRequestException('Type the workspace name to confirm.');
    }
    if (
      hasActiveSubscription(org) ||
      (org.subscriptionId && org.subscriptionStatus !== 'canceled')
    ) {
      throw new ConflictException(
        'This workspace still has a plan. Cancel it from the account page — you can delete the workspace once it has ended.',
      );
    }

    const [pages, layouts, templates, domains] = await Promise.all([
      this.pagesService.removeAllForOrg(orgId),
      this.layoutsService.removeAllForOrg(orgId),
      this.templatesService.removeAllForOrg(orgId),
      this.domainsService.removeAllForOrg(orgId),
    ]);
    await this.inviteModel
      .deleteMany({ org: orgId, acceptedAt: { $exists: false } })
      .exec();

    const memberIds = org.members.map((m) => String(m.user));
    await this.orgsService.markDeleted(org, actorId);
    for (const userId of memberIds) {
      await this.resetActiveOrgIfOn(orgId, userId);
    }

    this.logger.log(
      `Org ${orgId} deleted by ${actorId}: ${memberIds.length} members detached, ` +
        `${pages} pages, ${layouts} layouts, ${templates} templates, ${domains} domains removed`,
    );
    return { access_token: await this.authService.issueSessionToken(actorId) };
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Pull the user out, and point their workspace back at their personal org if
   * it was this one. JwtStrategy's membership check is what actually cuts off
   * their existing tokens; resetting activeOrg is what lets them log straight
   * back in to somewhere they still belong.
   */
  private async detach(orgId: string, userId: string): Promise<void> {
    await this.orgsService.removeMember(orgId, userId);
    await this.resetActiveOrgIfOn(orgId, userId);
    this.logger.log(`User ${userId} removed from org ${orgId}`);
  }

  private async resetActiveOrgIfOn(orgId: string, userId: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (user && String(user.activeOrg) === orgId) {
      const personal = await this.orgsService.findPersonalOrg(userId);
      if (personal) {
        await this.usersService.updateActiveOrg(userId, String(personal._id));
      }
    }
  }

  /**
   * Fire-and-forget notification email. The membership change has already
   * happened, so a queue hiccup is logged rather than failing the request.
   */
  private async notify(message: Record<string, unknown>): Promise<void> {
    try {
      await this.sqsService.sendMessage(this.emailQueueUrl, message);
    } catch (err) {
      this.logger.error(`Failed to queue ${message.type} email`, err as Error);
    }
  }

  private async requireRole(
    orgId: string,
    userId: string,
    allowed: Role[],
  ): Promise<{ org: Org; role: Role }> {
    const org = await this.orgsService.findOne(orgId);
    // Not-a-member and no-such-org read the same, so ids can't be probed.
    const member = org?.members.find((m) => String(m.user) === userId);
    if (!org || !member) throw new NotFoundException('Workspace not found');
    if (!allowed.includes(member.role)) {
      throw new ForbiddenException(
        'You don’t have permission to do that in this workspace',
      );
    }
    return { org, role: member.role };
  }

  private async pendingInvites(orgId: string): Promise<any[]> {
    return this.inviteModel
      .find({
        org: orgId,
        acceptedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
  }

  /** Members plus pending invites — an outstanding invite holds its seat. */
  private async seatsUsed(org: Org): Promise<number> {
    const pending = await this.inviteModel
      .countDocuments({
        org: org._id,
        acceptedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
      .exec();
    return org.members.length + pending;
  }

  private async assertSeatAvailable(org: Org): Promise<void> {
    const entitlement = await this.plansService.entitlementFor(org);
    if (!entitlement) {
      throw new ForbiddenException(
        'This workspace has no active plan. Renew it to invite people.',
      );
    }
    const { maxSeats } = entitlement.limits;
    if (maxSeats === -1) return;
    const used = await this.seatsUsed(org);
    if (used >= maxSeats) {
      throw new ForbiddenException(
        `All ${maxSeats} seats are in use (pending invites count). Remove someone or revoke an invite first.`,
      );
    }
  }

  private async findUsableInvite(rawToken: string): Promise<any> {
    if (typeof rawToken !== 'string' || !rawToken) {
      throw new NotFoundException('This invite is no longer valid');
    }
    const invite = await this.inviteModel
      .findOne({ tokenHash: hashToken(rawToken) })
      .exec();
    if (!invite) throw new NotFoundException('This invite is no longer valid');
    if (invite.acceptedAt) throw new GoneException('This invite has already been used');
    if (invite.expiresAt < new Date()) {
      throw new GoneException('This invite has expired. Ask for a new one.');
    }
    return invite;
  }
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) throw new BadRequestException('A valid email is required');
  return email;
}

function parseRole(raw: unknown): Role {
  if (!GRANTABLE_ROLES.includes(raw as Role)) {
    throw new BadRequestException(`role must be one of: ${GRANTABLE_ROLES.join(', ')}`);
  }
  return raw as Role;
}

function findMember(org: Org, userId: string): OrgMember {
  const member = org.members.find((m) => String(m.user) === userId);
  if (!member) throw new NotFoundException('Member not found');
  return member;
}
