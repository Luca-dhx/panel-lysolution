// « CE PROJET REÇOIT-IL ENCORE CE QU'ON LUI ENVOIE ? »
//
// ══ LE DÉFAUT QUE CE MODULE FERME, TEL QU'IL S'EST PRODUIT ══════════════════
//
// Un projet du parc a tourné 91 cycles consécutifs avec :
//
//     applied: 0        aucune écriture appliquée
//     lastError: null   aucune erreur
//     state: DEGRADED   un état que personne ne lisait
//
// Le tirage était mort depuis la deuxième écriture du journal : une entité
// illisible faisait échouer la validation de la page ENTIÈRE, le curseur
// n'avançait jamais, et le cycle suivant redemandait la même page. Tout ce qui
// arrivait encore du Panel passait par la livraison immédiate — un
// accélérateur, pas une garantie.
//
// Rien de tout cela n'était visible depuis le Panel. Sa fiche restait verte, et
// pour une raison parfaitement logique : le battement prouvait que le projet
// RÉPONDAIT, la file sortante était vide, et aucun champ ne décrivait la
// descente.
//
// ══ POURQUOI « LE CURSEUR N'AVANCE PLUS » NE SUFFIT PAS ═════════════════════
//
// C'est le premier réflexe, et il est faux. Un curseur qui n'avance pas est
// l'état NORMAL et majoritaire : un projet à jour, dont rien n'a changé, ne
// consomme rien pendant des semaines. Alerter là-dessus produirait un signal
// permanent que tout le monde apprendrait à ignorer — et le jour où le tirage
// mourrait vraiment, personne ne le lirait.
//
// ══ LE SIGNAL JUSTE : L'ÂGE DU RETARD ═══════════════════════════════════════
//
// Le Panel sait deux choses que le projet ignore :
//
//   · ce qu'il a ÉMIS pour ce projet — son journal, avec des séquences ;
//   · ce que le projet déclare avoir CONSOMMÉ — son curseur, au battement.
//
// La différence est un RETARD, et ce retard a un ÂGE : la date de la plus
// ancienne écriture que le projet n'a pas encore prise. Un retard de quelques
// secondes est le fonctionnement normal ; un retard d'une heure sur une
// écriture qu'on lui a poussée dix fois est une panne.
//
// C'est le seul signal qui distingue « rien à recevoir » de « ne reçoit plus ».
//
// ══ CE MODULE NE DÉCIDE RIEN, IL CONSTATE ══════════════════════════════════
//
// Il ne notifie pas, n'écrit pas, ne lève jamais. L'alerte est un autre métier
// — voir `bridgeAlerting.service.js` — et un constat qui alerterait ne pourrait
// plus servir à peindre un écran.
import { PanelSyncJournalEntry } from '../../models/PanelSyncState.model.js';

/**
 * LES SEUILS — écrits une fois, et justifiés chacun.
 *
 * Aucun n'est rond par hasard : un seuil qu'on ne sait pas justifier finit par
 * être « ajusté » au premier faux positif, jusqu'à ne plus rien détecter.
 */
export const CONSUMPTION_THRESHOLDS = Object.freeze({
  /**
   * ÉCHECS DE TIRAGE CONSÉCUTIFS.
   *
   * Le tirage tourne toutes les deux minutes. Trois échecs de suite couvrent
   * six minutes — assez pour absorber un redémarrage du Panel, une coupure
   * réseau brève ou une release, trop peu pour laisser passer une panne.
   */
  PULL_FAILURES: 3,
  /**
   * ÉCRITURES ILLISIBLES CONSÉCUTIVES.
   *
   * Le seuil est BAS, et c'est délibéré : une écriture illisible est une PERTE
   * DÉFINITIVE — le curseur avance, le Panel ne la relivrera pas, et seule une
   * nouvelle publication la ramènera. Deux de suite ne sont plus un accident de
   * format : c'est un désaccord de contrat entre les deux côtés.
   */
  UNREADABLE_CHANGES: 2,
  /**
   * ÂGE DU RETARD, EN MINUTES.
   *
   * Trente minutes valent quinze cycles de tirage manqués. En dessous, on
   * décrirait comme une panne un projet simplement éteint pour une release ou
   * un redémarrage de VPS — et l'alerte deviendrait du bruit de déploiement.
   */
  BACKLOG_AGE_MINUTES: 30,
});

