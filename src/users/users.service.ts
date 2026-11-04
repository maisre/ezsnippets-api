import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { User } from './interfaces/user.interface';
import { Acquisition } from '../auth/acquisition';

/** How emails are stored and compared: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  constructor(@Inject('USER_MODEL') private readonly userModel: Model<User>) {}

  /**
   * Look a user up by email, ignoring case and surrounding spaces.
   *
   * New accounts are stored normalised (see normalizeEmail), so the exact
   * match is the normal path. Older rows were stored as typed, so a miss falls
   * back to a case-insensitive match instead of migrating them. Neither query
   * has an index on email yet — see the recommendation in the security notes.
   */
  async findByEmail(email: unknown): Promise<User | null> {
    if (typeof email !== 'string') return null;
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return (
      (await this.userModel.findOne({ email: normalized }).exec()) ??
      this.findByEmailInsensitive(normalized)
    );
  }

  // Signup stores email as typed, but invites are keyed lower-cased.
  async findByEmailInsensitive(email: string): Promise<User | null> {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.userModel
      .findOne({ email: { $regex: `^${escaped}$`, $options: 'i' } })
      .exec();
  }

  async findByIds(userIds: string[]): Promise<User[]> {
    const ids = userIds.filter((id) => Types.ObjectId.isValid(id));
    return this.userModel.find({ _id: { $in: ids } }).select('email').exec();
  }

  async create(
    email: string,
    hashedPassword: string,
    acquisition?: Acquisition,
  ): Promise<User> {
    const user = new this.userModel({
      email: normalizeEmail(email),
      password: hashedPassword,
      ...(acquisition && { acquisition }),
    });
    return user.save();
  }

  async findById(userId: string): Promise<User | null> {
    return this.userModel.findById(userId).exec();
  }

  async updateActiveOrg(userId: string, orgId: string): Promise<User | null> {
    return this.userModel
      .findByIdAndUpdate(
        userId,
        { activeOrg: new Types.ObjectId(orgId) },
        { new: true },
      )
      .exec();
  }

  async updatePassword(
    userId: string,
    hashedPassword: string,
  ): Promise<User | null> {
    return this.userModel
      .findByIdAndUpdate(
        userId,
        { password: hashedPassword, $inc: { tokenVersion: 1 } },
        { new: true },
      )
      .exec();
  }
}
