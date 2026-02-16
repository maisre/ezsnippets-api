import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Layout } from './interfaces/layout.interface';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { UpdateLayoutDto } from './dto/update-layout.dto';
import { OpenaiService } from '../openai';
import { SnippetsService } from '../snippets/snippets.service';

@Injectable()
export class LayoutsService {
  constructor(
    @Inject('LAYOUTS_MODEL') private readonly layoutModel: Model<Layout>,
    private readonly openaiService: OpenaiService,
    private readonly snippetsService: SnippetsService,
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
    if (updateLayoutDto.nav !== undefined) updateData.nav = updateLayoutDto.nav;
    if (updateLayoutDto.footer !== undefined)
      updateData.footer = updateLayoutDto.footer;
    if (updateLayoutDto.subPages !== undefined)
      updateData.subPages = updateLayoutDto.subPages;

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

  async customize(id: string, orgId: string): Promise<Layout> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    // Gather all snippet references from nav, footer, and subPages
    const allSnippetRefs: Array<{ ref: any; path: string; index?: number; subIndex?: number }> = [];

    if ((layout.nav as any)?.id) {
      allSnippetRefs.push({ ref: layout.nav, path: 'nav' });
    }
    if ((layout.footer as any)?.id) {
      allSnippetRefs.push({ ref: layout.footer, path: 'footer' });
    }
    if (layout.subPages) {
      layout.subPages.forEach((sp: any, spIdx: number) => {
        (sp.snippets || []).forEach((s: any, sIdx: number) => {
          allSnippetRefs.push({ ref: s, path: 'subPage', index: spIdx, subIndex: sIdx });
        });
      });
    }

    // Load all snippet documents
    const snippetDocs = await Promise.all(
      allSnippetRefs.map((entry) =>
        this.snippetsService.findOne(String(entry.ref.id)),
      ),
    );

    // Build input: only snippets with textReplacement
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

    // Helper to mark a snippet abstract as customized
    const markCustomized = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      obj.aiCustomized = true;
      return obj;
    };

    if (snippetsInput.length === 0) {
      // No text replacements — just mark all snippet abstracts as customized
      const updateData: any = {};
      if ((layout.nav as any)?.id) {
        updateData.nav = markCustomized(layout.nav);
      }
      if ((layout.footer as any)?.id) {
        updateData.footer = markCustomized(layout.footer);
      }
      if (layout.subPages) {
        updateData.subPages = layout.subPages.map((sp: any) => {
          const spObj = sp.toObject ? sp.toObject() : { ...sp };
          spObj.snippets = (sp.snippets || []).map((s: any) => markCustomized(s));
          return spObj;
        });
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

    const result = await this.openaiService.customizeContent({
      name: layout.name,
      siteName: layout.siteName,
      description: layout.description,
      snippets: snippetsInput,
    });

    // Build update data with overrides applied and aiCustomized set
    const applyOverride = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      const snippetResult = result.snippets.find(
        (rs) => rs.snippetId === String(ref.id),
      );
      if (snippetResult) {
        obj.textReplacementOverride = snippetResult.replacements;
      }
      obj.aiCustomized = true;
      return obj;
    };

    const updateData: any = {};

    if ((layout.nav as any)?.id) {
      updateData.nav = applyOverride(layout.nav);
    }
    if ((layout.footer as any)?.id) {
      updateData.footer = applyOverride(layout.footer);
    }
    if (layout.subPages) {
      updateData.subPages = layout.subPages.map((sp: any) => {
        const spObj = sp.toObject ? sp.toObject() : { ...sp };
        spObj.snippets = (sp.snippets || []).map((s: any) => applyOverride(s));
        return spObj;
      });
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
