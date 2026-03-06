import { Injectable, ConflictException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrgsService } from '../orgs/orgs.service';
import { SqsService } from '../sqs/sqs.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

const EMAIL_QUEUE_URL =
  'https://sqs.us-east-1.amazonaws.com/949174740567/dev-email';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private orgsService: OrgsService,
    private jwtService: JwtService,
    private sqsService: SqsService,
  ) {}

  async validateUser(username: string, pass: string): Promise<any> {
    const user = await this.usersService.findOne(username);
    if (!user) return null;

    // Try bcrypt comparison first, fall back to plaintext for existing users
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(pass, user.password);
    } catch {
      isMatch = user.password === pass;
    }

    if (isMatch) {
      const { password, ...result } = user;
      return result;
    }
    return null;
  }

  async signup(username: string, password: string) {
    const existing = await this.usersService.findOne(username);
    if (existing) {
      throw new ConflictException('Username already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.usersService.create(username, hashedPassword);

    const org = await this.orgsService.createPersonalOrg(
      String(user._id),
      username,
    );

    await this.usersService.updateActiveOrg(String(user._id), String(org._id));

    const payload = {
      username: user.username,
      sub: user._id,
      activeOrg: org._id,
    };

    await this.sqsService.sendMessage(EMAIL_QUEUE_URL, {
      type: 'welcome_email',
      userId: String(user._id),
      username: user.username,
    });

    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  async login(user: any) {
    const payload = {
      username: user._doc.username,
      sub: user._doc._id,
      activeOrg: user._doc.activeOrg,
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
