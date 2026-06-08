import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import { UploadsService } from './uploads.service';

@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  // Issue a presigned PUT URL for a user image upload, scoped to the caller's
  // active org. Returns the URL to PUT to plus the eventual display assetUrl.
  @Post('presign')
  async presign(@Request() req, @Body() body: { contentType?: string }) {
    if (!body?.contentType) {
      throw new BadRequestException('contentType is required');
    }
    return this.uploadsService.createPresignedUpload(
      req.user.activeOrg,
      body.contentType,
    );
  }

  // Mark uploads as saved (tag-on-save) so the lifecycle rule keeps them.
  // Called by the client after it persists content referencing the images.
  @Post('commit')
  async commit(@Request() req, @Body() body: { keys?: string[] }) {
    if (!Array.isArray(body?.keys) || body.keys.length === 0) {
      throw new BadRequestException('keys must be a non-empty array');
    }
    const saved = await this.uploadsService.markSaved(
      req.user.activeOrg,
      body.keys,
    );
    return { saved };
  }
}
