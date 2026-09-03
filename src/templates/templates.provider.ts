import { Mongoose } from 'mongoose';
import { TemplateSchema } from './schemas/template.schema';

export const templateProviders = [
  {
    provide: 'TEMPLATES_MODEL',
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('templates', TemplateSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
