import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PagesController } from './pages.controller';
import { PagesService } from './pages.service';
import { pageProviders } from './pages.provider';
import { SnippetsModule } from '../snippets/snippets.module';

@Module({
  imports: [DatabaseModule, SnippetsModule],
  controllers: [PagesController],
  providers: [PagesService, ...pageProviders],
  exports: [PagesService],
})
export class PagesModule {}
