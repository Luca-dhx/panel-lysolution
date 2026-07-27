// Démarrage du backend du Panel. Jamais bloquant : pas de réseau, pas de
// base au boot — un `npm run dev` démarre toujours (07_DEPLOYMENT.md §2).
import config from './config/env.js';
import createApp from './app.js';
import logger from './utils/logger.js';
import { seedFromEnv } from './services/auth/panelUsers.service.js';

seedFromEnv();

const app = createApp();
app.listen(config.port, () => {
  logger.success(
    `${config.panelName} — backend démarré (ENV ${config.env}) sur http://localhost:${config.port}`,
  );
});
