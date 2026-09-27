import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { UsersService } from '../users/users.service';
import { OrgsService } from '../orgs/orgs.service';
import { SESSION_COOKIE } from './session-cookie';

// Lets the editor (and any cross-subdomain client) authenticate via the
// HttpOnly ez_session cookie, while the SPA keeps using the Bearer header.
function cookieExtractor(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly orgsService: OrgsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        cookieExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    // Reject tokens issued before the user's last password change. JWTs are
    // stateless and live for 14 days, so this DB check is what lets a password
    // reset actually invalidate existing sessions.
    const user = await this.usersService.findById(payload.sub);
    if (!user || (payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      throw new UnauthorizedException();
    }

    // The activeOrg claim says the user was in that org when the token was
    // minted, not that they still are. Every endpoint scopes content by it, so
    // confirming membership here is what makes removing someone from a team
    // actually take effect. A 401 sends the client back through login, which
    // mints from user.activeOrg — reset to their personal org on removal.
    if (
      !payload.activeOrg ||
      !(await this.orgsService.isUserMember(
        String(payload.activeOrg),
        String(payload.sub),
      ))
    ) {
      throw new UnauthorizedException();
    }

    return {
      userId: payload.sub,
      email: payload.email,
      activeOrg: payload.activeOrg,
    };
  }
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
