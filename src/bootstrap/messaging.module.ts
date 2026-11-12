import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Application } from './container.js';
import { APPLICATION } from './persistence.module.js';

/**
 * Starts the SQS consumer when `SQS_CONSUMER_ENABLED`, once the app is up,
 * and drains it before shutdown closes the pool (§12, Shutdown): the long
 * poll is aborted, each group finishes the message in progress, and the
 * rest are released.
 */
@Module({})
export class MessagingModule
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(@Inject(APPLICATION) private readonly app: Application) {}

  static register(): DynamicModule {
    return { module: MessagingModule };
  }

  onApplicationBootstrap(): void {
    if (this.app.config.roles.sqsConsumer) {
      this.app.sqsConsumer.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.app.sqsConsumer.stop();
  }
}
