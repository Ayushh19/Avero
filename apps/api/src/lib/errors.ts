import { ERROR_STATUS, type ErrorCode } from '@avero/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Please sign in to continue');
