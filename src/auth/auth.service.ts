import {
  Inject,
  Injectable,
  ConflictException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Model } from 'mongoose';
import { UsersService } from '../users/users.service';
import { OrgsService } from '../orgs/orgs.service';
import { SqsService } from '../sqs/sqs.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

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

  async signup(email: string, password: string) {
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.usersService.create(email, hashedPassword);

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
    const payload = {
      email: user._doc.email,
      sub: user._doc._id,
      activeOrg: user._doc.activeOrg,
      tokenVersion: user._doc.tokenVersion,
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
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
      activeOrg: user.activeOrg,
      tokenVersion: user.tokenVersion,
    };
    return this.jwtService.sign(payload);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
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

    this.logger.log(`Password reset requested for ${email}: ${resetUrl}`);

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
