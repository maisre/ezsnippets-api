import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { OrgsModule } from '../orgs/orgs.module';
import { UsersModule } from '../users/users.module';
import { PlansModule } from '../plans/plans.module';
import { AuthModule } from '../auth/auth.module';
import { teamProviders } from './teams.providers';
import { TeamsService } from './teams.service';
import { InvitesController, TeamsController } from './teams.controller';

@Module({
  imports: [
    ConfigModule.forRoot(),
    DatabaseModule,
    OrgsModule,
    UsersModule,
    PlansModule,
    AuthModule,
  ],
  controllers: [TeamsController, InvitesController],
  providers: [
    TeamsService,
    ...teamProviders,
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
})
export class TeamsModule {}
