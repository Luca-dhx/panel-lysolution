/**
 * LIVRAISON DESCENDANTE — Panel → projets. Lot L4.
 *
 * ══ LE MANQUE QUE CE MODULE COMBLE ══════════════════════════════════════════
 *
 * Les deux bouts existaient déjà, et n'ont jamais été reliés :
 *
 *   · `ProjectBridgeClient.deliverChanges()` — le client, écrit, conforme ;
 *   · `POST /api/project-bridge/v1/sync/push` — l'endpoint du projet, qui
 *     applique réellement, avec un commentaire disant en toutes lettres que
 *     « le Panel peut LIVRER au lieu d'attendre que le projet TIRE ».
 *
 * Personne n'appelait le premier. `grep -rn "deliverChanges"` ne rendait que
 * sa définition. Le chemin nominal descendant était donc le sondage du projet,
 * toutes les trente secondes — et une modification d'entreprise mettait
 * jusqu'à une demi-minute à devenir visible sur la page « Aide », pour une
 * livraison qui prend quelques centaines de millisecondes.
 *
 * ══ CE QUE CE MODULE N'EST PAS ══════════════════════════════════════════════
 *
 * Ce n'est PAS une source de vérité, et il ne faut jamais le traiter comme
 * telle. La vérité est `PanelSyncJournalEntry` : durable, ordonnée, tirable.
 * Ce module ne fait qu'ACCÉLÉRER la livraison de ce qui y est déjà écrit.
 *
 * La conséquence tient en une phrase, et elle gouverne tout le fichier :
 *
 *     UN ÉCHEC DE LIVRAISON N'EST PAS UN ÉCHEC.
 *
 * Le projet est éteint, le réseau coupe, le Panel redémarre avant d'avoir
 * poussé : dans les trois cas l'écriture reste au journal, le projet la tire
 * à son prochain cycle, et l'utilisateur n'a jamais rien vu. C'est pourquoi
 * rien ici ne remonte vers la sauvegarde métier, et pourquoi aucune erreur de
 * ce module n'est présentée à un écran.
 *
 * ══ CE QU'IL IGNORE DÉLIBÉRÉMENT ════════════════════════════════════════════
 *
 * Les types d'entités. Il transporte des entrées de journal ; savoir ce qu'est
 * un `DEV_COMPANY` appartient aux applicateurs du projet. Ajouter un type
 * demain ne doit rien changer ici — un test structurel le vérifie.
 */
import ProjectBridgeClient from '../../bridge/ProjectBridgeClient.js';
import { registryStore } from '../registry/registryStore.js';
import { getOutboundBridgeToken } from '../pairing/pairing.service.js';
import { outboundBaseUrl } from '../registry/projectDestination.service.js';
import { declaredEnvironmentOf } from '../registry/projectRegistry.service.js';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

/**
 * TIMEOUT COURT — 4 s, et c'est un choix, pas un réglage oublié.
 *
 * Le client de pont attend 10 s par défaut : c'est la bonne valeur pour une
 * opération qu'un humain a demandée et dont il attend le résultat à l'écran.
 * Ici, personne n'attend : la livraison est opportuniste, et le filet — le
 * journal — est déjà en place. Insister dix secondes sur un projet éteint ne
 * ferait que retarder les suivants pour un résultat qu'on connaît déjà.
 */
export const DELIVERY_TIMEOUT_MS = 4_000;

/**
 * CONCURRENCE BORNÉE — 6 livraisons simultanées.
 *
 * Une modification de l'entreprise du Panel vise TOUT le parc appairé. Un
 * `Promise.all` sur cent projets ouvrirait cent sockets d'un coup, sur un
 * processus qui sert par ailleurs des écrans : on remplacerait une lenteur de
 * trente secondes par une saturation. Six laisse la livraison rester rapide
 * (six projets sains partent ensemble) sans jamais transformer une
 * publication en rafale réseau.
 *
 * Un projet lent n'en retient qu'un seul des six : les autres continuent.
 */
export const DELIVERY_CONCURRENCY = 6;

