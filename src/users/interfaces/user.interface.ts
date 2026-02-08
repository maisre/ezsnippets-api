import { Document, Types } from 'mongoose';

export interface User extends Document {
  readonly id: number;
  readonly username: string;
  readonly password: string;
  readonly activeOrg?: Types.ObjectId;
}
