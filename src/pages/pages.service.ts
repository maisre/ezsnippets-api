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

  async findOne(id: string, orgId: string): Promise<Page | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      return null;
    }
    return this.pageModel.findOne({ _id: id, org: orgId }).exec();
  }

  async findForOrg(orgId: string): Promise<Page[]> {
    if (!Types.ObjectId.isValid(orgId)) {
      return [];
    }
    return this.pageModel.find({ org: orgId }).exec();
  }

  async create(createPageDto: CreatePageDto, orgId: string, userId: string): Promise<Page> {
    const pageData = {
      name: createPageDto.name,
      siteName: createPageDto.siteName,
      description: createPageDto.description,
      projectId: createPageDto.projectId
        ? new Types.ObjectId(createPageDto.projectId)
        : undefined,
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
      snippets: createPageDto.snippets || [],
    };

    const createdPage = new this.pageModel(pageData);
    return createdPage.save();
  }

  async update(
    id: string,
    updatePageDto: UpdatePageDto,
    orgId: string,
  ): Promise<Page> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    const updateData: any = {};
    if (updatePageDto.name !== undefined) updateData.name = updatePageDto.name;
    if (updatePageDto.siteName !== undefined)
      updateData.siteName = updatePageDto.siteName;
    if (updatePageDto.description !== undefined)
      updateData.description = updatePageDto.description;
    if (updatePageDto.aiCustomized !== undefined)
      updateData.aiCustomized = updatePageDto.aiCustomized;
    if (updatePageDto.projectId !== undefined) {
      updateData.projectId = updatePageDto.projectId
        ? new Types.ObjectId(updatePageDto.projectId)
        : undefined;
    }
    if (updatePageDto.snippets !== undefined) {
      updateData.snippets = updatePageDto.snippets;

      // Reset aiCustomized if new snippets were added
      const currentPage = await this.pageModel
        .findOne({ _id: id, org: orgId })
        .exec();
      if (currentPage) {
        const currentIds = new Set(
          currentPage.snippets.map((s: any) => String(s.id)),
        );
        const hasNewSnippets = updatePageDto.snippets.some(
          (s: any) => !currentIds.has(String(s.id)),
        );
        if (hasNewSnippets) {
          updateData.aiCustomized = false;
        }
      }
    }

    const updatedPage = await this.pageModel
      .findOneAndUpdate(
        { _id: id, org: orgId },
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
