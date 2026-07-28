// Assemblage Express du Panel — deux surfaces strictement séparées :
//   /bridge/v1  contrat de pont (projets, bridgeToken, erreurs BRIDGE_*)
//   /api        surface interne (frontend, JWT utilisateur, erreurs PANEL_*)
//   /health     vivacité publique
import express from 'express';
import corsMiddleware from './middlewares/cors.middleware.js';
import bridgeRoutes from './routes/bridge.routes.js';
import authRoutes from './routes/auth.routes.js';
import projectsRoutes from './routes/projects.routes.js';
import networkRoutes from './routes/network.routes.js';
import supervisionRoutes from './routes/supervision.routes.js';
import diagnosticRoutes from './routes/diagnostic.routes.js';
import { healthRouter, versionRouter } from './routes/meta.routes.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));

  app.use('/health', healthRouter);
  app.use('/api/version', versionRouter);
  app.use('/bridge/v1', bridgeRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api/system-configuration', networkRoutes);
  app.use('/api/supervision', supervisionRoutes);
  app.use('/api/diagnostic', diagnosticRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
