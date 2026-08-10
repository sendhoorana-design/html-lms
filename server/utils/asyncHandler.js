// Express 4 does not catch rejected promises thrown by async route handlers (e.g. a Mongoose
// CastError from a malformed id) — without this, such a request just hangs. Wrap every async
// handler with this so errors are forwarded to the error-handling middleware in index.js.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
