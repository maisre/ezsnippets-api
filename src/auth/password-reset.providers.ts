import { Mongoose } from 'mongoose';
import { PasswordResetSchema } from './schemas/password-reset.schema';

export const passwordResetProviders = [
  {
    provide: 'PASSWORD_RESET_MODEL',
    useFactory: (mongoose: Mongoose) =>
      mongoose.model('password_reset', PasswordResetSchema),
    inject: ['DATABASE_CONNECTION'],
  },
];
