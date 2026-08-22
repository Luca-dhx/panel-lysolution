/**
 * LE PANEL GARANTIT SA PROPRE CONFIGURATION DE PORTAIL.
 *
 * ══ POURQUOI « GARANTIR » ET NON « CONFIGURER UNE FOIS » ════════════════════
 *
 * Un réglage posé à la main dans un tableau de bord n'est pas un invariant :
 * il est vrai le jour où on l'a posé. Personne ne le relit, rien ne le teste,
 * et il change au premier clic de quelqu'un qui cherchait autre chose.
 *
 * Ce module fait le même geste que l'endpoint webhook (L6.3A) et que la
 * résiliation d'abonnement (L6.2G) : il converge sur l'ÉTAT. À chaque ouverture
 * de portail, il vérifie que la configuration du Panel dit encore ce qu'elle
 * doit dire, et la remet à sa cible si elle a dérivé. Deux appels successifs
 * produisent le même objet — il n'y a rien à dédupliquer.
 *
 * ══ IL NE S'APPROPRIE RIEN ══════════════════════════════════════════════════
 *
 * Un compte Stripe peut porter plusieurs configurations. Le Panel retrouve LA
 * SIENNE par ses métadonnées (`managedBy` + `role`), la crée si elle n'existe
 * pas, et ne touche à AUCUNE autre — pas même celle qui est par défaut. Choisir
 * « celle du compte » reviendrait à écraser un réglage qui appartient peut-être
 * à quelqu'un d'autre.
 *
 * ══ CE QUE LA MÉMOIRE ÉVITE, ET CE QU'ELLE NE GARANTIT PAS ══════════════════
 *
 * L'identifiant résolu est gardé en mémoire pour la durée du processus : sans
 * cela, chaque ouverture de portail coûterait une liste de configurations. Ce
 * cache est une COMMODITÉ, jamais la garantie — un redémarrage le vide, et la
 * convergence repart de zéro sans conséquence. Il est indexé par monde : une
 * recette et une production sont deux comptes, et confondre leurs
 * configurations enverrait un client sur le mauvais portail.
 */
import { createHash } from 'node:crypto';

import logger from '../../../utils/logger.js';
import {
  listPortalConfigurations,
  createPortalConfiguration,
  updatePortalConfiguration,
} from './stripeTransport.js';
import {
  PORTAL_METADATA,
  portalConfigurationParams,
  isPanelPortalConfiguration,
  portalConfigurationDrift,
  describePortalConfiguration,
} from './stripePortalAuthority.js';

/** `{ [environment]: configurationId }` — commodité de processus, jamais l'autorité. */
const memoire = new Map();

/** Les tests repartent d'un état net ; un changement de compte aussi. */
export function resetPortalConfigurationCache() {
  memoire.clear();
}

/**
 * L'IDENTITÉ DE L'ACTE DE CRÉATION.
 *
 * Dérivée du MONDE, et de rien d'autre : il n'existe qu'une configuration de
 * portail du Panel par compte Stripe. Laisser un appelant la nommer permettrait
 * d'en obtenir deux, et le Panel n'aurait plus de réponse à « laquelle est la
 * mienne ».
 */
export function portalConfigurationOperationId({ environment }) {
  const env = String(environment ?? '').trim().toLowerCase();
  if (!env) throw new Error('portalConfigurationOperationId : environnement manquant.');
  return `stripe-portal-configuration:${env}`;
}

/**
 * L'IDENTITÉ DE L'ACTE DE RÉALIGNEMENT — elle varie avec CE QU'ON CORRIGE.
 *
 * ══ POURQUOI PAS UNE CLÉ STABLE ═════════════════════════════════════════════
 *
 * Le transport refuse toute écriture sans clé d'idempotence, et il a raison :
 * une clé oubliée est un doublon en attente. Mais une clé STABLE aurait produit
 * ici l'inverse d'une protection.
 *
 * La fenêtre d'idempotence de Stripe est de vingt-quatre heures : sous la même
 * clé, il REJOUE sa réponse d'origine sans rien appliquer. Scénario réel : un
 * exploitant réactive `customer_update` depuis le tableau de bord, le Panel
 * réaligne (clé K), l'exploitant le réactive une seconde fois dans la journée —
 * le Panel rappelle avec la clé K, Stripe rend la réponse en cache, et la
 * configuration RESTE ouverte. La garde aurait produit la panne qu'elle prétend
 * empêcher, en silence.
 *
 * La clé porte donc l'empreinte de la DÉRIVE OBSERVÉE. Deux dérives différentes
 * sont deux actes différents ; la même dérive rejouée reste un seul acte, et
 * son rejeu est alors parfaitement sûr — l'état visé est déjà celui qu'on veut.
 */
export function portalAlignmentOperationId({ environment, configurationId, drift }) {
  const empreinte = createHash('sha256')
    .update(`${configurationId}|${[...drift].sort().join('|')}`)
    .digest('hex')
    .slice(0, 16);
  return `stripe-portal-align:${String(environment).toLowerCase()}:${empreinte}`;
}

