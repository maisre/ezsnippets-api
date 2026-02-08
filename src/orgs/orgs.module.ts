import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { orgProviders } from './orgs.providers';
import { OrgsService } from './orgs.service';
import { OrgsController } from './orgs.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [OrgsController],
  providers: [OrgsService, ...orgProviders],
  exports: [OrgsService],
})
export class OrgsModule {}
