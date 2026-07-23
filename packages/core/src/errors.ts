export class AppError extends Error {
  constructor(
    public readonly type: 'NotFound' | 'Unauthorized' | 'Forbidden' | 'Validation' | 'Internal' | 'Redirect',
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static notFound(message = 'Not Found'): AppError {
    return new AppError('NotFound', message, 404);
  }

  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError('Unauthorized', message, 401);
  }

  static forbidden(message = 'Forbidden'): AppError {
    return new AppError('Forbidden', message, 403);
  }

  static validation(message: string): AppError {
    return new AppError('Validation', message, 422);
  }

  static internal(message = 'Internal Server Error'): AppError {
    return new AppError('Internal', message, 500);
  }

  static redirect(path: string): AppError {
    return new AppError('Redirect', path, 303);
  }
}

export type AppResult<T> = 
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export const success = <T>(data: T): AppResult<T> => ({ ok: true, data });
export const failure = (error: AppError): AppResult<any> => ({ ok: false, error });

export interface HookError {
  status: number;
  message: string;
  source?: string;
}

export class StartupError extends Error {
  constructor(
    public readonly code: 'ConfigLoad' | 'UnsupportedProvider' | 'RemovedOption',
    message: string
  ) {
    super(message);
    this.name = 'StartupError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
