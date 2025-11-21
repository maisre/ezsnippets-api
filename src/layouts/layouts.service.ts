import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Layout } from './interfaces/layout.interface';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { UpdateLayoutDto } from './dto/update-layout.dto';

@Injectable()
export class LayoutsService {
  constructor(
    @Inject('LAYOUTS_MODEL') private readonly layoutModel: Model<Layout>,
  ) {}

  async findAll(): Promise<Layout[]> {
    return this.layoutModel.find().exec();
  }

  async findOne(id: string, userId: string): Promise<Layout | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(userId)) {
      return null;
    }
    return this.layoutModel.findOne({ _id: id, owner: userId }).exec();
  }

  async findForOwner(ownerId: string): Promise<Layout[]> {
    if (!Types.ObjectId.isValid(ownerId)) {
      return [];
    }
    return this.layoutModel.find({ owner: ownerId }).exec();
  }

  async create(
    createLayoutDto: CreateLayoutDto,
    ownerId: string,
  ): Promise<Layout> {
    const layoutData = {
      name: createLayoutDto.name,
      nav: createLayoutDto.nav,
      footer: createLayoutDto.footer,
      pageContent: createLayoutDto.pageContent || [],
      owner: new Types.ObjectId(ownerId),
    };

    const createdLayout = new this.layoutModel(layoutData);
    return createdLayout.save();
  }

  async update(
    id: string,
    updateLayoutDto: UpdateLayoutDto,
    userId: string,
  ): Promise<Layout> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(userId)) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    const updateData: any = {};
    if (updateLayoutDto.name !== undefined) updateData.name = updateLayoutDto.name;
    if (updateLayoutDto.nav !== undefined) updateData.nav = updateLayoutDto.nav;
    if (updateLayoutDto.footer !== undefined) updateData.footer = updateLayoutDto.footer;
    if (updateLayoutDto.pageContent !== undefined)
      updateData.pageContent = updateLayoutDto.pageContent;

    const updatedLayout = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, owner: userId },
        { $set: updateData },
        { new: true },
      )
      .exec();

    if (!updatedLayout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    return updatedLayout;
  }
}

