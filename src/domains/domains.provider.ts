import { Mongoose } from 'mongoose';
import { CustomDomainSchema } from './schemas/custom-domain.schema';

export const customDomainProviders = [
  {
    provide: 'CUSTOM_DOMAINS_MODEL',
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('customdomains', CustomDomainSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
