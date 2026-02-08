import { Document, Types } from 'mongoose';

export interface OrgMember {
  readonly user: Types.ObjectId;
  readonly role: 'owner' | 'admin' | 'member';
}

export interface Org extends Document {
  readonly name: string;
  readonly personal: boolean;
  readonly members: OrgMember[];
}
