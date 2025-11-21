import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LayoutsController } from './layouts.controller';
import { LayoutsService } from './layouts.service';
import { layoutProviders } from './layouts.provider';

@Module({
  imports: [DatabaseModule],
  controllers: [LayoutsController],
  providers: [LayoutsService, ...layoutProviders],
  exports: [LayoutsService],
})
export class LayoutsModule {}

