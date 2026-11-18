import { Module } from '@nestjs/common';
import { ThumbnailsService } from './thumbnails.service';

@Module({
  providers: [ThumbnailsService],
  exports: [ThumbnailsService],
})
export class ThumbnailsModule {}
