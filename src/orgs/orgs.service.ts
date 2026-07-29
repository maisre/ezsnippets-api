import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { BillingEvent, Org, OrgMember } from './interfaces/org.interface';

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
}
