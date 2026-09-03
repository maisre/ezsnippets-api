import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import type {
  Template,
  TemplateKind,
} from './interfaces/template.interface';
import { JwtAuthGuard } from '../auth/jwt.strategy';

/**
 * Reads are org-scoped but not owner-scoped: everyone sees the built-in
 * library, plus whatever their own org saved. Writes only ever touch the org's
 * own templates.
 */
@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  async findAll(
    @Request() req,
    @Query('kind') kind?: TemplateKind,
  ): Promise<Template[]> {
    return this.templatesService.findAll(req.user.activeOrg, kind);
  }

  @Get('filters')
  async getFilters(@Request() req) {
    return this.templatesService.getFilters(req.user.activeOrg);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req) {
    return this.templatesService.findOne(id, req.user.activeOrg);
  }

  @Post()
  async create(@Body() dto: CreateTemplateDto, @Request() req) {
    return this.templatesService.create(
      dto,
      req.user.activeOrg,
      req.user.userId,
    );
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
    @Request() req,
  ) {
    return this.templatesService.update(id, req.user.activeOrg, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Request() req) {
    await this.templatesService.remove(id, req.user.activeOrg);
    return { deleted: true };
  }
}
