const jwt = require('jsonwebtoken');
const { get } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Set it before starting the server.');
}
const TOKEN_TTL = '12h';

function signToken(employee) {
  return jwt.sign(
    { id: employee.id, role: employee.role, name: employee.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // re-check against the DB every request — so deactivating someone takes effect
    // immediately instead of waiting for their existing token to expire.
    const emp = await get('SELECT active, role FROM employees WHERE id=?', [payload.id]);
    if (!emp || !emp.active) {
      return res.status(401).json({ error: 'This account has been deactivated. Contact HR.' });
    }
    req.user = { ...payload, role: emp.role }; // role reflects current DB state, not the token's snapshot
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole };
