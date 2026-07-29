import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { redisProviders } from './redis.providers';
import { RedisPubSubService } from './redis-pubsub.service';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.constants';

// Redis here is pub/sub only — the publisher/subscriber connections below back
// the websocket fan-out to ez-view.
//
// There was a CacheModule registered here too, configured with cache-manager
// v5's `{ store }` option. The installed cache-manager is v7, which is Keyv
// based and ignores that option, so it was silently an in-process memory cache
// that looked Redis-backed. Nothing consumed it. Removed rather than repaired:
// a cache that lies about where it stores things is worse than no cache, and
// the deployed Redis runs without persistence anyway. Wire it up deliberately
// if and when something actually needs caching.
@Global()
@Module({
  providers: [...redisProviders, RedisPubSubService],
  exports: [
    ...redisProviders,
    RedisPubSubService,
    REDIS_PUBLISHER,
    REDIS_SUBSCRIBER,
  ],
})
export class RedisModule implements OnModuleDestroy {
  constructor(
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // Connections are closed via RedisPubSubService.onModuleDestroy
    // This hook ensures module-level cleanup if needed
  }
}

