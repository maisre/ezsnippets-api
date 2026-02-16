import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Page } from './interfaces/page.interface';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { RedisPubSubService } from '../redis';
import { OpenaiService } from '../openai';
import { SnippetsService } from '../snippets/snippets.service';

@Injectable()
export class PagesService {
  constructor(
    @Inject('PAGES_MODEL') private readonly pageModel: Model<Page>,
    private pubsub: RedisPubSubService,
    private readonly openaiService: OpenaiService,
    private readonly snippetsService: SnippetsService,
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
    if (updatePageDto.projectId !== undefined) {
      updateData.projectId = updatePageDto.projectId
        ? new Types.ObjectId(updatePageDto.projectId)
        : undefined;
    }
    if (updatePageDto.snippets !== undefined) {
      updateData.snippets = updatePageDto.snippets;
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

  async customize(id: string, orgId: string): Promise<Page> {
    const page = await this.findOne(id, orgId);
    if (!page) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    // Load all referenced snippets
    const snippetDocs = await Promise.all(
      page.snippets.map((sa: any) => this.snippetsService.findOne(String(sa.id))),
    );

    // Build input for OpenAI: only snippets with textReplacement
    const validSnippets = snippetDocs.filter(
      (s): s is NonNullable<typeof s> =>
        s != null && !!s.textReplacement && s.textReplacement.length > 0,
    );
    const snippetsInput = validSnippets.map((s) => ({
      snippetId: String(s._id),
      replacements: s.textReplacement!.map((tr: any) => ({
        token: tr.token,
        original: tr.original || tr.replacement || '',
      })),
    }));

    if (snippetsInput.length === 0) {
      // No text replacements to customize — just mark all snippets as done
      const updatedSnippets = page.snippets.map((sa: any) => {
        const obj = sa.toObject ? sa.toObject() : { ...sa };
        obj.aiCustomized = true;
        return obj;
      });

      const updatedPage = await this.pageModel
        .findOneAndUpdate(
          { _id: id, org: orgId },
          { $set: { snippets: updatedSnippets } },
          { new: true },
        )
        .exec();
      if (!updatedPage) {
        throw new NotFoundException(`Page with id ${id} not found`);
      }
      return updatedPage;
    }

    const result = await this.openaiService.customizeContent({
      name: page.name,
      siteName: page.siteName,
      description: page.description,
      snippets: snippetsInput,
    });

    // Map results back onto the page's snippet references
    const updatedSnippets = page.snippets.map((sa: any) => {
      const snippetResult = result.snippets.find(
        (rs) => rs.snippetId === String(sa.id),
      );
      const obj = sa.toObject ? sa.toObject() : { ...sa };
      if (snippetResult) {
        obj.textReplacementOverride = snippetResult.replacements;
      }
      obj.aiCustomized = true;
      return obj;
    });

    const updatedPage = await this.pageModel
      .findOneAndUpdate(
        { _id: id, org: orgId },
        { $set: { snippets: updatedSnippets } },
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
