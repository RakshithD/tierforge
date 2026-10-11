// Error handling: the HttpError type, the 404 fallback and the central error-to-JSON middleware.

// Error carrying an HTTP status and machine-readable code; thrown by services/controllers.
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Fallback for any unmatched route; forwards a 404 HttpError to errorHandler.
export function notFound(_req, _res, next) {
  next(new HttpError(404, 'NOT_FOUND', 'Route not found'));
}

// eslint-disable-next-line no-unused-vars
// Central error middleware. Responds with { error: { code, message, details } }.
// Unknown errors are logged and returned as a generic 500 so internals never leak.
export function errorHandler(err, _req, res, _next) {
  let status = err.status || 500;
  let code = err.code;
  let message = err.message;

  if (err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR';
  } else if (!(err instanceof HttpError)) {
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Unexpected server error';
    console.error(err);
  }

  res.status(status).json({ error: { code, message, details: err.details || [] } });
}
