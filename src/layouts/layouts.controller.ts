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
import {
  ApplyTemplateDto,
  CreateFromTemplateDto,
} from '../templates/dto/apply-template.dto';
import { LayoutsService } from './layouts.service';
import { Layout } from './interfaces/layout.interface';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { UpdateLayoutDto } from './dto/update-layout.dto';
import { CustomizeImagesDto } from '../pages/dto/customize-images.dto';
import { CustomizeDto } from '../pages/dto/customize.dto';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import {
  LayoutParkSnippetDto,
  LayoutRestoreSnippetDto,
  ReorderScratchPadDto,
  requireIndex,
  optionalIndex,
} from '../pages/dto/scratch-pad.dto';
import { SCRATCH_PAD_LIMIT } from '../common/scratch-pad';

@Controller('layouts')
export class LayoutsController {
  constructor(private readonly layoutsService: LayoutsService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Request() req): Promise<Layout[]> {
    return this.layoutsService.findForOrg(req.user.activeOrg);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req): Promise<Layout> {
    const layout = await this.layoutsService.findOne(id, req.user.activeOrg);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
    return layout;
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Body() createLayoutDto: CreateLayoutDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.create(createLayoutDto, req.user.activeOrg, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateLayoutDto: UpdateLayoutDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.update(id, updateLayoutDto, req.user.activeOrg);
  }

  /** Start a whole site — nav, footer and subpages — from a layout template. */
  @UseGuards(JwtAuthGuard)
  @Post('from-template/:templateId')
  async createFromTemplate(
    @Param('templateId') templateId: string,
    @Body() dto: CreateFromTemplateDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.createFromTemplate(
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
  ): Promise<Layout> {
    return this.layoutsService.applyTemplate(
      id,
      templateId,
      dto?.mode ?? 'append',
      req.user.activeOrg,
      dto?.subPageIndex,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.duplicate(id, req.user.activeOrg, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/customize')
  async customize(
    @Param('id') id: string,
    @Body() dto: CustomizeDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.customize(id, req.user.activeOrg, {
      onlyMissing: dto?.onlyMissing,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/customize-images')
  async customizeImages(
    @Param('id') id: string,
    @Body() dto: CustomizeImagesDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.customizeImages(id, req.user.activeOrg, {
      direction: dto?.direction,
      replaceExisting: dto?.replaceExisting,
      onlyMissing: dto?.onlyMissing,
    });
  }

  // --- Scratch pad ---------------------------------------------------------
  //
  // Layout-wide, so `subPageIndex` says which subpage a snippet comes from on
  // park and which it lands on when restored. As on pages, only indexes cross
  // the wire — the server moves its own stored snippet so customizations
  // cannot be lost in transit.

  @UseGuards(JwtAuthGuard)
  @Get(':id/scratch-pad')
  async getScratchPad(@Param('id') id: string, @Request() req) {
    const layout = await this.layoutsService.findOne(id, req.user.activeOrg);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
    return { scratchPad: layout.scratchPad || [], limit: SCRATCH_PAD_LIMIT };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/scratch-pad/park')
  async parkSnippet(
    @Param('id') id: string,
    @Body() dto: LayoutParkSnippetDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.parkSnippet(
      id,
      req.user.activeOrg,
      requireIndex(dto?.subPageIndex, 'subPageIndex'),
      requireIndex(dto?.index, 'index'),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/scratch-pad/restore')
  async restoreSnippet(
    @Param('id') id: string,
    @Body() dto: LayoutRestoreSnippetDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.restoreSnippet(
      id,
      req.user.activeOrg,
      requireIndex(dto?.scratchIndex, 'scratchIndex'),
      requireIndex(dto?.subPageIndex, 'subPageIndex'),
      optionalIndex(dto?.toIndex, 'toIndex'),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/scratch-pad/reorder')
  async reorderScratchPad(
    @Param('id') id: string,
    @Body() dto: ReorderScratchPadDto,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.reorderScratchPad(
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
  ): Promise<Layout> {
    return this.layoutsService.discardScratchSnippet(
      id,
      req.user.activeOrg,
      requireIndex(Number(scratchIndex), 'scratchIndex'),
    );
  }

  // Shutterstock images the user must license before publishing the download.
  @UseGuards(JwtAuthGuard)
  @Get(':id/licensing')
  async getLicensing(@Param('id') id: string, @Request() req) {
    return this.layoutsService.getLicensing(id, req.user.activeOrg);
  }

  // Build a one-click "license all images" Shutterstock Collection link on
  // demand. Nothing is stored; the collection is reaped by age (ez-background).
  @UseGuards(JwtAuthGuard)
  @Post(':id/collection')
  async generateCollection(@Param('id') id: string, @Request() req) {
    return this.layoutsService.generateCollectionUrl(id, req.user.activeOrg);
  }

  // Download the layout as a self-contained static-site zip.
  @UseGuards(JwtAuthGuard)
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Request() req,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.layoutsService.exportZip(
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
  async archive(@Param('id') id: string, @Request() req): Promise<Layout> {
    return this.layoutsService.setArchived(id, req.user.activeOrg, true);
  }

  // May throw ForbiddenException if restoring would exceed the plan limit.
  @UseGuards(JwtAuthGuard)
  @Patch(':id/restore')
  async restore(@Param('id') id: string, @Request() req): Promise<Layout> {
    return this.layoutsService.setArchived(id, req.user.activeOrg, false);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Request() req): Promise<void> {
    return this.layoutsService.remove(id, req.user.activeOrg);
  }
}

