import {
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { QUERY_PORT } from '../application/ports/queries.js';
import { UNIT_OF_WORK } from '../application/ports/unit-of-work.js';
import type { Application } from './container.js';

export const APPLICATION = Symbol('Application');

/**
 * Exposes the container's persistence adapters. The container owns the ORM
 * and its pool, so there is one pool per process; this module closes it
 * when Nest shuts down.
 */
@Module({})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(APPLICATION) private readonly app: Application) {}

  static register(app: Application): DynamicModule {
    return {
      module: PersistenceModule,
      global: true,
      providers: [
        { provide: APPLICATION, useValue: app },
        { provide: UNIT_OF_WORK, useValue: app.unitOfWork },
        { provide: QUERY_PORT, useValue: app.queries },
      ],
      exports: [APPLICATION, UNIT_OF_WORK, QUERY_PORT],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.app.close();
  }
}
