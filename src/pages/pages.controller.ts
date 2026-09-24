import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  HttpCode,
  Param,
  Res,
  NotFoundException,
  Request,
  UseGuards,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import { PagesService } from './pages.service';
import { Page } from './interfaces/page.interface';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import {
  ApplyTemplateDto,
  CreateFromTemplateDto,
} from '../templates/dto/apply-template.dto';
import { CustomizeImagesDto } from './dto/customize-images.dto';
import { CustomizeDto } from './dto/customize.dto';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import {
  ParkSnippetDto,
  RestoreSnippetDto,
  ReorderScratchPadDto,
  requireIndex,
  optionalIndex,
} from './dto/scratch-pad.dto';
import { SCRATCH_PAD_LIMIT } from '../common/scratch-pad';

@Controller('pages')
export class PagesController {
  constructor(private readonly pagesService: PagesService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Request() req): Promise<Page[]> {
    return this.pagesService.findForOrg(req.user.activeOrg);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req): Promise<Page> {
    const page = await this.pagesService.findOne(id, req.user.activeOrg);
    if (!page) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }
    return page;
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Body() createPageDto: CreatePageDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.create(createPageDto, req.user.activeOrg, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updatePageDto: UpdatePageDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.update(id, updatePageDto, req.user.activeOrg);
  }

  /**
   * Start a page from a template. Separate from POST /pages rather than an
   * optional field on it, so "blank page" and "from template" can't be
   * confused by a half-filled body.
   */
  @UseGuards(JwtAuthGuard)
  @Post('from-template/:templateId')
  async createFromTemplate(
    @Param('templateId') templateId: string,
    @Body() dto: CreateFromTemplateDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.createFromTemplate(
      templateId,
      dto ?? {},
      req.user.activeOrg,
      req.user.userId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/apply-template/:templateId')
  async applyTemplate(
    @Param('id') id: string,
    @Param('templateId') templateId: string,
    @Body() dto: ApplyTemplateDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.applyTemplate(
      id,
      templateId,
      dto?.mode ?? 'append',
      req.user.activeOrg,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.duplicate(id, req.user.activeOrg, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/customize')
  async customize(
    @Param('id') id: string,
    @Body() dto: CustomizeDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.customize(id, req.user.activeOrg, {
      onlyMissing: dto?.onlyMissing,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/customize-images')
  async customizeImages(
    @Param('id') id: string,
    @Body() dto: CustomizeImagesDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.customizeImages(id, req.user.activeOrg, {
      direction: dto?.direction,
      replaceExisting: dto?.replaceExisting,
      onlyMissing: dto?.onlyMissing,
    });
  }

  // --- Scratch pad ---------------------------------------------------------
  //
  // The editor sends indexes and the server moves its own stored snippet. It
  // deliberately does not accept snippet bodies: the editor does not hold the
  // page-scoped customizations (see PagesService.mergeSnippets), so letting it
  // post them back would drop text overrides, image replacements and
  // shutterstockId on every park.

  @UseGuards(JwtAuthGuard)
  @Get(':id/scratch-pad')
  async getScratchPad(@Param('id') id: string, @Request() req) {
    const page = await this.pagesService.findOne(id, req.user.activeOrg);
    if (!page) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }
    return { scratchPad: page.scratchPad || [], limit: SCRATCH_PAD_LIMIT };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/scratch-pad/park')
  async parkSnippet(
    @Param('id') id: string,
    @Body() dto: ParkSnippetDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.parkSnippet(
      id,
      req.user.activeOrg,
      requireIndex(dto?.index, 'index'),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/scratch-pad/restore')
  async restoreSnippet(
    @Param('id') id: string,
    @Body() dto: RestoreSnippetDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.restoreSnippet(
      id,
      req.user.activeOrg,
      requireIndex(dto?.scratchIndex, 'scratchIndex'),
      optionalIndex(dto?.toIndex, 'toIndex'),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/scratch-pad/reorder')
  async reorderScratchPad(
    @Param('id') id: string,
    @Body() dto: ReorderScratchPadDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.reorderScratchPad(
      id,
      req.user.activeOrg,
      requireIndex(dto?.from, 'from'),
      requireIndex(dto?.to, 'to'),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/scratch-pad/:scratchIndex')
  async discardScratchSnippet(
    @Param('id') id: string,
    @Param('scratchIndex') scratchIndex: string,
    @Request() req,
  ): Promise<Page> {
    // Route params are strings; parse before the service's integer check so a
    // junk segment reads as a 400 rather than NaN reaching an array splice.
    return this.pagesService.discardScratchSnippet(
      id,
      req.user.activeOrg,
      requireIndex(Number(scratchIndex), 'scratchIndex'),
    );
  }

  // Shutterstock images the user must license before publishing the download.
  @UseGuards(JwtAuthGuard)
  @Get(':id/licensing')
  async getLicensing(@Param('id') id: string, @Request() req) {
    return this.pagesService.getLicensing(id, req.user.activeOrg);
  }

  // Build a one-click "license all images" Shutterstock Collection link on
  // demand. Nothing is stored; the collection is reaped by age (ez-background).
  @UseGuards(JwtAuthGuard)
  @Post(':id/collection')
  async generateCollection(@Param('id') id: string, @Request() req) {
    return this.pagesService.generateCollectionUrl(id, req.user.activeOrg);
  }

  // Download the page as a self-contained static-site zip.
  @UseGuards(JwtAuthGuard)
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Request() req,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pagesService.exportZip(
      id,
      req.user.activeOrg,
    );
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
    });
    res.end(buffer);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/archive')
  async archive(@Param('id') id: string, @Request() req): Promise<Page> {
    return this.pagesService.setArchived(id, req.user.activeOrg, true);
  }

  // May throw ForbiddenException if restoring would exceed the plan limit.
  @UseGuards(JwtAuthGuard)
  @Patch(':id/restore')
  async restore(@Param('id') id: string, @Request() req): Promise<Page> {
    return this.pagesService.setArchived(id, req.user.activeOrg, false);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Request() req): Promise<void> {
    return this.pagesService.remove(id, req.user.activeOrg);
  }
}
