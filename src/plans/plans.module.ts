import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { planProviders } from './plans.providers';
import { OrgsModule } from '../orgs/orgs.module';
import { PagesModule } from '../pages/pages.module';
import { LayoutsModule } from '../layouts/layouts.module';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule.forRoot(),
    OrgsModule,
    forwardRef(() => PagesModule),
    forwardRef(() => LayoutsModule),
  ],
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
