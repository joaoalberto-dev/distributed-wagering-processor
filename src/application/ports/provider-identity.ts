/**
 * Decides whether the caller may act as `providerId` on a channel. The
 * designed implementation checks a verified token (§16); until then, an
 * adapter accepts every well-formed provider.
 */
export interface ProviderIdentityPort {
  authorize(providerId: string, channel: 'http' | 'sqs'): Promise<void>;
}
