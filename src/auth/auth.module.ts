import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UsersModule } from '../users/users.module';
import { OrgsModule } from '../orgs/orgs.module';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './local.strategy';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { DatabaseModule } from '../database/database.module';
import { passwordResetProviders } from './password-reset.providers';

@Module({
  imports: [
    ConfigModule.forRoot(),
    DatabaseModule,
    UsersModule,
    OrgsModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '14d' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    AuthService,
    LocalStrategy,
    JwtStrategy,
    ...passwordResetProviders,
    {
      provide: 'EMAIL_QUEUE_URL',
      useFactory: (configService: ConfigService) =>
        configService.get('EMAIL_QUEUE_URL'),
      inject: [ConfigService],
    },
    {
      provide: 'FRONTEND_URL',
      useFactory: (configService: ConfigService) =>
        configService.get('FRONTEND_URL') || 'http://localhost:4200',
      inject: [ConfigService],
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
