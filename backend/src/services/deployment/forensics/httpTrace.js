/**
 * TRACE HTTP DES ROUTES DE DÉPLOIEMENT — ciblée, pas globale.
 *
 * ══ POURQUOI PAS `morgan` ═══════════════════════════════════════════════════
 *
 * Un journal d'accès global dit « POST /api/... 500 » et s'arrête là. Il ne dit
 * ni quel run, ni si le flux a été ouvert, ni si le client a raccroché, ni si
 * les en-têtes étaient déjà partis quand l'erreur est survenue — c'est-à-dire
 * précisément ce qui distingue une erreur applicative d'un process qui meurt.
 *
 * Ce middleware ne couvre que les routes de déploiement, et enregistre ce qui
 * permet de trancher :
 *
 *   · `headersSent` au moment de l'erreur — après envoi, Express ne peut plus
 *     répondre : le client voit un flux tronqué, pas un 500 ;
 *   · l'interruption CLIENT (`aborted`) distinguée de la fin normale ;
 *   · la durée, qui sépare « refusé tout de suite » de « resté pendu ».
 *
 * ══ LA TRACE EXISTE AVANT LE RUN ════════════════════════════════════════════
 *
 * Une `DeploymentAttempt` est ouverte à la PREMIÈRE ligne. Si la requête casse
 * avant `createRun`, la trace subsiste quand même : « aucun run n'a été créé,
 * donc on ne sait pas » cesse d'être une réponse possible.
 */
import {
  EVENTS, LEVELS, SOURCES, closeAttempt, journalAttempt, newRequestId, openAttempt,
} from './runJournal.service.js';
import { sanitizeHeaders, sanitizeValue } from './sanitize.js';
import { deduireCauseCoupure, niveauPourCause } from './streamCause.js';

/** Les routes instrumentées — nommées, jamais devinées par motif large. */
/**
 * LES ROUTES INSTRUMENTÉES DU PANEL.
 *
 * Elles diffèrent de celles de SB Auto parce que la surface diffère : le Panel
 * ne tient pas de session serveur (le mot de passe est demandé à chaque
 * opération) et ses opérations sont imbriquées sous `/targets/:id/…`. Les
 * ÉVÈNEMENTS et la sémantique, eux, sont identiques.
 */
export const ROUTES_TRACEES = [
  '/deploy',
  '/preflight',
  '/simulate',
  '/test-connection',
  '/rollback',
  '/inspect',
  '/deprovision',
  '/delete',
];

/** Les opérations du Panel vivent sous `/targets/:id/<action>`. */
const tracee = (chemin) => ROUTES_TRACEES.some((r) => chemin === r || chemin.endsWith(r));

/**
 * Middleware Express — à monter sur le routeur de déploiement.
 *
 * Il expose `req.forensics` : `{ requestId, attemptId, note(), lier() }`.
 * Les contrôleurs s'en servent pour rattacher leur run à la tentative, et
 * pour journaliser ce qu'eux seuls savent.
 */
