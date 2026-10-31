export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (message = 'Bad request', details, code = 'BAD_REQUEST') => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHENTICATED') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message = 'Conflict', code = 'CONFLICT', details) => new AppError(409, code, message, details);
export const unprocessable = (message, details, code = 'UNPROCESSABLE') => new AppError(422, code, message, details);
export const badGateway = (message = 'Payment provider error', code = 'GATEWAY_ERROR') => new AppError(502, code, message);

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