/** Les verdicts. Trois, et `UNKNOWN` n'est jamais confondu avec `HEALTHY`. */
export const CONSUMPTION_STATUS = Object.freeze({
  /** Le projet consomme, ou n'a rien à consommer. */
  HEALTHY: 'HEALTHY',
  /** Le projet ne dit rien de sa consommation — contrat antérieur à 1.10.0. */
  UNKNOWN: 'UNKNOWN',
  /** Quelque chose ne descend plus. Les motifs sont nommés. */
  DEGRADED: 'DEGRADED',
});

/** Les motifs, nommés — un écran les affiche tels quels. */
export const CONSUMPTION_REASONS = Object.freeze({
  PULL_FAILING: 'PULL_FAILING',
  CHANGES_UNREADABLE: 'CHANGES_UNREADABLE',
  BACKLOG_STALE: 'BACKLOG_STALE',
  /**
   * DES ÉCRITURES ONT ÉTÉ GARÉES (contrat >= 1.12.0).
   *
   * Le projet a épuisé ses tentatives d'application et est passé outre. Ces
   * écritures sont désormais SOUS son curseur : le calcul de retard ci-dessous
   * ne les verra jamais, et sans ce signal elles seraient parfaitement
   * invisibles depuis le Panel.
   *
   * Le seuil est UN. Contrairement au retard — dont l'état normal est d'exister
   * quelques secondes — une écriture garée n'a aucun état normal : elle est un
   * renoncement, et il n'y en a jamais « un peu ».
   */
  CHANGES_PARKED: 'CHANGES_PARKED',
  /**
   * LE CONSOMMATEUR EST RETENU SUR UNE ÉCRITURE QU'IL NE SAIT PAS TRAITER
   * (contrat >= 1.15.0).
   *
   * ══ L'INCIDENT QUI A CRÉÉ CE MOTIF ═══════════════════════════════════════
   *
   * Le Panel est monté en 1.14.0 et a publié `LEGAL_DOCUMENT` vers des projets
   * encore en 1.13.0. Ils ont SAUTÉ le type inconnu — leur curseur a dépassé
   * les écritures — et le Panel a vu un retard nul, une fiche verte, et une
   * synchronisation « réussie ». Les documents n'existaient nulle part.
   *
   * Depuis 1.15.0, un consommateur qui ne sait pas traiter une écriture RETIENT
   * son curseur et le DÉCLARE. Ce motif est la lecture de cette déclaration, et
   * il empêche le seul verdict qu'on ne peut pas se permettre ici : « tout va
   * bien ».
   *
   * ══ CE N'EST PAS `CHANGES_PARKED` ═══════════════════════════════════════
   *
   * Une écriture GARÉE est un renoncement : elle est passée sous le curseur, et
   * seule une republication la ramènera. Une écriture RETENUE est une attente :
   * elle est toujours dans le journal, à sa place, et la mise à niveau du
   * runtime la fera passer SEULE. Les confondre ferait republier ce qui n'a
   * jamais été perdu — et surtout, ferait chercher un correctif de données là
   * où il faut un déploiement.
   */
  CONSUMER_BLOCKED: 'CONSUMER_BLOCKED',
});

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return /^\d+$/.test(decoded) ? Number(decoded) : 0;
  } catch {
    return 0;
  }
}

