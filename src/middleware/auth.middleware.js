import logger from '#config/logger.js';
import { jwttoken } from '#utils/jwt.js';

export const authenticate = async (req, res, next) => {
  try {
    const token = req.cookies?.token;
        
    if (!token) {
      logger.warn('Authentication failed - no token provided', { path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication token required' });
    }

    const decoded = jwttoken.verify(token);
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role
    };

    logger.debug('User authenticated', { userId: req.user.id, email: req.user.email, role: req.user.role });
    next();
  } catch (e) {
    logger.warn('Authentication failed - invalid token', { path: req.path, ip: req.ip, error: e.message });
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
};

export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      logger.warn('Authorization failed - no user attached', { path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('Authorization failed - insufficient permissions', { 
        userId: req.user.id, 
        userRole: req.user.role, 
        requiredRoles: allowedRoles,
        path: req.path 
      });
      return res.status(403).json({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    next();
  };
};