// CE QU'ON DIT QUAND UN ÉVÉNEMENT FOURNISSEUR NE S'APPLIQUE PAS.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Reprise après incident ».
//
// ── POURQUOI CE MODULE EXISTE ───────────────────────────────────────────────
//
// Le bail rend un traitement abandonné REPRENABLE ; il ne le rend pas VISIBLE.
// Un événement qui échoue cinq fois puis part en `DEAD_LETTER` sans que
// personne ne l'apprenne est le même défaut qu'avant sous un autre nom : un
// fait financier manquant, et rien pour le dire.
//
// ── PAS DE NOUVEAU MODÈLE D'E-MAIL ──────────────────────────────────────────
//
// La chronologie de supervision existe, elle est déjà relue, et elle porte déjà
// les incidents. Ajouter un template pour ce lot aurait créé un second canal à
// maintenir pour un public identique.
//
// ── CE QUI N'ENTRE JAMAIS ICI ───────────────────────────────────────────────
//
// Le corps de l'événement, une clé, un secret, un e-mail de client. Un message
// de supervision est relu longtemps après, par plus de monde que le flux qu'il
// décrit. Il porte un identifiant d'événement, un type, un compte de tentatives,
// un âge et un motif tronqué — de quoi agir, rien de plus.
import logger from '../../utils/logger.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import { recordEvent } from '../supervision/timeline.service.js';
import { WEBHOOK_EVENT_STATUS } from '../../models/PanelProviderWebhookEvent.model.js';
import { MAX_PROCESSING_ATTEMPTS, ageSeconds } from './webhookLease.js';

/**
 * « CONSTAT DU PANEL », ET NON « WEBHOOK ».
 *
 * L'énumération des sources est FERMÉE — `PROJECT`, `PANEL_OBSERVATION`,
 * `PANEL` — et elle décrit QUI PARLE, pas de quoi il parle. Un événement
 * fournisseur qui ne s'applique pas n'est ni une déclaration du projet ni un
 * acte d'un opérateur : c'est le Panel qui constate. Ajouter `WEBHOOK` aurait
 * mélangé deux axes dans un même champ, et le premier lecteur d'une
 * chronologie l'aurait payé.
 */
const SOURCE = 'PANEL_OBSERVATION';

/**
 * Un échec de traitement, classé par son ISSUE et non par sa cause.
 *
 * `DEAD_LETTER` → on a renoncé : file de travail humaine (`_STUCK`, ERROR).
 * Autre        → une reprise viendra : trace forensique (`_FAILED`, WARNING).
 */
export async function reportWebhookProcessingFailure({
  provider, environment, providerEventId, eventType,
  projectId = null, attempts = 0, status, cause = {},
} = {}) {
  const abandonne = status === WEBHOOK_EVENT_STATUS.DEAD_LETTER;
  const type = abandonne ? EVENT_TYPES.WEBHOOK_PROCESSING_STUCK : EVENT_TYPES.WEBHOOK_PROCESSING_FAILED;

  const resume = abandonne
    ? `${provider}/${environment} : ${eventType || 'événement'} ${providerEventId} ABANDONNÉ après `
      + `${attempts} tentative(s) — ${cause.retryable === false ? 'erreur terminale' : `plafond de ${MAX_PROCESSING_ATTEMPTS} atteint`}.`
    : `${provider}/${environment} : ${eventType || 'événement'} ${providerEventId} en échec `
      + `(tentative ${attempts}/${MAX_PROCESSING_ATTEMPTS}) — reprise attendue.`;

  if (abandonne) logger.error(`[webhooks] ${resume}`);
  else logger.warn(`[webhooks] ${resume}`);

  await recordEvent({
    projectId,
    type,
    source: SOURCE,
    severity: abandonne ? 'ERROR' : 'WARNING',
    summary: resume,
    data: {
      provider,
      environment,
      providerEventId,
      eventType: eventType || null,
      attempts,
      status,
      errorCode: cause.code ?? null,
      /** Tronqué : un message d'erreur peut contenir un fragment de charge utile. */
      errorMessage: String(cause.message ?? '').slice(0, 200),
      retryable: cause.retryable ?? null,
    },
  });
}

/**
 * CE QUE L'AMORÇAGE A TROUVÉ EN ARRIVANT — un seul événement, pas N.
 *
 * Un redémarrage qui découvre quarante événements abandonnés en écrirait
 * quarante, et noierait la chronologie du projet dans un incident qui n'en est
 * qu'un. On résume : combien, de quel âge, et lesquels — les premiers, nommés.
 */
export async function reportAbandonedSweep({ environment, abandoned = [], recovered = 0, now = Date.now() } = {}) {
  if (abandoned.length === 0) return null;
  const ages = abandoned.map((e) => ageSeconds(e, now)).filter((n) => Number.isFinite(n));
  const plusVieux = ages.length ? Math.max(...ages) : null;
  const resume = `${abandoned.length} événement(s) fournisseur abandonné(s) repris au démarrage `
    + `(${recovered} réappliqué(s), le plus ancien remonte à ${plusVieux ?? '?'} s).`;
  logger.warn(`[webhooks] ${resume}`);
  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.WEBHOOK_PROCESSING_FAILED,
    source: SOURCE,
    severity: 'WARNING',
    summary: resume,
    data: {
      environment,
      abandoned: abandoned.length,
      recovered,
      oldestAgeSeconds: plusVieux,
      /** Les dix premiers suffisent à ouvrir une enquête ; la liste entière la noierait. */
      sample: abandoned.slice(0, 10).map((e) => ({
        provider: e.provider,
        providerEventId: e.providerEventId,
        eventType: e.eventType || null,
        status: e.status,
        attempts: e.processingAttempts ?? 0,
      })),
    },
  });
  return resume;
}

export default { reportWebhookProcessingFailure, reportAbandonedSweep };
