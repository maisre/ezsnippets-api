import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PagesController } from './pages.controller';
import { PagesService } from './pages.service';
import { pageProviders } from './pages.provider';

@Module({
  imports: [DatabaseModule],
  controllers: [PagesController],
  providers: [PagesService, ...pageProviders],
  exports: [PagesService],
})
export class PagesModule {}
