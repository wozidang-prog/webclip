export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) =>
  new AppError(msg, { status: 400, code: 'bad_request', details });
export const unauthorized = (msg = '缺少或错误的 API Token') =>
  new AppError(msg, { status: 401, code: 'unauthorized' });
export const forbidden = (msg) => new AppError(msg, { status: 403, code: 'forbidden' });
export const notFound = (msg = '资源不存在') => new AppError(msg, { status: 404, code: 'not_found' });
export const timeout = (msg, details) =>
  new AppError(msg, { status: 504, code: 'timeout', details });
export const upstream = (msg, details) =>
  new AppError(msg, { status: 502, code: 'upstream_error', details });

export function describeError(err) {
  if (!err) return { message: 'unknown error' };
  if (err instanceof AppError) {
    return { message: err.message, code: err.code, details: err.details };
  }
  return { message: err.message || String(err), code: err.code || err.name || 'error' };
}
