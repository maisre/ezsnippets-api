import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Org } from './interfaces/org.interface';

@Injectable()
export class OrgsService {
  constructor(@Inject('ORG_MODEL') private readonly orgModel: Model<Org>) {}

  async createPersonalOrg(userId: string, username: string): Promise<Org> {
    const org = new this.orgModel({
      name: `${username}'s Org`,
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

  async updateSubscription(
    orgId: string,
    data: {
      stripeCustomerId?: string;
      subscriptionId?: string;
      plan?: string;
      subscriptionStatus?: string;
    },
  ): Promise<Org | null> {
    return this.orgModel.findByIdAndUpdate(orgId, data, { new: true }).exec();
  }

  async findByStripeCustomerId(customerId: string): Promise<Org | null> {
    return this.orgModel.findOne({ stripeCustomerId: customerId }).exec();
  }
}
