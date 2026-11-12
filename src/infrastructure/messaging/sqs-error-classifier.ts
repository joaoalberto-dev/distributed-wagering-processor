import { OutageError } from '../../application/errors.js';

/** The shape of an AWS SDK v3 service error, as far as classification needs it. */
type SdkError = Error & {
  readonly $fault?: 'client' | 'server';
  readonly $metadata?: { readonly httpStatusCode?: number };
  readonly code?: string;
};

/** Throttling answers are 4xx, but they say SQS cannot take the call now. */
const THROTTLING = new Set([
  'ThrottlingException',
  'RequestThrottled',
  'TooManyRequestsException',
]);

/**
 * Classifies an SQS call's error (§10, Error classes): no HTTP answer at all
 * (refused, reset, timed out), a 5xx, or throttling is an `sqs` outage,
 * which the circuit records. Any other 4xx is the caller's fault and leaves
 * unchanged.
 */
export function classifySqsError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof OutageError) return error;
  const sdk = error as SdkError;
  const status = sdk.$metadata?.httpStatusCode;
  if (THROTTLING.has(sdk.name)) {
    return new OutageError('sqs', `throttled: ${sdk.name}`, { cause: error });
  }
  if (sdk.$fault === 'server' || (status !== undefined && status >= 500)) {
    return new OutageError('sqs', `server error ${status ?? sdk.name}`, {
      cause: error,
    });
  }
  if (status === undefined && sdk.$fault === undefined) {
    return new OutageError('sqs', `no answer: ${sdk.code ?? sdk.name}`, {
      cause: error,
    });
  }
  return error;
}
