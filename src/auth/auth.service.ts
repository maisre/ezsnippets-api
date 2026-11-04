import {
  Inject,
  Injectable,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Model } from 'mongoose';
import { UsersService } from '../users/users.service';
import { OrgsService } from '../orgs/orgs.service';
import { isWorkspaceOpen } from '../plans/subscription-status';
import { SqsService } from '../sqs/sqs.service';
import { sanitizeAcquisition } from './acquisition';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
// Reset emails per account per hour. The route's per-IP limit doesn't stop
// someone rotating IPs to flood one person's inbox; this does. Over the cap
// the request still answers 204, so it reveals nothing.
const MAX_RESETS_PER_HOUR = 3;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject('EMAIL_QUEUE_URL') private readonly emailQueueUrl: string,
    @Inject('FRONTEND_URL') private readonly frontendUrl: string,
    @Inject('PASSWORD_RESET_MODEL')
    private readonly passwordResetModel: Model<any>,
    private usersService: UsersService,
    private orgsService: OrgsService,
    private jwtService: JwtService,
    private sqsService: SqsService,
  ) {}

  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.usersService.findByEmail(email);
    if (!user) return null;

    const isMatch = await bcrypt.compare(pass, user.password);

    if (isMatch) {
      const { password, ...result } = user;
      return result;
    }
    return null;
  }

  async signup(email: string, password: string, acquisition?: unknown) {
    // findByEmail ignores case, so Foo@x.com can't open a second account for
    // foo@x.com's inbox; create() stores the email normalised.
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.usersService.create(
      email,
      hashedPassword,
      sanitizeAcquisition(acquisition),
    );

    const org = await this.orgsService.createPersonalOrg(
      String(user._id),
      email,
    );

    await this.usersService.updateActiveOrg(String(user._id), String(org._id));

    const payload = {
      email: user.email,
      sub: user._id,
      activeOrg: org._id,
      tokenVersion: user.tokenVersion,
    };

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'welcome_email',
      userId: String(user._id),
      email: user.email,
    });

    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  async login(user: any) {
    const activeOrg = await this.resolveActiveOrg(
      String(user._doc._id),
      user._doc.activeOrg,
    );
    const payload = {
      email: user._doc.email,
      sub: user._doc._id,
      activeOrg,
      tokenVersion: user._doc.tokenVersion,
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  /**
   * The org to mint a token for. JwtStrategy rejects any token whose activeOrg
   * the user isn't a member of, so minting one from a stale user.activeOrg
   * (removed from a team, org gone, team plan ended) would lock them out on every login. Fall
   * back to — and persist — their personal org instead.
   */
  private async resolveActiveOrg(
    userId: string,
    activeOrg: unknown,
  ): Promise<string | undefined> {
    if (activeOrg) {
      const org = await this.orgsService.findMembership(String(activeOrg), userId);
      if (isWorkspaceOpen(org)) return String(activeOrg);
    }
    const personal = await this.orgsService.findPersonalOrg(userId);
    if (!personal) return activeOrg ? String(activeOrg) : undefined;
    await this.usersService.updateActiveOrg(userId, String(personal._id));
    return String(personal._id);
  }

  /** Make `orgId` the user's workspace and mint a token scoped to it. */
  async switchOrg(userId: string, orgId: string): Promise<string> {
    const org = await this.orgsService.findMembership(orgId, userId);
    if (!org) {
      throw new ForbiddenException('You are not a member of that workspace');
    }
    if (!isWorkspaceOpen(org)) {
      throw new ForbiddenException({
        message:
          'This team workspace has no active plan, so it’s closed. The owner can buy the team plan again to reopen it.',
        code: 'WORKSPACE_CLOSED',
      });
    }
    await this.usersService.updateActiveOrg(userId, orgId);
    return this.issueSessionToken(userId);
  }

  // Re-mint a session JWT for an already-authenticated user. Backs the
  // /auth/session-cookie refresh endpoint so the editor's short-lived
  // ez_session cookie can slide forward (heartbeat) without a fresh login.
  // Re-reads the user so the new token carries the current tokenVersion —
  // a password reset still invalidates it on the next request.
  async issueSessionToken(userId: string): Promise<string> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    const payload = {
      email: user.email,
      sub: String(user._id),
      activeOrg: await this.resolveActiveOrg(String(user._id), user.activeOrg),
      tokenVersion: user.tokenVersion,
    };
    return this.jwtService.sign(payload);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return;
    }

    const recent = await this.passwordResetModel
      .countDocuments({
        user: user._id,
        createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
      })
      .exec();
    if (recent >= MAX_RESETS_PER_HOUR) {
      this.logger.warn(`Reset email cap reached for user ${String(user._id)}`);
      return;
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await this.passwordResetModel.create({
      user: user._id,
      tokenHash,
      expiresAt,
    });

    const resetUrl = `${this.frontendUrl}/reset-password?token=${rawToken}`;

    // The link is a credential. Only log it against LocalStack, where no real
    // email is sent. (NODE_ENV isn't set on the prod box, so it can't be the
    // signal here.)
    this.logger.log(
      `Password reset requested for user ${String(user._id)}` +
        (process.env.AWS_ENDPOINT_URL ? `: ${resetUrl}` : ''),
    );

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'password_reset_email',
      userId: String(user._id),
      resetUrl,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const record = await this.passwordResetModel.findOne({ tokenHash }).exec();
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.usersService.updatePassword(String(record.user), hashedPassword);

    record.usedAt = new Date();
    await record.save();
  }
}
