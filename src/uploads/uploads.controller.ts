import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import { canEditPage } from '../auth/edit-access';
import { PagesService } from '../pages/pages.service';
import { UploadsService } from './uploads.service';

@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploadsService: UploadsService,
    private readonly pagesService: PagesService,
  ) {}

  // Issue a presigned PUT URL for a user image upload. If a pageId is given the
  // upload is scoped to that page's owning org (and the caller must be allowed
  // to edit it) — this is what lets a future guest editor upload into the
  // owner's org rather than their own. Otherwise it scopes to the caller's org.
  @Post('presign')
  async presign(
    @Request() req,
    @Body() body: { contentType?: string; pageId?: string },
  ) {
    if (!body?.contentType) {
      throw new BadRequestException('contentType is required');
    }
    let orgId: string = req.user.activeOrg;
    if (body.pageId) {
      const page = await this.pagesService.findById(body.pageId);
      if (!page || !canEditPage({ activeOrg: req.user.activeOrg }, page)) {
        throw new ForbiddenException('Not allowed to upload for this page');
      }
      orgId = String(page.org);
    }
    return this.uploadsService.createPresignedUpload(orgId, body.contentType);
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
