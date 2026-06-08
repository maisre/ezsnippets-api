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
} from '@nestjs/common';
import type { Response } from 'express';
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

  @Post('auth/signup')
  async signup(
    @Body() signupDto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.signup(
      signupDto.email,
      signupDto.password,
    );
    res.cookie(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return result;
  }

  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(req.user);
    res.cookie(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return result;
  }

  @Post('auth/logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
  }

  @Post('auth/forgot-password')
  @HttpCode(204)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
  }

  @Post('auth/reset-password')
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Request() req) {
    return req.user;
  }
}
