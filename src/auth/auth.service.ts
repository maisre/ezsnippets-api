import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { OrgsService } from '../orgs/orgs.service';
import { SqsService } from '../sqs/sqs.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    @Inject('EMAIL_QUEUE_URL') private readonly emailQueueUrl: string,
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
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
