import * as mongoose from 'mongoose';

/**
 * Cap the connection pool.
 *
 * Mongoose defaults to 100 connections per process. With ez-api, ez-view and
 * ez-background all pointed at the same Atlas cluster that is 300 against a
 * shared-tier cap of 500 — and deploy.sh restarts containers without draining,
 * so old and new briefly overlap and the real peak is double that. The cap is
 * reached during a deploy rather than under load, which is the worst time to
 * discover it.
 *
 * 20 is generous for a Node service: queries are milliseconds, so a pool
 * this size serves far more concurrent requests than the box can handle.
 * Raise it when the cluster is dedicated and the connection ceiling is not
 * the binding constraint.
 */
export const databaseProviders = [
  {
    provide: 'DATABASE_CONNECTION',
    useFactory: (): Promise<typeof mongoose> =>
      mongoose.connect(
        process.env.DATABASE_URL ||
          'mongodb://root:root@127.0.0.1:27017/ez?authSource=admin',
        { maxPoolSize: 20 },
      ),
  },
];
