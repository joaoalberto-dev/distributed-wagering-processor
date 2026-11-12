import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/app-config.js';

export type SqsClientOptions = {
  /** Attempts per call, the SDK's own retries included; the SDK default when absent. */
  readonly maxAttempts?: number;
};

/** An SQS client for the configured endpoint (MiniStack locally). */
export function createSqsClient(
  config: Pick<AppConfig, 'aws'>,
  options: SqsClientOptions = {},
): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpointUrl,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });
}
