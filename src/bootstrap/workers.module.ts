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
 * Starts the polling loops this instance's role flags enable, once the app
 * is up, and stops them before shutdown closes the pool: a stop waits for
 * the cycle in progress.
 */
@Module({})
export class WorkersModule
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(@Inject(APPLICATION) private readonly app: Application) {}

  static register(): DynamicModule {
    return { module: WorkersModule };
  }

  onApplicationBootstrap(): void {
    if (this.app.config.roles.referenceWorker) {
      this.app.referenceWorker.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.app.referenceWorker.stop();
  }
}
