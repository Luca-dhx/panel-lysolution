// CE QU'UN PROJET A RENONCÉ À APPLIQUER — lu chez lui, à l'instant.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Rejeu d'une lettre morte ».
//
// ── POURQUOI UNE LECTURE VIVANTE, ET PAS UNE PROJECTION ─────────────────────
//
// Le battement déclare un COMPTE (`consumption.parkedChanges`) : c'est ce qu'il
// faut pour ALERTER, jamais pour AGIR. Un opérateur qui veut rejouer doit
// NOMMER l'écriture, et seul le projet sait laquelle il n'a pas su appliquer.
//
// En faire une projection créerait une copie qui vieillit — et sur ce sujet
// précis, une copie périmée ferait rejouer une écriture déjà débloquée.
//
// ── CE QUI N'ARRIVE JAMAIS ICI ──────────────────────────────────────────────
//
// La charge utile. La lettre morte du projet n'en conserve aucune, et cette
// lecture ne pourrait donc pas en rendre. Ce qui arrive : un type, un
// identifiant, un motif tronqué, des tentatives, des dates.
import ProjectBridgeClient from '../../bridge/ProjectBridgeClient.js';
import { outboundBaseUrl } from './projectDestination.service.js';
import { getOutboundBridgeToken } from '../pairing/pairing.service.js';

/** Pourquoi la lecture n'a pas pu se faire. Codes stables, pour l'écran. */
export const DEAD_LETTERS_UNAVAILABLE = Object.freeze({
  NOT_PAIRED: 'PROJECT_DEAD_LETTERS_NOT_PAIRED',
  NO_ADDRESS: 'PROJECT_DEAD_LETTERS_NO_ADDRESS',
  UNREACHABLE: 'PROJECT_DEAD_LETTERS_UNREACHABLE',
  /** Le projet répond, mais ne connaît pas encore cette lecture (contrat < 1.13). */
  UNSUPPORTED: 'PROJECT_DEAD_LETTERS_UNSUPPORTED',
});

/**
 * LIT les écritures garées d'un projet, MAINTENANT.
 *
 * Ne lève jamais : une indisponibilité est un RÉSULTAT que l'écran doit pouvoir
 * peindre, pas une exception qui casse la fiche entière.
 */
export async function readProjectDeadLetters(record, { fetchImpl } = {}) {
  const indisponible = (reason, message) => ({
    available: false, deadLetters: [], active: 0, resolved: 0, readAt: null, reason, message,
  });

  if (record?.pairing?.status !== 'PAIRED') {
    return indisponible(
      DEAD_LETTERS_UNAVAILABLE.NOT_PAIRED,
      'Ce projet n’est pas relié : le Panel ne peut pas lire ses écritures garées.',
    );
  }

  const baseUrl = outboundBaseUrl(record);
  const bridgeToken = getOutboundBridgeToken(record);
  if (!baseUrl || !bridgeToken) {
    return indisponible(
      DEAD_LETTERS_UNAVAILABLE.NO_ADDRESS,
      'L’adresse ou le jeton de ce projet est inconnu : lecture impossible.',
    );
  }

  const client = new ProjectBridgeClient({
    baseUrl, bridgeToken, ...(fetchImpl ? { fetchImpl } : {}),
  });

  try {
    const data = await client.listDeadLetters();
    const brutes = Array.isArray(data?.deadLetters) ? data.deadLetters : [];
    const lignes = brutes.map(projeter);
    return {
      available: true,
      deadLetters: lignes,
      active: lignes.filter((d) => d.status === 'PARKED').length,
      resolved: lignes.filter((d) => d.status === 'RESOLVED').length,
      readAt: new Date().toISOString(),
      reason: null,
      message: null,
    };
  } catch (err) {
    /**
     * UN PROJET ANTÉRIEUR AU CONTRAT 1.13 RÉPOND 404 — et ce n'est pas une
     * panne. Le distinguer d'une injoignabilité évite d'afficher « projet
     * injoignable » sur une instance parfaitement saine, simplement plus
     * ancienne.
     */
    const inconnue = err?.statusCode === 404 || err?.status === 404;
    return indisponible(
      inconnue ? DEAD_LETTERS_UNAVAILABLE.UNSUPPORTED : DEAD_LETTERS_UNAVAILABLE.UNREACHABLE,
      inconnue
        ? 'Cette version du projet ne publie pas encore ses écritures garées.'
        : `Le projet n’a pas répondu : ${err?.message ?? 'injoignable'}.`,
    );
  }
}

/**
 * Projection SÛRE d'une lettre morte — ce qui va à l'écran.
 *
 * Le motif est retronqué ici même si le projet le tronque déjà : ce module est
 * le dernier point avant l'affichage, et une garde qui dépend de la discipline
 * d'en face n'est pas une garde.
 */
function projeter(d) {
  return {
    writeId: d?.writeId ?? null,
    entityType: d?.entityType ?? null,
    entityId: d?.entityId ?? null,
    reason: String(d?.reason ?? '').slice(0, 200),
    attempts: Number(d?.attempts ?? 0),
    parkedAt: d?.parkedAt ?? null,
    status: d?.status ?? 'PARKED',
    resolvedAt: d?.resolvedAt ?? null,
    resolvedByWriteId: d?.resolvedByWriteId ?? null,
  };
}

export default { readProjectDeadLetters, DEAD_LETTERS_UNAVAILABLE };
