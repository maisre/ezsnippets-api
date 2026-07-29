import { Mongoose } from 'mongoose';
import { PaddleCatalogSchema } from './schemas/paddle-catalog.schema';

export const PADDLE_CATALOG_MODEL = 'PADDLE_CATALOG_MODEL';

export const planProviders = [
  {
    provide: PADDLE_CATALOG_MODEL,
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('paddleCatalog', PaddleCatalogSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
