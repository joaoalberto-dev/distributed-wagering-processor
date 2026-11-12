import type { AppLogger } from '../../application/ports/logger.js';
import type { ProviderIdentityPort } from '../../application/ports/provider-identity.js';

/**
 * Accepts every well-formed `providerId`: authentication is designed (§16)
 * but not implemented. It says so once, at startup, so no deployment runs
 * it unnoticed.
 */
export class TrustAllProviderIdentity implements ProviderIdentityPort {
  constructor(logger: AppLogger) {
    logger.warn(
      'provider authentication is not implemented: every well-formed providerId is trusted',
    );
  }

  authorize(): Promise<void> {
    return Promise.resolve();
  }
}