/**
 * LE RETARD D'UN PROJET — combien d'écritures, et depuis quand.
 *
 * ══ LE FILTRE EST EXACTEMENT CELUI DU TIRAGE ════════════════════════════════
 *
 * `originProjectId: { $ne }` (anti-écho) et l'audience (diffusion générale ou
 * nominative). Un filtre plus large compterait, dans le retard d'un projet, des
 * écritures qui ne lui seront jamais servies — et l'alerte se déclencherait sur
 * un retard qui n'existe pas. Il DOIT rester le miroir de `pullForProject`.
 */
export async function measureBacklog(projectId, cursor) {
  const afterSeq = decodeCursor(cursor);
  const filtre = {
    seq: { $gt: afterSeq },
    originProjectId: { $ne: projectId },
    $or: [{ audience: null }, { audience: projectId }],
  };
  const [pending, plusAncienne] = await Promise.all([
    PanelSyncJournalEntry.countDocuments(filtre),
    PanelSyncJournalEntry.findOne(filtre).sort({ seq: 1 }).select('change.modifiedAt').lean(),
  ]);
  return {
    pending,
    oldestModifiedAt: plusAncienne?.change?.modifiedAt ?? null,
  };
}

/** Âge en minutes d'un horodatage ISO, ou `null` si illisible. */
function ageMinutes(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 60_000));
}

/**
 * CONSTATE la santé de consommation d'un projet.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {object} args.runtime  la fiche `record.runtime`
 * @param {number} [args.now]    l'instant de référence, injectable en test
 * @returns {Promise<{status:string, reasons:string[], detail:object}>}
 */
export async function describeConsumptionHealth({ projectId, runtime = {}, now = Date.now() }) {
  const consumption = runtime?.bridgeStats?.consumption ?? null;

  /**
   * PAS DE DÉCLARATION ⇒ `UNKNOWN`, jamais `HEALTHY`.
   *
   * Un projet antérieur au contrat 1.10.0 ne publie rien de sa consommation.
   * Déduire sa santé de ce silence est exactement l'erreur que ce module existe
   * pour ne plus commettre — c'est celle qui a laissé 91 cycles morts passer
   * inaperçus.
   */
  if (!consumption) {
    return {
      status: CONSUMPTION_STATUS.UNKNOWN,
      reasons: [],
      detail: { declares: false },
    };
  }

  const reasons = [];
  const pullFailures = Number(consumption.consecutivePullFailures ?? 0);
  const unreadable = Number(consumption.consecutiveUnreadableChanges ?? 0);

  if (pullFailures >= CONSUMPTION_THRESHOLDS.PULL_FAILURES) {
    reasons.push(CONSUMPTION_REASONS.PULL_FAILING);
  }
  if (unreadable >= CONSUMPTION_THRESHOLDS.UNREADABLE_CHANGES) {
    reasons.push(CONSUMPTION_REASONS.CHANGES_UNREADABLE);
  }

  const parked = Number(consumption.parkedChanges ?? 0);
  if (parked > 0) reasons.push(CONSUMPTION_REASONS.CHANGES_PARKED);

  /**
   * LE BLOCAGE DÉCLARÉ PRIME SUR TOUT LE RESTE.
   *
   * Un consommateur retenu a un curseur qui ne bouge plus. Sans cette lecture,
   * le retard finirait par déclencher `BACKLOG_STALE` — un motif VRAI mais
   * TROMPEUR : il fait chercher une panne de transport là où le transport
   * fonctionne parfaitement et où la cause est un runtime en retard de version.
   *
   * Le seuil est UN. Il n'y a pas de « un peu bloqué ».
   */
  const blocked = consumption.blocked ?? null;
  if (blocked) reasons.push(CONSUMPTION_REASONS.CONSUMER_BLOCKED);

  const backlog = await measureBacklog(projectId, consumption.cursor ?? null);
  const age = ageMinutes(backlog.oldestModifiedAt, now);
  if (backlog.pending > 0 && age !== null && age >= CONSUMPTION_THRESHOLDS.BACKLOG_AGE_MINUTES) {
    reasons.push(CONSUMPTION_REASONS.BACKLOG_STALE);
  }

  return {
    status: reasons.length > 0 ? CONSUMPTION_STATUS.DEGRADED : CONSUMPTION_STATUS.HEALTHY,
    reasons,
    detail: {
      declares: true,
      /**
       * LE CURSEUR EST RENDU TEL QUEL — opaque, et c'est très bien.
       *
       * Il n'est pas là pour être lu par un humain mais pour être COMPARÉ : un
       * curseur qui vaut la même chose avant et après un redémarrage du projet
       * est la preuve que la persistance fonctionne. C'est exactement ce que la
       * recette de pont vérifie, et elle n'a besoin de rien d'autre.
       */
      cursor: consumption.cursor ?? null,
      pendingChanges: backlog.pending,
      oldestPendingAt: backlog.oldestModifiedAt,
      backlogAgeMinutes: age,
      consecutivePullFailures: pullFailures,
      consecutiveUnreadableChanges: unreadable,
      parkedChanges: parked,
      lastParkedAt: consumption.lastParkedAt ?? null,
      lastCursorAdvanceAt: consumption.lastCursorAdvanceAt ?? null,
      lastSuccessfulApplyAt: consumption.lastSuccessfulApplyAt ?? null,
      appliedTotal: consumption.appliedTotal ?? null,
      declaredState: consumption.state ?? null,
      /**
       * CE QUI RETIENT LE CONSOMMATEUR — rendu ENTIER, pas résumé.
       *
       * Le type, l'identité, le motif et l'ancienneté sont exactement ce qu'un
       * exploitant doit lire pour décider : « INCOMPATIBLE sur LEGAL_DOCUMENT
       * depuis 2 h » se répare en déployant, et rien d'autre ne le répare.
       */
      blockedChange: blocked,
    },
  };
}