/** Issues possibles d'une tentative — vocabulaire fermé, jamais du texte libre. */
export const DELIVERY_OUTCOME = Object.freeze({
  /** Le projet a appliqué (ou reconnu comme déjà appliquée) l'écriture. */
  DELIVERED: 'DELIVERED',
  /** Le projet a répondu, et refuse. Le journal reste ; le pull retentera. */
  REFUSED: 'REFUSED',
  /** Le projet n'a pas répondu. Rien n'est perdu : le pull rattrapera. */
  UNREACHABLE: 'UNREACHABLE',
  /** Rien à tenter : pas d'appairage, pas d'adresse. Ce n'est pas une panne. */
  SKIPPED: 'SKIPPED',
  /** Refus de livrer : les mondes ne concordent pas. Jamais corrigé tout seul. */
  ENVIRONMENT_MISMATCH: 'ENVIRONMENT_MISMATCH',
});

/* -------------------------------------------------------------------------- */
/*  FABRIQUE DE CLIENT — injectable, parce qu'un test doit pouvoir observer.   */
/* -------------------------------------------------------------------------- */

/**
 * Le transport est INJECTABLE, et c'est la seule façon d'éprouver la
 * concurrence et la latence sans dépendre d'un vrai réseau lent. Par défaut,
 * c'est le client de pont réel — le SEUL fichier autorisé à ouvrir une socket
 * vers un projet (`bridge-conformity` le verrouille).
 */
const TRANSPORT_REEL = ({ baseUrl, bridgeToken }) =>
  new ProjectBridgeClient({ baseUrl, bridgeToken, timeoutMs: DELIVERY_TIMEOUT_MS });

let clientFactory = TRANSPORT_REEL;

/**
 * Remplace le transport. `null` REND le transport réel — et c'est important :
 * un `configureDeliveryTransport(null)` qui ne réinitialiserait rien laisserait
 * un test suivant s'exécuter contre le double du précédent, sans rien signaler.
 */
export function configureDeliveryTransport(factory) {
  clientFactory = typeof factory === 'function' ? factory : TRANSPORT_REEL;
}

/** Observabilité : chaque tentative, sans jamais un secret. Voir `describeDeliveries`. */
const MAX_TRACES = 200;
let traces = [];

function tracer(trace) {
  traces.push(trace);
  if (traces.length > MAX_TRACES) traces = traces.slice(-MAX_TRACES);
}

/**
 * Les dernières tentatives, la plus récente d'abord.
 *
 * Ni jeton, ni en-tête d'autorisation, ni charge utile : un `writeId`, un
 * `projectId`, une durée, une issue. De quoi répondre à « où en est cette
 * écriture ? » sans rien répandre.
 */
export function describeDeliveries({ limit = 50 } = {}) {
  return traces.slice(-limit).reverse();
}

export function resetDeliveriesForTests() {
  traces = [];
}

/* -------------------------------------------------------------------------- */
/*  DESTINATAIRES                                                             */
/* -------------------------------------------------------------------------- */

/**
 * QUI DOIT RECEVOIR CETTE ÉCRITURE — exactement la règle du `pull`, et rien
 * d'autre.
 *
 * ══ POURQUOI RECOPIER LA RÈGLE ICI SERAIT UN DÉFAUT ═════════════════════════
 *
 * `pullForProject` filtre sur `audience` et sur `originProjectId` (anti-écho).
 * Si la livraison poussée appliquait une règle SEULEMENT ressemblante, une
 * écriture nominative pourrait atteindre une instance que le tirage n'aurait
 * jamais servie — et le résultat dépendrait alors de la façon dont la donnée
 * est arrivée. C'est précisément ce que les deux chemins doivent rendre
 * impossible.
 *
 * Les trois filtres sont donc les mêmes, dans le même ordre :
 *   1. `audience` : nominative → cette instance seule ; `null` → le parc ;
 *   2. anti-écho : jamais renvoyer à l'émetteur d'origine ;
 *   3. appairage : une fiche sans lien n'a pas d'interlocuteur.
 *
 * Le quatrième filtre — l'environnement — n'existe pas au pull parce que le
 * jeton de pont le garantit déjà : une instance ne peut tirer que SON journal.
 * En poussant, c'est nous qui choisissons la cible : la garde devient notre
 * responsabilité, et elle est fail-closed (voir `deliverToProject`).
 */
