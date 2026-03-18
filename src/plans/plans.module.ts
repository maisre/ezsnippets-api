import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { planProviders } from './plans.providers';

@Module({
  imports: [DatabaseModule, ConfigModule.forRoot()],
  controllers: [PlansController],
  providers: [
    PlansService,
    ...planProviders,
    {
      provide: 'PLAN_LIMITS_OVERRIDE',
      useFactory: (configService: ConfigService) =>
        configService.get('PLAN_LIMITS_OVERRIDE'),
      inject: [ConfigService],
    },
  ],
  exports: [PlansService],
})
export class PlansModule {}