/**
 * GARANTIT la configuration de portail du Panel, et rend son identifiant.
 *
 * @param {object} args
 * @param {object} args.credentials   ouvertes par la passerelle, consommées ici
 * @param {string} args.environment   le monde servi — jamais choisi par un appelant
 * @param {number} [args.timeoutMs]
 * @param {Function} [args.fetchImpl]
 * @param {boolean} [args.force]      ignorer la mémoire de processus
 * @returns {Promise<{configurationId: string, created: boolean, realigned: boolean,
 *   drift: string[], configuration: object}>}
 */
export async function ensurePortalConfiguration({
  credentials, environment, timeoutMs, fetchImpl, force = false,
}) {
  const connue = force ? null : memoire.get(environment);

  const { configurations, truncated } = await listPortalConfigurations({
    credentials, timeoutMs, fetchImpl,
  });

  /**
   * PLUS DE CENT CONFIGURATIONS : on ne conclut pas.
   *
   * La nôtre pourrait se trouver dans la page suivante, et en créer une
   * seconde parce qu'on n'a pas su lire assez loin serait exactement le
   * doublon que ce module existe pour empêcher. Cent configurations de portail
   * sur un compte n'a par ailleurs aucune cause légitime.
   */
  if (truncated) {
    throw new Error(
      'Le compte porte plus de cent configurations de portail : '
      + 'la configuration du Panel ne peut pas être identifiée sans risque de doublon.',
    );
  }

  const notres = configurations.filter(isPanelPortalConfiguration);

  if (notres.length > 1) {
    /**
     * DEUX CONFIGURATIONS MARQUÉES : on prend la plus ancienne et on le DIT.
     *
     * La plus ancienne est celle que les sessions passées ont utilisée ; s'en
     * détourner changerait le portail sous les pieds des clients en cours. Le
     * doublon est signalé plutôt que réparé : supprimer une configuration qu'on
     * n'a pas créée dans ce processus est une décision d'exploitant.
     */
    logger.warn(
      `[stripe-portal] ${notres.length} configurations portent la marque du Panel `
      + `(${environment}) : la plus ancienne fait foi — ${notres.map((c) => c.id).join(', ')}.`,
    );
  }

  const existante = notres.sort((a, b) => (a.created ?? 0) - (b.created ?? 0))[0] ?? null;
  const params = portalConfigurationParams();

  /* ── ELLE N'EXISTE PAS : on la crée ──────────────────────────────────── */
  if (!existante) {
    const res = await createPortalConfiguration({
      credentials,
      params,
      idempotencyKey: portalConfigurationOperationId({ environment }),
      timeoutMs,
      fetchImpl,
    });
    const creee = res.configuration;
    memoire.set(environment, creee.id);
    logger.info(
      `[stripe-portal] configuration du Panel créée pour ${environment} — ${creee.id} : `
      + 'identité légale NON modifiable, offre NON modifiable, résiliation à l’échéance.',
    );
    return {
      configurationId: creee.id,
      created: true,
      realigned: false,
      drift: [],
      configuration: describePortalConfiguration(creee),
    };
  }

  /* ── ELLE EXISTE : dit-elle encore ce qu'elle doit dire ? ────────────── */
  const ecarts = portalConfigurationDrift(existante);
  const inactive = existante.active !== true;

  if (ecarts.length === 0 && !inactive) {
    memoire.set(environment, existante.id);
    if (connue !== existante.id) {
      logger.info(`[stripe-portal] configuration du Panel conforme pour ${environment} — ${existante.id}.`);
    }
    return {
      configurationId: existante.id,
      created: false,
      realigned: false,
      drift: [],
      configuration: describePortalConfiguration(existante),
    };
  }

  /**
   * ELLE A DÉRIVÉ — on la remet à sa cible, et on écrit POURQUOI.
   *
   * Le motif nommé est ce qu'un exploitant relira : « customer_update ACTIVÉ
   * (name, address) » dit ce que le client pouvait faire, et depuis quand
   * personne ne le savait.
   */
  logger.warn(
    `[stripe-portal] configuration ${existante.id} (${environment}) réalignée — `
    + `${ecarts.join(' | ')}${inactive ? ' | configuration inactive' : ''}`,
  );

  const res = await updatePortalConfiguration({
    credentials,
    configurationId: existante.id,
    /** L'état COMPLET, plus la réactivation si elle avait été éteinte. */
    params: { ...params, active: true },
    idempotencyKey: portalAlignmentOperationId({
      environment,
      configurationId: existante.id,
      drift: inactive ? [...ecarts, 'inactive'] : ecarts,
    }),
    timeoutMs,
    fetchImpl,
  });
  const alignee = res.configuration;
  memoire.set(environment, alignee.id);

  return {
    configurationId: alignee.id,
    created: false,
    realigned: true,
    drift: ecarts,
    configuration: describePortalConfiguration(alignee),
  };
}

export default {
  ensurePortalConfiguration,
  portalConfigurationOperationId,
  portalAlignmentOperationId,
  resetPortalConfigurationCache,
  PORTAL_METADATA,
};
