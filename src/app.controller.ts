import {
  Controller,
  Request,
  Res,
  Get,
  Headers,
  HttpCode,
  Post,
  UseGuards,
  Body,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AppService } from './app.service';
import { LocalAuthGuard } from './auth/local.strategy';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt.strategy';
import { SignupDto } from './auth/dto/signup.dto';
import { ForgotPasswordDto } from './auth/dto/forgot-password.dto';
import { ResetPasswordDto } from './auth/dto/reset-password.dto';
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  clearSessionCookieOptions,
} from './auth/session-cookie';

// Per-IP limits on the unauthenticated auth endpoints, on top of the global
// default (AppModule). They target credential stuffing on login, signup spam
// and email floods (signup and forgot-password both send real email). Sized
// for many people behind one IP — an office, or mobile carrier-grade NAT,
// which is where ad traffic lands: a burst limit there would refuse real
// customers, so signup is a per-hour budget rather than per-minute.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ez-api has no global ValidationPipe, so these public endpoints would
// otherwise take any JSON: an empty or one-character password, a non-email, or
// an operator object like {"$ne": null} as the email. Not whitelisting, so
// signup's free-form `acquisition` still passes through. `transform` applies
// the DTOs' email normalisation before validation.
const validate = new ValidationPipe({ transform: true });

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private authService: AuthService,
  ) {}

  @Get()
  getHello(@Headers('Authorization') customHeader?: string): string {
    return this.appService.getHello();
  }

  @Throttle({ default: { limit: 20, ttl: HOUR } })
  @Post('auth/signup')
  async signup(
    @Body(validate) signupDto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.signup(
      signupDto.email,
      signupDto.password,
      signupDto.acquisition,
    );
    res.cookie(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return result;
  }

  // The global ThrottlerGuard runs before LocalAuthGuard, so a throttled
  // request never reaches bcrypt.
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(req.user);
    res.cookie(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return result;
  }

  // Slides the ez_session cookie forward for an already-authenticated caller
  // (Bearer or existing cookie). The editor heartbeats this so an open session
  // never lapses; the Angular app calls it right before opening the editor.
  @UseGuards(JwtAuthGuard)
  @Post('auth/session-cookie')
  @HttpCode(204)
  async refreshSessionCookie(
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = await this.authService.issueSessionToken(req.user.userId);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  }

  // Returns a token scoped to the new workspace and re-sets the editor cookie
  // to match; the old token stays valid only for as long as the user remains a
  // member of the org it names.
  @UseGuards(JwtAuthGuard)
  @Post('auth/switch-org')
  async switchOrg(
    @Request() req,
    @Body() body: { orgId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = await this.authService.switchOrg(
      req.user.userId,
      String(body?.orgId ?? ''),
    );
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    return { access_token: token };
  }

  @Post('auth/logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
  }

  // Per IP; AuthService.forgotPassword also caps emails per account.
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @Post('auth/forgot-password')
  @HttpCode(204)
  async forgotPassword(@Body(validate) dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
  }

  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @Post('auth/reset-password')
  @HttpCode(204)
  async resetPassword(@Body(validate) dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Request() req) {
    return req.user;
  }
}
