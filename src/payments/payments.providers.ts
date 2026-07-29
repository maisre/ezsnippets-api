import { Mongoose } from 'mongoose';
import { WebhookEventSchema } from './schemas/webhook-event.schema';

export const paymentsProviders = [
  {
    provide: 'WEBHOOK_EVENT_MODEL',
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('webhookEvent', WebhookEventSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