export async function resolveAudience(entry) {
  const records = await registryStore.list();
  const audience = entry?.audience ?? null;
  const origine = entry?.originProjectId ?? null;

  return records.filter((record) => {
    if (record.pairing?.status !== 'PAIRED') return false;
    if (origine && record.projectId === origine) return false;
    if (audience !== null && record.projectId !== audience) return false;
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*  LIVRAISON                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Livre un lot d'écritures à UNE instance. Ne lève jamais.
 *
 * L'issue est classée, tracée, et rendue — mais elle n'a aucune conséquence
 * sur le journal. Une écriture refusée ou non livrée y reste : le tirage du
 * projet la reprendra.
 */
export async function deliverToProject(record, changes) {
  const projectId = record.projectId;
  const debut = Date.now();

  const base = {
    projectId,
    environment: declaredEnvironmentOf(record),
    writeIds: changes.map((c) => c.writeId),
    startedAt: new Date(debut).toISOString(),
    /** Il y a TOUJOURS un filet : c'est ce qui rend l'échec supportable. */
    fallbackAvailable: true,
  };

  /**
   * ── LA DONNÉE MÉTIER NE TRAVERSE PAS LES MONDES ───────────────────────────
   *
   * Ce qui part d'ici n'est pas de l'administration : ce sont les PROPRES
   * ENREGISTREMENTS du Panel — entreprise cliente, mentions légales, contrat,
   * équipe. Ils sont partitionnés par le monde du Panel (`PanelClientCompany`
   * porte `environment: config.env`), et cette partition n'a pas changé.
   *
   * ── CE QUI A CHANGÉ AUTOUR, ET POURQUOI CETTE GARDE RESTE ────────────────
   *
   * Un Panel de recette peut désormais APPAIRER et PILOTER un projet de
   * production : le battement, la supervision, le déploiement et les capacités
   * fournisseur fonctionnent, ces dernières sur le monde du PROJET.
   *
   * Livrer pour autant les fiches de ce Panel-ci serait poser les mentions
   * légales d'une entreprise de recette sur un site en production. Ce n'est pas
   * une limite de plomberie : la donnée demandée n'existe pas dans ce monde, et
   * aucune valeur de substitution ne serait honnête.
   *
   * ── CE N'EST PLUS UNE ANOMALIE, C'EST UNE FRONTIÈRE ──────────────────────
   *
   * La classe `SECURITY` disait « quelqu'un s'est trompé de Panel ». Depuis que
   * la combinaison est supportée, elle ne dit plus la vérité : le plus souvent
   * l'opérateur sait exactement ce qu'il fait. On garde donc le refus — au mot
   * près le même — et on cesse de le présenter comme un incident.
   */
  const environnement = declaredEnvironmentOf(record);
  if (environnement && environnement !== config.env) {
    const trace = {
      ...base, outcome: DELIVERY_OUTCOME.ENVIRONMENT_MISMATCH,
      errorClass: 'SCOPE', durationMs: Date.now() - debut,
    };
    tracer(trace);
    logger.info(
      `[sync-delivery] ${projectId} : donnees metier non livrees — le projet est en ${environnement}, `
      + `ce Panel tient les fiches ${config.env}. Le pilotage reste actif ; seule la synchronisation `
      + "metier est hors perimetre de ce plan de controle.",
    );
    return trace;
  }

  const bridgeToken = getOutboundBridgeToken(record);
  const baseUrl = outboundBaseUrl(record);
  if (!bridgeToken || !baseUrl) {
    // Ni panne ni erreur : une fiche sans adresse ou sans jeton n'a rien à
    // recevoir. Le journal la servira quand elle reviendra.
    const trace = {
      ...base, outcome: DELIVERY_OUTCOME.SKIPPED,
      errorCode: bridgeToken ? 'NO_BASE_URL' : 'NO_BRIDGE_TOKEN',
      durationMs: Date.now() - debut,
    };
    tracer(trace);
    return trace;
  }

  try {
    const data = await clientFactory({ baseUrl, bridgeToken }).deliverChanges(changes);
    /**
     * LE VERDICT EST LU PAR `writeId` — jamais déduit du code HTTP.
     *
     * Un 200 dit que la requête est arrivée, pas que la donnée est appliquée.
     * C'est la même discipline que dans le sens montant, et pour la même
     * raison : confondre les deux, c'est effacer une preuve qu'on n'a pas.
     */
    const results = Array.isArray(data?.results) ? data.results : [];
    const refuses = results.filter((r) => r.status === 'REJECTED');
    const trace = {
      ...base,
      outcome: refuses.length > 0 ? DELIVERY_OUTCOME.REFUSED : DELIVERY_OUTCOME.DELIVERED,
      applied: results.filter((r) => r.status === 'APPLIED').length,
      duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      ...(refuses.length > 0
        ? { errorClass: 'COMPATIBILITY', errorCode: refuses[0].code ?? null }
        : {}),
      durationMs: Date.now() - debut,
    };
    tracer(trace);
    if (refuses.length > 0) {
      logger.warn(
        `[sync-delivery] ${projectId} : ${refuses.length} écriture(s) refusée(s) (${refuses[0].code ?? 'sans code'}) — le rattrapage réessaiera.`,
      );
    }
    return trace;
  } catch (err) {
    /**
     * INJOIGNABLE — et c'est un cas NORMAL, pas une panne du Panel.
     *
     * Un projet éteint, en cours de redéploiement, ou simplement derrière un
     * réseau coupé. On le note en `info` : le journaliser en erreur ferait
     * clignoter la supervision à chaque déploiement d'un projet, pour une
     * situation dont la reprise est automatique.
     */
    const trace = {
      ...base,
      outcome: DELIVERY_OUTCOME.UNREACHABLE,
      errorClass: 'TRANSIENT',
      errorCode: err?.code ?? 'UNKNOWN',
      httpStatus: err?.details?.httpStatus ?? null,
      durationMs: Date.now() - debut,
    };
    tracer(trace);
    return trace;
  }
}

/**
 * BOUCLE À CONCURRENCE BORNÉE — écrite ici plutôt qu'importée.
 *
 * Le dépôt n'a pas de limiteur, et en introduire un pour six requêtes
 * simultanées serait une dépendance de plus pour douze lignes. Des tâcherons
 * qui tirent d'une même file : la borne est le NOMBRE de tâcherons, et elle
 * est donc respectée par construction plutôt que par comptage.
 */
async function enFileBornee(items, limite, travail) {
  const resultats = new Array(items.length);
  let curseur = 0;
  const tacheron = async () => {
    for (;;) {
      const i = curseur;
      curseur += 1;
      if (i >= items.length) return;
      resultats[i] = await travail(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limite, items.length) }, () => tacheron()),
  );
  return resultats;
}

/**
 * LIVRE UNE ENTRÉE DE JOURNAL À TOUTE SON AUDIENCE.
 *
 * Attendue par les tests et par l'amorçage ; JAMAIS attendue par une
 * sauvegarde métier — c'est `scheduleDelivery` qui s'en charge.
 */
export async function deliverEntry(entry) {
  const cibles = await resolveAudience(entry);
  if (cibles.length === 0) return [];
  const changes = [entry.change];
  return enFileBornee(cibles, DELIVERY_CONCURRENCY, (record) => deliverToProject(record, changes));
}

/**
 * LE POINT D'ENTRÉE DU CHEMIN NOMINAL — et il ne s'attend pas.
 *
 * ══ POURQUOI CE N'EST PAS UN `await` ════════════════════════════════════════
 *
 * Celui qui enregistre son numéro de téléphone dans le Panel n'a pas à
 * attendre que douze projets répondent. Sa donnée est écrite, versionnée et
 * journalisée : le contrat avec lui est rempli. Faire dépendre sa réponse du
 * réseau d'un tiers, c'est transformer un projet éteint en lenteur d'écran, et
 * un projet injoignable en erreur qu'il ne peut pas corriger.
 *
 * ══ MAIS PAS UN OUBLI POUR AUTANT ═══════════════════════════════════════════
 *
 * Une promesse lâchée sans ceinture devient un `unhandledRejection`, qui tue
 * le processus sous Node. La ceinture est donc ici, et elle est totale : ce
 * `catch` ne doit JAMAIS pouvoir lever.
 */
export function scheduleDelivery(entry) {
  try {
    void Promise.resolve(deliverEntry(entry)).catch((err) => {
      logger.warn(`[sync-delivery] tentative impossible : ${err?.message ?? err}`);
    });
  } catch (err) {
    logger.warn(`[sync-delivery] planification impossible : ${err?.message ?? err}`);
  }
}

export default {
  scheduleDelivery,
  deliverEntry,
  deliverToProject,
  resolveAudience,
  describeDeliveries,
  configureDeliveryTransport,
  resetDeliveriesForTests,
  DELIVERY_OUTCOME,
  DELIVERY_CONCURRENCY,
  DELIVERY_TIMEOUT_MS,
};
