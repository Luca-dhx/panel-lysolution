// JWT des utilisateurs du Panel — signés PANEL_JWT_SECRET, durée courte.
import jwt from 'jsonwebtoken';
import config from '../../config/env.js';

const TOKEN_TTL = '12h';

export function issueUserToken(user) {
  return jwt.sign(
    { sub: user.userId, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL },
  );
}

export function verifyUserToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}
