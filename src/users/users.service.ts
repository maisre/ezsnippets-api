import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { User } from './interfaces/user.interface';

@Injectable()
export class UsersService {
  constructor(@Inject('USER_MODEL') private readonly userModel: Model<User>) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.userModel.findOne({ email }).exec();
  }

  async create(email: string, hashedPassword: string): Promise<User> {
    const user = new this.userModel({ email, password: hashedPassword });
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
}
