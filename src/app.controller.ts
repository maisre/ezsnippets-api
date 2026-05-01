import {
  Controller,
  Request,
  Get,
  Headers,
  HttpCode,
  Post,
  UseGuards,
  Body,
} from '@nestjs/common';
import { AppService } from './app.service';
import { LocalAuthGuard } from './auth/local.strategy';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt.strategy';
import { SignupDto } from './auth/dto/signup.dto';
import { ForgotPasswordDto } from './auth/dto/forgot-password.dto';
import { ResetPasswordDto } from './auth/dto/reset-password.dto';

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
  async signup(@Body() signupDto: SignupDto) {
    return this.authService.signup(signupDto.email, signupDto.password);
  }

  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req) {
    return this.authService.login(req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('auth/logout')
  async logout(@Request() req) {
    return req.logout(() => {});
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
