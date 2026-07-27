// Journalisation minimale, sans dépendance, injectable dans les services.
// Discipline : jamais un secret (token, code, mot de passe) dans un log.
import config from '../config/env.js';

function line(level, message) {
  const time = new Date().toISOString();
  return `[${time}] [${level}] ${message}`;
}

export const logger = {
  info: (message) => console.log(line('info', message)),
  success: (message) => console.log(line('ok', message)),
  warn: (message) => console.warn(line('warn', message)),
  error: (message) => console.error(line('error', message)),
  debug: (message) => {
    if (config.debug) console.log(line('debug', message));
  },
};

export default logger;
