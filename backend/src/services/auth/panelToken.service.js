// JWT des utilisateurs du Panel — signés JWT_SECRET, durée JWT_EXPIRES_IN
// (mêmes conventions que le projet modèle : HS256, sub = userId).
import jwt from 'jsonwebtoken';
import config from '../../config/env.js';

export function issueUserToken(user) {
  return jwt.sign(
    { sub: user.userId, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
}

export function verifyUserToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}
