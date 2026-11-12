import {
  type Application,
  type ApplicationOverrides,
  buildApplication,
} from '../../src/bootstrap/container.js';
import { loadConfig } from '../../src/infrastructure/config/app-config.js';
import type { Infrastructure } from './infrastructure.js';

export type InProcessOptions = {
  /** Variables on top of the spec's environment, such as a smaller pool. */
  readonly env?: Record<string, string>;
  readonly overrides?: ApplicationOverrides;
};

/**
 * Builds the application graph in this process, against the spec's test
 * database and queues, for specs that inject failures between writes. The
 * caller closes it.
 */
export function startInProcess(
  infrastructure: Infrastructure,
  options: InProcessOptions = {},
): Promise<Application> {
  const config = loadConfig({ ...infrastructure.env, ...options.env });
  return buildApplication(config, options.overrides);
}
