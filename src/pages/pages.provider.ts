import { Mongoose } from 'mongoose';
import { PageSchema } from './schemas/page.schema';

export const pageProviders = [
  {
    provide: 'PAGES_MODEL',
    useFactory: (mongoose: Mongoose) => mongoose.model('pages', PageSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
