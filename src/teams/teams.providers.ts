import { Mongoose } from 'mongoose';
import { OrgInviteSchema } from './schemas/org-invite.schema';

export const ORG_INVITE_MODEL = 'ORG_INVITE_MODEL';

export const teamProviders = [
  {
    provide: ORG_INVITE_MODEL,
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('org_invite', OrgInviteSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
