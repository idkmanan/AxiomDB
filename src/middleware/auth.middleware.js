import logger from '#config/logger.js';
import { jwttoken } from '#utils/jwt.js';

// A note on log levels here, because it is the same mistake morgan was making.
//
// v0 logged every missing or invalid token at `warn`. A missing token is the
// normal outcome of an unauthenticated request — a scanner walking the API, or a
// browser with an expired session — so `warn` filled the log with events that
// require no action and buried the ones that do. The request logger
// (src/middleware/request-log.middleware.js) already records the 401 with its
// path, ip and duration, so these lines exist only to add the reason, and `debug`
// is the right level for that.
//
// `authorize` failures stay at `warn`: a 403 means an AUTHENTICATED principal
// attempted something outside its role, which is worth noticing.

export const authenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.token;

    if (!token) {
      logger.debug('Authentication failed — no token presented', {
        requestId: req.id,
        path: req.path,
      });
      return res
        .status(401)
        .json({ error: 'Unauthorized', message: 'Authentication token required' });
    }

    const decoded = jwttoken.verify(token);
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (e) {
    logger.debug('Authentication failed — token rejected', {
      requestId: req.id,
      path: req.path,
      reason: e.cause?.message || e.message,
    });
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
};

export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      // Reachable only if `authorize` is mounted without `authenticate` in front
      // of it — a wiring mistake rather than a client error, so it is worth a
      // loud line. Keeping it also means the guard cannot fail open if a future
      // route forgets `authenticate`.
      logger.warn('Authorization check ran with no authenticated user attached', {
        requestId: req.id,
        path: req.path,
      });
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('Authorization failed — insufficient permissions', {
        requestId: req.id,
        userId: req.user.id,
        userRole: req.user.role,
        requiredRoles: allowedRoles,
        path: req.path,
      });
      return res.status(403).json({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    next();
  };
};
