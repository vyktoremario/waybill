/** Domain errors. The HTTP layer maps them to status codes; the worker treats them as permanent failures. */
export class DomainError extends Error {
  constructor(
    public readonly code: 'conflict' | 'forbidden' | 'not_found' | 'invalid' | 'locked',
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const conflict = (message: string, details: Record<string, unknown> = {}) => new DomainError('conflict', message, details);
export const forbidden = (message: string) => new DomainError('forbidden', message);
export const notFound = (message: string) => new DomainError('not_found', message);
export const invalid = (message: string, details: Record<string, unknown> = {}) => new DomainError('invalid', message, details);
