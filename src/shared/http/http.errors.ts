/**
 * Typed HTTP errors. The centralized error handler in app.ts maps
 * `statusCode` to the response status; 5xx messages are never leaked to clients.
 */
export class HttpError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string = 'Bad request') {
    super(message, 400);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string = 'Forbidden') {
    super(message, 403);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string = 'Not found') {
    super(message, 404);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string = 'Conflict') {
    super(message, 409);
  }
}
