import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/app-config.js';

/** An SQS client for the configured endpoint (MiniStack locally). */
export function createSqsClient(config: Pick<AppConfig, 'aws'>): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpointUrl,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
  });
}
