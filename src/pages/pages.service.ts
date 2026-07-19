import {
  Inject,
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Page } from './interfaces/page.interface';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { RedisPubSubService } from '../redis';
import { OpenaiService } from '../openai';
import { SnippetsService } from '../snippets/snippets.service';
import { OrgsService } from '../orgs/orgs.service';
import { PlansService } from '../plans/plans.service';
import { ShutterstockService } from '../shutterstock';
import { targetAspectFor, slotShapeFor } from '../shutterstock/target-dimensions';

@Injectable()
export class PagesService {
  private readonly logger = new Logger(PagesService.name);

  constructor(
    @Inject('PAGES_MODEL') private readonly pageModel: Model<Page>,
    private pubsub: RedisPubSubService,
    private readonly openaiService: OpenaiService,
    private readonly snippetsService: SnippetsService,
    private readonly orgsService: OrgsService,
    private readonly plansService: PlansService,
    private readonly shutterstockService: ShutterstockService,
  ) {}

  async findAll(): Promise<Page[]> {
    return this.pageModel.find().exec();
  }

  async findOne(id: string, orgId: string): Promise<Page | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      return null;
    }
    return this.pageModel
      .findOne({ _id: id, org: orgId, deletedAt: null })
      .exec();
  }

  // Load a page without an org filter, so callers can authorize against its
  // owning org (used by upload presign to scope uploads by resource).
  async findById(id: string): Promise<Page | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.pageModel.findOne({ _id: id, deletedAt: null }).exec();
  }

  // Returns active *and* archived pages so the dashboard can list archived
  // ones separately; only soft-deleted pages are hidden.
  async findForOrg(orgId: string): Promise<Page[]> {
    if (!Types.ObjectId.isValid(orgId)) {
      return [];
    }
    return this.pageModel.find({ org: orgId, deletedAt: null }).exec();
  }

  // Drives both plan enforcement and the /plans/usage display, so archived and
  // soft-deleted pages are excluded from both. `deletedAt: null` also matches
  // pre-existing documents that have no such field.
  async countForOrg(orgId: string): Promise<number> {
    if (!Types.ObjectId.isValid(orgId)) return 0;
    return this.pageModel
      .countDocuments({
        org: orgId,
        status: { $ne: 'archived' },
        deletedAt: null,
      })
      .exec();
  }

  async create(createPageDto: CreatePageDto, orgId: string, userId: string): Promise<Page> {
    await this.enforceLimit(orgId);

    const pageData = {
      name: createPageDto.name,
      siteName: createPageDto.siteName,
      description: createPageDto.description,
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
      snippets: createPageDto.snippets || [],
    };

    const createdPage = new this.pageModel(pageData);
    return createdPage.save();
  }

  // Duplicate an existing page within the caller's active org. Enforces, in
  // order: (1) the user is a member of the org, (2) the source page belongs to
  // that org (via org-scoped findOne), (3) the plan's page limit. The copy is
  // built server-side from the stored page so the client can't fabricate its
  // contents.
  async duplicate(id: string, orgId: string, userId: string): Promise<Page> {
    const isMember = await this.orgsService.isUserMember(orgId, userId);
    if (!isMember) {
      throw new ForbiddenException('You do not belong to this organization.');
    }

    const source = await this.findOne(id, orgId);
    if (!source) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    await this.enforceLimit(orgId);

    // Strip subdocument _ids so the copied snippets get fresh ones.
    const snippets = (source.toObject().snippets || []).map(
      ({ _id, ...rest }: any) => rest,
    );

    const createdPage = new this.pageModel({
      name: `${source.name} (copy)`,
      siteName: source.siteName,
      description: source.description,
      snippets,
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
    });
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
    if (updatePageDto.textVariant !== undefined)
      updateData.textVariant = updatePageDto.textVariant;
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
    // Seed the AI from the generic English variant (the representative text),
    // falling back to the lorem placeholder if a token has no english. The raw
    // `original` snippet text is intentionally not used.
    const snippetsInput = validSnippets.map((s) => ({
      snippetId: String(s._id),
      replacements: s.textReplacement!.map((tr: any) => ({
        token: tr.token,
        original: tr.english || tr.replacement || '',
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
          { $set: { snippets: updatedSnippets, textVariant: 'customized' } },
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

    // Switch the page to the customized variant so the new AI text renders.
    const updatedPage = await this.pageModel
      .findOneAndUpdate(
        { _id: id, org: orgId },
        { $set: { snippets: updatedSnippets, textVariant: 'customized' } },
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

  // Fill the page's image slots with stock photos: one AI-derived search query
  // per slot, then the result whose aspect best fits that slot's intended
  // dimensions.
  //
  // Deliberately independent of customize() — separate button, separate OpenAI
  // call — so re-running text never re-runs images. By default only empty slots
  // are filled, so a user's hand-picked images survive; pass replaceExisting to
  // redo everything.
  async customizeImages(
    id: string,
    orgId: string,
    options: { direction?: string; replaceExisting?: boolean } = {},
  ): Promise<Page> {
    const page = await this.findOne(id, orgId);
    if (!page) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    const snippetDocs = await Promise.all(
      page.snippets.map((sa: any) =>
        this.snippetsService.findOne(String(sa.id)),
      ),
    );

    // Slots are keyed by snippetId+token, not by position, so duplicate
    // instances of the same snippet on a page resolve to the same image. That
    // matches how text overrides already behave.
    const slots: Array<{
      snippetId: string;
      token: string;
      shape?: string;
      context?: string;
      targetAspect: number | null;
    }> = [];
    const seen = new Set<string>();

    page.snippets.forEach((sa: any, index: number) => {
      const snippet = snippetDocs[index];
      if (!snippet?.imageReplacement?.length) return;

      const filled = new Set(
        (sa.imageReplacementOverride || [])
          .filter((o: any) => o?.replacement)
          .map((o: any) => o.token),
      );

      // A little nearby copy lets the model tell a hero from an avatar.
      const context = (snippet.textReplacement || [])
        .map((tr: any) => tr.english || tr.replacement || '')
        .filter(Boolean)
        .slice(0, 3)
        .join(' | ')
        .slice(0, 200);

      snippet.imageReplacement.forEach((ir: any) => {
        if (!options.replaceExisting && filled.has(ir.token)) return;

        const key = `${String(snippet._id)}::${ir.token}`;
        if (seen.has(key)) return;
        seen.add(key);

        slots.push({
          snippetId: String(snippet._id),
          token: ir.token,
          shape: slotShapeFor(ir.replacement) ?? undefined,
          context: context || undefined,
          targetAspect: targetAspectFor(ir.replacement),
        });
      });
    });

    if (!slots.length) {
      return page;
    }

    const { slots: queries } = await this.openaiService.deriveImageQueries({
      name: page.name,
      siteName: page.siteName,
      description: page.description,
      direction: options.direction,
      slots: slots.map(({ targetAspect, ...slot }) => slot),
    });

    const aspectByKey = new Map(
      slots.map((s) => [`${s.snippetId}::${s.token}`, s.targetAspect]),
    );

    // Searches run in parallel: a page can hold 5-20 slots and the searches are
    // unmetered, so sequential would make this unusably slow. One slot failing
    // must not sink the rest — it just stays on its placeholder.
    const picks = await Promise.all(
      queries.map(async (q) => {
        const key = `${q.snippetId}::${q.token}`;
        try {
          const image = await this.shutterstockService.findBestMatch(
            q.query,
            aspectByKey.get(key) ?? null,
          );
          return image ? { snippetId: q.snippetId, token: q.token, image } : null;
        } catch (error) {
          this.logger.warn(
            `Stock search failed for ${key} ("${q.query}"): ${String(error)}`,
          );
          return null;
        }
      }),
    );

    const picksBySnippet = new Map<string, Array<{ token: string; image: any }>>();
    for (const pick of picks) {
      if (!pick) continue;
      const list = picksBySnippet.get(pick.snippetId) || [];
      list.push({ token: pick.token, image: pick.image });
      picksBySnippet.set(pick.snippetId, list);
    }

    if (!picksBySnippet.size) {
      return page;
    }

    const updatedSnippets = page.snippets.map((sa: any) => {
      const obj = sa.toObject ? sa.toObject() : { ...sa };
      const forSnippet = picksBySnippet.get(String(sa.id));
      if (!forSnippet?.length) return obj;

      const overrides = new Map<string, any>(
        (obj.imageReplacementOverride || []).map((o: any) => [o.token, o]),
      );
      for (const { token, image } of forSnippet) {
        // Written as a unit: replacing an override always replaces its id, so a
        // stale shutterstockId can never outlive the image it belonged to.
        overrides.set(token, {
          token,
          replacement: image.previewUrl,
          shutterstockId: image.id,
        });
      }
      obj.imageReplacementOverride = Array.from(overrides.values());
      obj.aiImagesPopulated = true;
      return obj;
    });

    const updatedPage = await this.pageModel
      .findOneAndUpdate(
        { _id: id, org: orgId, deletedAt: null },
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

  // Archive or restore a page. Restoring re-enters the plan count, so it has to
  // re-check the limit — otherwise archiving three pages, creating three more,
  // and restoring the originals would leave an org over its cap.
  async setArchived(
    id: string,
    orgId: string,
    archived: boolean,
  ): Promise<Page> {
    const page = await this.findOne(id, orgId);
    if (!page) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    if (!archived && page.status === 'archived') {
      await this.enforceLimit(orgId);
    }

    const updatedPage = await this.pageModel
      .findOneAndUpdate(
        { _id: id, org: orgId, deletedAt: null },
        { $set: { status: archived ? 'archived' : 'active' } },
        { new: true },
      )
      .exec();

    if (!updatedPage) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    // Archiving takes the page offline in ez-view; tell any connected viewers.
    await this.pubsub.publish('page-updates', {
      action: 'updated',
      roomId: id,
    });
    return updatedPage;
  }

  // Soft delete: the document is kept so it can be recovered manually, but it
  // is hidden from every read path and drops out of the plan count.
  async remove(id: string, orgId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    const deletedPage = await this.pageModel
      .findOneAndUpdate(
        { _id: id, org: orgId, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { new: true },
      )
      .exec();

    if (!deletedPage) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    await this.pubsub.publish('page-updates', {
      action: 'updated',
      roomId: id,
    });
  }

  private async enforceLimit(orgId: string): Promise<void> {
    const org = await this.orgsService.findOne(orgId);
    if (!org?.plan) {
      throw new ForbiddenException(
        'No active plan. Subscribe to a plan to create pages.',
      );
    }

    const limits = await this.plansService.getLimitsForPriceId(org.plan);
    if (!limits || limits.maxPages === -1) return; // Unlimited

    const current = await this.countForOrg(orgId);
    if (current >= limits.maxPages) {
      throw new ForbiddenException(
        `Page limit reached (${limits.maxPages}). Upgrade your plan to create more pages.`,
      );
    }
  }
}