export function traceDeploymentRequests() {
  return async (req, res, next) => {
    if (!tracee(req.path)) return next();

    const requestId = req.get('x-request-id') || newRequestId();
    const debut = Date.now();
    let runId = null;
    /* Des FAITS, relevés au fil de l'eau — jamais des conclusions. */
    let clientAAbandonne = false;
    let ecritureEchouee = false;
    let redemarrageAnnonce = false;

    const attempt = await openAttempt({
      requestId,
      route: `${req.baseUrl}${req.path}`,
      method: req.method,
      // La cible n'est pas encore résolue : le contrôleur la fournira.
      targetId: null,
      user: req.user?.email ?? null,
    });
    const attemptId = attempt?._id ?? null;

    /**
     * L'API offerte aux contrôleurs.
     *
     * `note()` écrit dans le run s'il existe, dans la tentative sinon : le
     * même appel fonctionne des deux côtés de la création du run, ce qui évite
     * au contrôleur d'avoir à savoir où il en est.
     */
    req.forensics = {
      requestId,
      attemptId,
      get runId() { return runId; },
      async lier(id, targetId = null) {
        runId = id;
        await closeAttempt(attemptId, { runId: id, status: 'open' });
        if (targetId) {
          const PanelDeploymentAttempt = (await import('../../../models/PanelDeploymentAttempt.model.js')).default;
          await PanelDeploymentAttempt.updateOne({ _id: attemptId }, { $set: { target: targetId } }).catch(() => {});
        }
      },
      /** Le contrôleur déclare un redémarrage annoncé : c'est un FAIT, pas une déduction. */
      annoncerRedemarrage() { redemarrageAnnonce = true; },
      async note(entree) {
        const complet = { ...entree, requestId };
        if (runId) {
          const { journal } = await import('./runJournal.service.js');
          return journal(runId, complet);
        }
        return journalAttempt(attemptId, complet);
      },
    };

    await req.forensics.note({
      source: SOURCES.HTTP,
      level: LEVELS.INFO,
      eventCode: EVENTS.HTTP_REQUEST_STARTED,
      message: `${req.method} ${req.baseUrl}${req.path}`,
      details: { headers: sanitizeHeaders(req.headers), query: sanitizeValue(req.query) },
    });

    /**
     * L'ENVOI DES EN-TÊTES marque l'ouverture du flux.
     *
     * Après ce point, une erreur ne peut plus produire de réponse HTTP : le
     * client verra un flux coupé. La distinction est capitale — c'est elle qui
     * sépare « 500 applicatif » de « le process est mort en cours de route ».
     */
    const flushOriginal = res.flushHeaders?.bind(res);
    if (flushOriginal) {
      res.flushHeaders = () => {
        void req.forensics.note({
          source: SOURCES.HTTP,
          level: LEVELS.INFO,
          eventCode: EVENTS.HTTP_STREAM_OPENED,
          message: 'Flux ouvert : les en-têtes sont partis.',
          details: { contentType: res.getHeader('content-type') ?? null },
        });
        return flushOriginal();
      };
    }

    /**
     * L'ÉCRITURE DANS LE FLUX PEUT ÉCHOUER ALORS QUE LE BACKEND VIT.
     *
     * C'est un cas distinct de tous les autres : si nous sommes encore là pour
     * constater l'échec, ce n'est pas nous qui sommes morts — le canal de
     * réponse est rompu en aval. On l'enregistre à part, sans le confondre
     * avec un plantage ni avec un client qui raccroche.
     */
    const writeOriginal = res.write.bind(res);
    res.write = (...args) => {
      try {
        return writeOriginal(...args);
      } catch (err) {
        ecritureEchouee = true;
        void req.forensics.note({
          source: SOURCES.HTTP,
          level: LEVELS.ERROR,
          eventCode: EVENTS.HTTP_STREAM_WRITE_FAILED,
          message: `Écriture dans le flux impossible : ${err.message}`,
          error: err,
          details: { headersSent: res.headersSent, elapsedMs: Date.now() - debut },
        });
        return false;
      }
    };

    // Le CLIENT a raccroché — onglet fermé, refresh, réseau coupé.
    req.on('aborted', () => {
      clientAAbandonne = true;
      void req.forensics.note({
        source: SOURCES.HTTP,
        level: LEVELS.WARNING,
        eventCode: EVENTS.HTTP_STREAM_ABORTED,
        message: 'Le client a interrompu la requête. L’opération serveur, elle, se poursuit.',
        details: { headersSent: res.headersSent, elapsedMs: Date.now() - debut },
      });
    });

    res.on('finish', () => {
      void req.forensics.note({
        source: SOURCES.HTTP,
        level: res.statusCode >= 500 ? LEVELS.ERROR : LEVELS.INFO,
        eventCode: res.statusCode >= 500 ? EVENTS.HTTP_REQUEST_FAILED : EVENTS.HTTP_RESPONSE_COMPLETED,
        message: `Réponse ${res.statusCode} en ${Date.now() - debut} ms.`,
        details: { status: res.statusCode, durationMs: Date.now() - debut, headersSent: res.headersSent },
      });
      void closeAttempt(attemptId, {
        runId,
        status: res.statusCode >= 500 ? 'failed' : 'closed',
        httpStatus: res.statusCode,
      });
    });

    // La socket se ferme SANS `finish` : réponse jamais terminée. C'est la
    // signature d'un process qui meurt au milieu de son travail.
    /**
     * LA SOCKET SE FERME — c'est ici qu'on tranche, sur des faits.
     *
     * Quatre pannes très différentes produisent le même symptôme côté client :
     * une réponse tronquée. On rassemble donc ce qu'on a OBSERVÉ, et on ne
     * déduit une cause que lorsque ces faits la déterminent. Quand ils ne la
     * déterminent pas, `INDETERMINE` est la réponse honnête — bien plus utile
     * qu'une cause inventée qu'on croira sur parole.
     */
    res.on('close', () => {
      if (res.writableFinished) {
        void req.forensics.note({
          source: SOURCES.HTTP, level: LEVELS.INFO,
          eventCode: EVENTS.HTTP_STREAM_COMPLETED,
          message: 'Flux terminé normalement.',
          details: { durationMs: Date.now() - debut },
        });
        return;
      }

      const verdict = deduireCauseCoupure({
        headersSent: res.headersSent,
        writableFinished: res.writableFinished,
        requestAborted: clientAAbandonne || req.aborted === true,
        restartExpected: redemarrageAnnonce,
        writeFailed: ecritureEchouee,
        // Nous exécutons ce rappel : le process est donc vivant à cet instant.
        processAlive: true,
      });

      void req.forensics.note({
        source: SOURCES.HTTP,
        level: niveauPourCause(verdict.cause),
        eventCode: ecritureEchouee ? EVENTS.HTTP_STREAM_WRITE_FAILED : EVENTS.HTTP_STREAM_ABORTED,
        message: verdict.explication,
        errorCode: verdict.cause,
        details: {
          /* Ce qu'on a VU. */
          faits: { ...verdict.faits, elapsedMs: Date.now() - debut, statusCode: res.statusCode, pid: process.pid },
          /* Ce qu'on en DÉDUIT — et si la déduction est certaine. */
          causeDeduite: verdict.cause,
          certain: verdict.certain,
        },
        pid: process.pid,
      });
      void closeAttempt(attemptId, { runId, status: 'failed', httpStatus: res.statusCode });
    });

    return next();
  };
}

/**
 * Middleware d'ERREUR — enregistre l'exception AVANT qu'Express ne réponde.
 *
 * Placé sur le routeur de déploiement, il capture la pile là où elle a encore
 * un sens, puis relaie au traitement d'erreur habituel.
 */
export function traceDeploymentErrors() {
  return async (err, req, res, next) => {
    if (req.forensics) {
      await req.forensics.note({
        source: SOURCES.HTTP,
        level: LEVELS.ERROR,
        eventCode: EVENTS.HTTP_REQUEST_FAILED,
        message: err.message,
        errorCode: err.code ?? err.details?.code ?? null,
        error: err,
        details: { statusCode: err.statusCode ?? 500, headersSent: res.headersSent },
      }).catch(() => {});
    }
    return next(err);
  };
}

export default { traceDeploymentRequests, traceDeploymentErrors, ROUTES_TRACEES };
