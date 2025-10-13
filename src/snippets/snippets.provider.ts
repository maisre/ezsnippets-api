import { Mongoose } from 'mongoose';
import { SnippetSchema } from './schemas/snippet.schema';

export const snippetProviders = [
  {
    provide: 'SNIPPETS_MODEL',
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('snippets', SnippetSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
