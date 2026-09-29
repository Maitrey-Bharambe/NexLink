import { authenticateToken, AuthError } from '../services/auth.js';
import { ROLES } from '../models/User.js';

/** Require a valid Bearer token; attaches req.user and req.session. */
export async function requireAuth(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new AuthError('Sign in required.');
    const { user, session } = await authenticateToken(token);
    req.user = user;
    req.session = session;
    next();
  } catch (err) {
    next(err);
  }
}

/** Role hierarchy: admin > operator > viewer. */
export function requireRole(minRole) {
  const need = ROLES.length - ROLES.indexOf(minRole);
  return (req, _res, next) => {
    const have = ROLES.length - ROLES.indexOf(req.user?.role);
    if (!req.user || have < need) {
      return next(new AuthError(`This action requires the ${minRole} role.`, 403, 'FORBIDDEN'));
    }
    next();
  };
}