/** Une phrase française qui dit CE QUI ne va pas — pour un écran, un e-mail. */
export function explainConsumptionReasons(reasons = [], detail = {}) {
  const phrases = [];
  if (reasons.includes(CONSUMPTION_REASONS.PULL_FAILING)) {
    phrases.push(
      `le rattrapage échoue depuis ${detail.consecutivePullFailures} cycles consécutifs`,
    );
  }
  if (reasons.includes(CONSUMPTION_REASONS.CHANGES_UNREADABLE)) {
    phrases.push(
      `${detail.consecutiveUnreadableChanges} écritures consécutives ont été ÉCARTÉES parce que `
      + 'le projet ne sait pas les lire — cette donnée est perdue tant qu’elle n’est pas republiée',
    );
  }
  if (reasons.includes(CONSUMPTION_REASONS.CHANGES_PARKED)) {
    phrases.push(
      `${detail.parkedChanges} écriture(s) ont été GARÉES par le projet après épuisement `
      + 'de ses tentatives d’application — elles ne repartiront pas toutes seules, '
      + 'seule une nouvelle publication les ramènera',
    );
  }
  if (reasons.includes(CONSUMPTION_REASONS.CONSUMER_BLOCKED)) {
    const b = detail.blockedChange ?? {};
    phrases.push(
      `le projet est RETENU sur une écriture ${b.entityType ?? 'inconnue'} qu'il ne sait `
      + `pas traiter (${b.reason ?? 'INCOMPATIBLE'}, contrat local ${b.contractVersion ?? '?'}) `
      + '— rien n’est perdu, l’écriture attend dans le journal, mais elle ne passera '
      + 'que lorsque ce projet aura été mis à niveau',
    );
  }
  if (reasons.includes(CONSUMPTION_REASONS.BACKLOG_STALE)) {
    phrases.push(
      `${detail.pendingChanges} écriture(s) attendent d’être consommées, la plus ancienne depuis `
      + `${detail.backlogAgeMinutes} minutes`,
    );
  }
  return phrases;
}

export default {
  CONSUMPTION_STATUS,
  CONSUMPTION_REASONS,
  CONSUMPTION_THRESHOLDS,
  measureBacklog,
  describeConsumptionHealth,
  explainConsumptionReasons,
};
