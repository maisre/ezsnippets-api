import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Page } from './interfaces/page.interface';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { RedisPubSubService } from '../redis';

@Injectable()
export class PagesService {
  constructor(
    @Inject('PAGES_MODEL') private readonly pageModel: Model<Page>,
    private pubsub: RedisPubSubService,
  ) {}

  async findAll(): Promise<Page[]> {
    return this.pageModel.find().exec();
  }

  async findOne(id: string, userId: string): Promise<Page | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(userId)) {
      return null;
    }
    return this.pageModel.findOne({ _id: id, owner: userId }).exec();
  }

  async findForOwner(ownerId: string): Promise<Page[]> {
    if (!Types.ObjectId.isValid(ownerId)) {
      return [];
    }
    return this.pageModel.find({ owner: ownerId }).exec();
  }

  async create(createPageDto: CreatePageDto, ownerId: string): Promise<Page> {
    const pageData = {
      name: createPageDto.name,
      projectId: createPageDto.projectId
        ? new Types.ObjectId(createPageDto.projectId)
        : undefined,
      owner: new Types.ObjectId(ownerId),
      snippets: createPageDto.snippets || [],
    };

    const createdPage = new this.pageModel(pageData);
    return createdPage.save();
  }

  async update(
    id: string,
    updatePageDto: UpdatePageDto,
    userId: string,
  ): Promise<Page> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(userId)) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    const updateData: any = {};
    if (updatePageDto.name !== undefined) updateData.name = updatePageDto.name;
    if (updatePageDto.projectId !== undefined) {
      updateData.projectId = updatePageDto.projectId
        ? new Types.ObjectId(updatePageDto.projectId)
        : undefined;
    }
    if (updatePageDto.snippets !== undefined)
      updateData.snippets = updatePageDto.snippets;

    const updatedPage = await this.pageModel
      .findOneAndUpdate(
        { _id: id, owner: userId },
        { $set: updateData },
        { new: true },
      )
      .exec();

    if (!updatedPage) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    await this.pubsub.publish('page-updates', {
      action: 'updated',
      roomId: id,
    });
    return updatedPage;
  }
}
