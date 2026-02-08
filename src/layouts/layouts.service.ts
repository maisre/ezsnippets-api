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

  async findOne(id: string, orgId: string): Promise<Layout | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      return null;
    }
    return this.layoutModel.findOne({ _id: id, org: orgId }).exec();
  }

  async findForOrg(orgId: string): Promise<Layout[]> {
    if (!Types.ObjectId.isValid(orgId)) {
      return [];
    }
    return this.layoutModel.find({ org: orgId }).exec();
  }

  async create(
    createLayoutDto: CreateLayoutDto,
    orgId: string,
    userId: string,
  ): Promise<Layout> {
    const layoutData = {
      name: createLayoutDto.name,
      siteName: createLayoutDto.siteName,
      description: createLayoutDto.description,
      nav: createLayoutDto.nav,
      footer: createLayoutDto.footer,
      subPages: createLayoutDto.subPages || [],
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
    };

    const createdLayout = new this.layoutModel(layoutData);
    return createdLayout.save();
  }

  async update(
    id: string,
    updateLayoutDto: UpdateLayoutDto,
    orgId: string,
  ): Promise<Layout> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    const updateData: any = {};
    if (updateLayoutDto.name !== undefined)
      updateData.name = updateLayoutDto.name;
    if (updateLayoutDto.siteName !== undefined)
      updateData.siteName = updateLayoutDto.siteName;
    if (updateLayoutDto.description !== undefined)
      updateData.description = updateLayoutDto.description;
    if (updateLayoutDto.aiCustomized !== undefined)
      updateData.aiCustomized = updateLayoutDto.aiCustomized;
    if (updateLayoutDto.nav !== undefined) updateData.nav = updateLayoutDto.nav;
    if (updateLayoutDto.footer !== undefined)
      updateData.footer = updateLayoutDto.footer;
    if (updateLayoutDto.subPages !== undefined)
      updateData.subPages = updateLayoutDto.subPages;

    // Reset aiCustomized if new snippets were added to nav, footer, or subPages
    const contentUpdated =
      updateLayoutDto.nav !== undefined ||
      updateLayoutDto.footer !== undefined ||
      updateLayoutDto.subPages !== undefined;

    if (contentUpdated) {
      const currentLayout = await this.layoutModel
        .findOne({ _id: id, org: orgId })
        .exec();
      if (currentLayout) {
        const currentIds = new Set<string>();
        if ((currentLayout.nav as any)?.id)
          currentIds.add(String((currentLayout.nav as any).id));
        if ((currentLayout.footer as any)?.id)
          currentIds.add(String((currentLayout.footer as any).id));
        if (currentLayout.subPages) {
          for (const sp of currentLayout.subPages) {
            for (const s of sp.snippets || []) {
              currentIds.add(String((s as any).id));
            }
          }
        }

        let hasNewSnippets = false;
        if (
          updateLayoutDto.nav &&
          (updateLayoutDto.nav as any).id &&
          !currentIds.has(String((updateLayoutDto.nav as any).id))
        ) {
          hasNewSnippets = true;
        }
        if (
          updateLayoutDto.footer &&
          (updateLayoutDto.footer as any).id &&
          !currentIds.has(String((updateLayoutDto.footer as any).id))
        ) {
          hasNewSnippets = true;
        }
        if (updateLayoutDto.subPages) {
          for (const sp of updateLayoutDto.subPages) {
            for (const s of sp.snippets || []) {
              if (!currentIds.has(String((s as any).id))) {
                hasNewSnippets = true;
                break;
              }
            }
            if (hasNewSnippets) break;
          }
        }

        if (hasNewSnippets) {
          updateData.aiCustomized = false;
        }
      }
    }

    const updatedLayout = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, org: orgId },
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
