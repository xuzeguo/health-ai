import { ERROR_DEFINITIONS, type ErrorCode } from '@health-ai/shared';

export class AppError extends Error {
  readonly statusCode: number;

  constructor(public readonly code: ErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'AppError';
    this.statusCode = definition.status;
  }
}
