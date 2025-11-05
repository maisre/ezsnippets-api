import * as mongoose from 'mongoose';

export const databaseProviders = [
  {
    provide: 'DATABASE_CONNECTION',
    useFactory: (): Promise<typeof mongoose> =>
      mongoose.connect(
        process.env.DATABASE_URL ||
          'mongodb://root:root@127.0.0.1:27017/ez?authSource=admin',
      ),
  },
];
