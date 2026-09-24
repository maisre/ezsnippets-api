import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Model, Types } from 'mongoose';
import {
  BillingEvent,
  FavoriteSnippet,
  Org,
  OrgMember,
} from './interfaces/org.interface';
import { FAVORITE_SNIPPETS_LIMIT, FAVORITES_FULL_MESSAGE } from './favorites';

@Injectable()
export class OrgsService {
  constructor(@Inject('ORG_MODEL') private readonly orgModel: Model<Org>) {}

  async createPersonalOrg(userId: string, email: string): Promise<Org> {
    const org = new this.orgModel({
      name: `${email}'s Org`,
      personal: true,
      members: [{ user: new Types.ObjectId(userId), role: 'owner' }],
    });
    return org.save();
  }

  async findOrgsForUser(userId: string): Promise<Org[]> {
    return this.orgModel.find({ 'members.user': userId }).exec();
  }

  async findOne(orgId: string): Promise<Org | null> {
    if (!Types.ObjectId.isValid(orgId)) {
      return null;
    }
    return this.orgModel.findById(orgId).exec();
  }

  async isUserMember(orgId: string, userId: string): Promise<boolean> {
    const org = await this.orgModel
      .findOne({
        _id: orgId,
        'members.user': userId,
      })
      .exec();
    return !!org;
  }

  async getMemberRole(
    orgId: string,
    userId: string,
  ): Promise<OrgMember['role'] | null> {
    const org = await this.findOne(orgId);
    if (!org) return null;
    const member = org.members.find((m) => m.user.toString() === userId);
    return member?.role ?? null;
  }

  async updateSubscription(
    orgId: string,
    data: {
      paddleCustomerId?: string;
      subscriptionId?: string;
      plan?: string;
      productId?: string;
      subscriptionStatus?: string;
      // Card fields take null to clear them — the customer can remove their
      // saved card in the Paddle portal.
      cardBrand?: string | null;
      cardLast4?: string | null;
      cardExpMonth?: number | null;
      cardExpYear?: number | null;
      currentPeriodEnd?: number;
      cancelAtPeriodEnd?: boolean;
      subscriptionEventAt?: Date;
      billingBlocked?: boolean;
    },
  ): Promise<Org | null> {
    return this.orgModel.findByIdAndUpdate(orgId, data, { new: true }).exec();
  }

  // Keeps only the most recent 20 — enough to answer "what happened to this
  // account?" without letting the array grow without bound.
  async recordBillingEvent(
    orgId: string,
    event: BillingEvent,
  ): Promise<Org | null> {
    return this.orgModel
      .findByIdAndUpdate(
        orgId,
        { $push: { billingEvents: { $each: [event], $slice: -20 } } },
        { new: true },
      )
      .exec();
  }

  async findByPaddleCustomerId(customerId: string): Promise<Org | null> {
    return this.orgModel.findOne({ paddleCustomerId: customerId }).exec();
  }

  /**
   * The org's starred snippets, oldest first (insertion order).
   *
   * A missing org yields an empty list rather than a 404. The only caller is
   * the palette, and a stale `activeOrg` claim on a token should render a
   * palette with no stars rather than break the editor outright.
   */
  async listFavorites(orgId: string): Promise<FavoriteSnippet[]> {
    const org = await this.findOne(orgId);
    return org?.favoriteSnippets ?? [];
  }

  /**
   * Star a snippet for the whole org. Returns the resulting list.
   *
   * Idempotent: starring something already starred is a success that changes
   * nothing, because the client sends this straight off a click and a
   * double-click must not produce two rows.
   *
   * Two writes' worth of care, split deliberately:
   *
   *  - The duplicate guard lives in the query filter (`$ne` on snippetId), not
   *    in the JavaScript below it. `$addToSet` can't do this job — entries are
   *    objects carrying `createdBy`/`addedAt`, so two stars of the same snippet
   *    by different members are distinct set members and both would land. A
   *    guarded `$push` is the equivalent that reads the array server-side.
   *
   *  - The cap can't be expressed that way without making a no-op update
   *    ambiguous ("already starred" and "list is full" would look identical),
   *    and the caller needs to tell those apart to raise a useful error. So the
   *    cap is checked against a prior read. The race that leaves is two
   *    concurrent adds landing at exactly the ceiling, i.e. 101 favorites — a
   *    cosmetic overshoot on a soft product limit, which is a fair trade for an
   *    error message that says what actually went wrong.
   */
  async addFavorite(
    orgId: string,
    userId: string,
    snippetId: string,
  ): Promise<FavoriteSnippet[]> {
    if (!Types.ObjectId.isValid(snippetId)) {
      throw new BadRequestException(`Invalid snippet id: ${snippetId}`);
    }

    const org = await this.findOne(orgId);
    if (!org) {
      throw new NotFoundException(`Org with id ${orgId} not found`);
    }

    const existing = org.favoriteSnippets ?? [];
    if (existing.some((f) => f.snippetId === snippetId)) {
      return existing;
    }
    if (existing.length >= FAVORITE_SNIPPETS_LIMIT) {
      throw new BadRequestException(FAVORITES_FULL_MESSAGE);
    }

    const updated = await this.orgModel
      .findOneAndUpdate(
        { _id: orgId, 'favoriteSnippets.snippetId': { $ne: snippetId } },
        {
          $push: {
            favoriteSnippets: {
              snippetId,
              createdBy: Types.ObjectId.isValid(userId)
                ? new Types.ObjectId(userId)
                : undefined,
              addedAt: new Date(),
            },
          },
        },
        { new: true },
      )
      .exec();

    // No match means someone starred the same snippet between our read and our
    // write — the outcome we wanted either way, so re-read and report it.
    if (!updated) {
      return this.listFavorites(orgId);
    }
    return updated.favoriteSnippets ?? [];
  }

  /**
   * Unstar a snippet. Returns the resulting list.
   *
   * `$pull` already means "remove if present", so removing something that isn't
   * favorited is a successful no-op — never a 404. The star is a toggle, and
   * two editor tabs disagreeing about the current state is the normal case, not
   * an error the user should be shown.
   */
  async removeFavorite(
    orgId: string,
    snippetId: string,
  ): Promise<FavoriteSnippet[]> {
    if (!Types.ObjectId.isValid(orgId)) {
      throw new NotFoundException(`Org with id ${orgId} not found`);
    }

    const updated = await this.orgModel
      .findByIdAndUpdate(
        orgId,
        { $pull: { favoriteSnippets: { snippetId } } },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Org with id ${orgId} not found`);
    }
    return updated.favoriteSnippets ?? [];
  }
}
