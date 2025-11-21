import { Mongoose } from 'mongoose';
import { LayoutSchema } from './schemas/layout.schema';

export const layoutProviders = [
  {
    provide: 'LAYOUTS_MODEL',
    useFactory: (mongoose: Mongoose) => mongoose.model('layouts', LayoutSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];

