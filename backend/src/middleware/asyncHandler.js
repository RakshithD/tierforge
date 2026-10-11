// Wrapper so async route handlers can throw/reject and still reach the Express error middleware (Express 4 does not do this itself).

/** Forward rejected promises from async route handlers to the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
