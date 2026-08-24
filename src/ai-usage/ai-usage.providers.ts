import { Mongoose } from 'mongoose';
import { AiUsageSchema } from './schemas/ai-usage.schema';

export const AI_USAGE_MODEL = 'AI_USAGE_MODEL';

export const aiUsageProviders = [
  {
    provide: AI_USAGE_MODEL,
    useFactory: (mongoose: Mongoose) => mongoose.model('aiUsage', AiUsageSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
