import { Mongoose } from 'mongoose';
import { PlanSchema } from './schemas/plan.schema';

export const planProviders = [
  {
    provide: 'PLAN_MODEL',
    useFactory: (mongoose: Mongoose) => mongoose.model('plan', PlanSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
