import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  NotFoundException,
  Request,
  UseGuards,
  Body,
} from '@nestjs/common';
import { LayoutsService } from './layouts.service';
import { Layout } from './interfaces/layout.interface';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { UpdateLayoutDto } from './dto/update-layout.dto';
import { JwtAuthGuard } from '../auth/jwt.strategy';

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

  @UseGuards(JwtAuthGuard)
  @Post(':id/customize')
  async customize(
    @Param('id') id: string,
    @Request() req,
  ): Promise<Layout> {
    return this.layoutsService.customize(id, req.user.activeOrg);
  }
}

