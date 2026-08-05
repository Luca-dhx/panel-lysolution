// Assemblage Express du Panel — deux surfaces strictement séparées :
//   /bridge/v1  contrat de pont (projets, bridgeToken, erreurs BRIDGE_*)
//   /api        surface interne (frontend, JWT utilisateur, erreurs PANEL_*)
//   /health     vivacité publique
import express from 'express';
import { uploadsDir } from './services/upload/upload.service.js';
import { resolveMediaAuthority, relayToAuthority } from './services/upload/mediaAuthority.js';
import corsMiddleware from './middlewares/cors.middleware.js';
import bridgeRoutes from './routes/bridge.routes.js';
import authRoutes from './routes/auth.routes.js';
import projectsRoutes from './routes/projects.routes.js';
import eventsRoutes from './routes/events.routes.js';
import themeRoutes from './routes/theme.routes.js';
import networkRoutes from './routes/network.routes.js';
import supervisionRoutes from './routes/supervision.routes.js';
import diagnosticRoutes from './routes/diagnostic.routes.js';
import executionRoutes from './routes/execution.routes.js';
import companyRoutes from './routes/company.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import deploymentRoutes from './routes/deployment.routes.js';
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
  app.use('/api', eventsRoutes);
  app.use('/api/theme', themeRoutes);
  app.use('/api/system-configuration', networkRoutes);
  app.use('/api/supervision', supervisionRoutes);
  app.use('/api/diagnostic', diagnosticRoutes);
  app.use('/api/executions', executionRoutes);
  app.use('/api/company', companyRoutes);
  app.use('/api/uploads', uploadRoutes);
  /**
   * Les médias importés sont servis en STATIQUE, et publiquement.
   *
   * Le logo de l'entreprise est affiché par le pied de page de chaque projet :
   * exiger un jeton le rendrait invisible aux visiteurs. Le dossier ne contient
   * que des images réécrites par sharp — jamais un fichier déposé tel quel.
   */
  /**
   * LECTURE D'UN MÉDIA — depuis l'autorité, jamais depuis un disque local.
   *
   * Une instance CLIENTE n'a pas les fichiers : les servir depuis son propre
   * dossier renverrait un 404 pour un média qui existe pourtant. Elle relaie
   * donc la lecture, et le navigateur ne s'adresse qu'à son propre backend —
   * ni adresse d'autorité, ni jeton ne transitent par lui.
   *
   * L'autorité, elle, passe directement au service statique ci-dessous.
   */
  app.use('/uploads', async (req, res, next) => {
    try {
      const { authority, isAuthority } = await resolveMediaAuthority();
      if (isAuthority || !authority) return next();

      const amont = await relayToAuthority(authority, `/uploads${req.path}`, { method: 'GET' });
      if (!amont.ok) return next();

      const type = amont.headers.get('content-type');
      if (type) res.type(type);
      // Le cache suit celui de l’autorité : deux durées différentes feraient
      // réapparaître une image remplacée sur une seule des deux surfaces.
      const cache = amont.headers.get('cache-control');
      if (cache) res.set('cache-control', cache);

      return res.status(amont.status).send(Buffer.from(await amont.arrayBuffer()));
    } catch {
      // L'autorité injoignable ne doit pas casser la requête : on laisse le
      // service statique répondre, puis le 404 canonique.
      return next();
    }
  });

  app.use('/uploads', express.static(uploadsDir(), {
    maxAge: '7d',
    fallthrough: true,
    index: false,
    dotfiles: 'deny',
  }));
  app.use('/api/deployment', deploymentRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
