import { Mongoose } from 'mongoose';
import { FeedbackSchema } from './schemas/feedback.schema';

export const feedbackProviders = [
  {
    provide: 'FEEDBACK_MODEL',
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('feedback', FeedbackSchema, 'feedback'),
    inject: ['DATABASE_CONNECTION'],
  },
];
