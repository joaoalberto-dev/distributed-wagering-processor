import { describe, expect, it } from 'bun:test';
import { OutageError } from '../../application/errors.js';
import { classifySqsError } from './sqs-error-classifier.js';

function sdkError(
  name: string,
  fault: 'client' | 'server',
  status: number,
): Error {
  return Object.assign(new Error(name), {
    name,
    $fault: fault,
    $metadata: { httpStatusCode: status },
  });
}

describe('classifySqsError', () => {
  it('classifies a refused connection as an sqs outage', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const classified = classifySqsError(refused);
    expect(classified).toBeInstanceOf(OutageError);
    expect((classified as OutageError).dependency).toBe('sqs');
    expect((classified as OutageError).cause).toBe(refused);
  });

  it('classifies a 5xx as an outage', () => {
    expect(
      classifySqsError(sdkError('InternalError', 'server', 500)),
    ).toBeInstanceOf(OutageError);
    expect(
      classifySqsError(sdkError('ServiceUnavailable', 'client', 503)),
    ).toBeInstanceOf(OutageError);
  });

  it('classifies throttling as an outage', () => {
    expect(
      classifySqsError(sdkError('RequestThrottled', 'client', 403)),
    ).toBeInstanceOf(OutageError);
  });

  it('leaves another 4xx unchanged', () => {
    const missing = sdkError('QueueDoesNotExist', 'client', 400);
    expect(classifySqsError(missing)).toBe(missing);
  });

  it('leaves non-errors and outages unchanged', () => {
    const outage = new OutageError('sqs', 'circuit open');
    expect(classifySqsError(outage)).toBe(outage);
    expect(classifySqsError('x')).toBe('x');
  });
});
