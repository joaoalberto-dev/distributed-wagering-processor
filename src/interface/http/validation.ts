import {
  type ArgumentMetadata,
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
} from '@nestjs/common';
import {
  ValidationFailed,
  type ValidationIssue,
} from '../../application/errors.js';

type Issues = Parameters<
  NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>
>[0];

type PathSegment = Issues[number]['path'] extends
  | ReadonlyArray<infer S>
  | undefined
  ? S
  : never;

function segment(part: PathSegment): string {
  const key = typeof part === 'object' ? part.key : part;
  return String(key);
}

/** Standard Schema issues as `{ path, message }`, with a dotted path. */
export function toValidationIssues(issues: Issues): ValidationIssue[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map(segment).join('.'),
    message: issue.message,
  }));
}

/**
 * The global pipe: validates every argument that declares a `schema` and
 * throws `ValidationFailed`, which the error filter turns into
 * `400 VALIDATION_FAILED` with `details.issues`. A scalar argument (a path
 * parameter, a header) has no path of its own, so its issues are named after
 * the argument.
 */
export class ContractValidationPipe extends StandardSchemaValidationPipe {
  constructor() {
    super({
      exceptionFactory: (issues: Issues) =>
        new ValidationFailed(toValidationIssues(issues)),
    });
  }

  override async transform<T = unknown>(
    value: T,
    metadata: ArgumentMetadata,
  ): Promise<T> {
    try {
      return await super.transform(value, metadata);
    } catch (error) {
      if (!(error instanceof ValidationFailed) || metadata.data === undefined) {
        throw error;
      }
      const name = metadata.data;
      throw new ValidationFailed(
        error.issues.map((issue) => ({
          path: issue.path === '' ? name : `${name}.${issue.path}`,
          message: issue.message,
        })),
      );
    }
  }
}
