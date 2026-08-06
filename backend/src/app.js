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

  /**
   * LES RÉPONSES JSON NE SE METTENT PAS EN CACHE.
   *
   * ── LE DÉFAUT ÉVITÉ ─────────────────────────────────────────────────────
   * Les médias sont désormais nommés par l'empreinte de leur contenu et
   * servis « immutable » pour un an. Mais l'adresse d'un média voyage dans du
   * JSON — la fiche d'entreprise, la projection publiée. Si CE JSON était mis
   * en cache, l'ancienne adresse continuerait d'être servie : on aurait rendu
   * les images immuables pour les faire ressusciter par la porte d'à côté.
   *
   * `no-store` plutôt que `no-cache` : ces réponses sont authentifiées et
   * portent des données d'exploitation. Elles n'ont aucune raison de subsister
   * sur un disque intermédiaire.
   */
  app.use(['/api', '/bridge'], (req, res, next) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    next();
  });

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

  /**
   * UN MÉDIA EST IMMUABLE — son nom porte l'empreinte de son contenu.
   *
   * ── POURQUOI « IMMUTABLE » EST ICI LÉGITIME ─────────────────────────────
   * Le nom d'un média est `<mediaId>-<empreinte>.webp` : un contenu différent
   * a forcément une autre adresse, et une adresse donnée ne peut plus jamais
   * désigner autre chose. Le navigateur peut donc le garder un an sans jamais
   * risquer d'afficher une image périmée — c'est exactement ce qu'un paramètre
   * temporel collé à l'URL cherchait à contourner, en supprimant au passage
   * tout bénéfice du cache.
   *
   * Les fichiers au nom HISTORIQUE (sans empreinte) gardent une durée courte :
   * leur adresse ne dépend pas de leur contenu, et les déclarer immuables
   * serait une promesse qu'on ne peut pas tenir.
   */
  app.use('/uploads', express.static(uploadsDir(), {
    fallthrough: true,
    index: false,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      const porteLEmpreinte = /-[0-9a-f]{12}\.[a-z0-9]+$/i.test(filePath);
      res.set('Cache-Control', porteLEmpreinte
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=604800');
    },
  }));

  /**
   * RÉFÉRENCE SUPPRIMÉE — 410 Gone, jamais un 404 muet.
   *
   * Un média retiré laisse son DESCRIPTEUR : on sait donc distinguer « cette
   * adresse n'a jamais existé » (404) de « ce média a été supprimé »  (410).
   * La différence compte : un 410 dit aux navigateurs et aux caches
   * intermédiaires que la ressource est partie POUR DE BON, là où un 404 les
   * laisse réessayer — et laisse l'exploitant se demander si le fichier est
   * perdu ou volontairement retiré.
   *
   * ── PLACÉ APRÈS LE SERVICE STATIQUE, VOLONTAIREMENT ─────────────────────
   * Un média supprimé n'a plus de fichier : il n'arrive donc ici qu'en cas
   * d'absence, et cette lecture en base ne coûte rien sur le chemin normal.
   * L'interroger AVANT ajouterait une requête à chaque image servie, sur une
   * surface publique, pour un cas qui ne se produit qu'après suppression.
   */
  app.use('/uploads', async (req, res, next) => {
    try {
      const nom = decodeURIComponent(String(req.path || '').replace(/^\/+/, ''));
      if (!nom || nom.includes('/')) return next();
      const { findMedia } = await import('./services/upload/mediaDescriptor.service.js');
      const media = await findMedia(nom);
      if (!media?.deletedAt) return next();
      return res
        .status(410)
        .set('Cache-Control', 'no-store')
        .json({
          success: false,
          code: 'PANEL_MEDIA_GONE',
          message: 'Ce média a été supprimé. Cette adresse ne servira plus aucun contenu.',
        });
    } catch {
      return next();
    }
  });
  app.use('/api/deployment', deploymentRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
