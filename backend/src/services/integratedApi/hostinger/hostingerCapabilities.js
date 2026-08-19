// CAPACITÉS HOSTINGER — les trois verbes du DNS, et rien d'autre (L9).
//
// docs/architecture/HOSTINGER_CONTROL_PLANE.md §« Capacités ».
//
// ── POURQUOI CE FICHIER EXISTE À CÔTÉ DU REGISTRE ───────────────────────────
//
// Même patron que `brevo/brevoCapabilities.js` (L8) : le lot qui connaît le
// fournisseur écrit son contrat ; le registre de la passerelle (L3) le SERT.
// Les définitions ci-dessous ont exactement la forme que `capabilityRegistry`
// produit, et s'y intègrent par un `...HOSTINGER_CAPABILITIES` — voir
// §« Câblage » du document.
//
// ── TROIS VERBES, ET L'ORDRE COMPTE ─────────────────────────────────────────
//
//   dns.zone.resolve   quel domaine gère ce nom d'hôte ?     LECTURE
//   dns.records.read   qu'y a-t-il déjà pour mes hôtes ?      LECTURE
//   dns.record.ensure  pose cet enregistrement                ÉCRITURE
//
// Le moteur de déploiement PLANIFIE avec les deux premières, puis mute avec la
// troisième. Fondre les trois en une seule « gestion DNS » ferait d'une
// planification une écriture d'infrastructure, et supprimerait la seule phase
// où l'on peut détecter un conflit sans avoir rien touché.
//
// ── AUCUNE CAPACITÉ INVENTÉE ────────────────────────────────────────────────
//
// L'API Hostinger expose une trentaine d'endpoints — VPS, facturation,
// hébergement d'agence, snapshots, verrou de domaine, reset de zone.
// L'inventaire des deux dépôts (2026-08-10) n'en trouve que trois appelés. On
// ne déclare donc ni `infrastructure.server.inspect`, ni gestion de
// nameservers, ni renouvellement : ce seraient des pouvoirs sans usage.
import { z } from 'zod';

import { getProviderDefinition } from '../providerRegistry.js';

/**
 * ── LES EFFETS ONT DISPARU AVEC L'OUVERTURE COMMERCIALE ─────────────────────
 *
 * Ce fichier lisait `CAPABILITY_EFFECTS` pour attacher un `effectNature` à
 * chaque verbe DNS. Cette taxinomie n'avait qu'un seul lecteur — la politique
 * de pré-ouverture, qui décidait quels effets étaient interdits tant qu'une
 * instance n'était pas déclarée ouverte. La politique supprimée, la taxinomie
 * n'était plus lue par personne : la garder aurait été conserver une
 * classification que rien ne vérifie et que rien n'applique.
 */

/** Permission de la famille. `dns:write` existe déjà au registre L3. */
export const HOSTINGER_PERMISSIONS = Object.freeze({
  DNS_READ: 'dns:read',
  DNS_WRITE: 'dns:write',
});

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Le nom d'hôte est la SEULE désignation de ressource acceptée.
 *
 * Pas de `zone`, pas de `domain`, pas d'identifiant d'enregistrement : le
 * projet nomme l'hôte qu'il déploie, et le Panel en déduit la zone. Laisser le
 * projet nommer la zone lui permettrait de demander `example.com` en prétendant
 * déployer `a.example.com` — et c'est la zone, pas l'hôte, qui donne le pouvoir.
 */
const hostname = z.string().trim().toLowerCase().min(3).max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, 'Nom d’hôte invalide.');

/** Types d'enregistrements que le moteur pose réellement. Fermé. */
const recordType = z.enum(['A', 'AAAA', 'CNAME', 'TXT']);

const operationId = z.string().trim().min(8).max(64);

const zoneResolveInput = z.object({ hostname, operationId }).strict();

const recordsReadInput = z.object({ hostname, operationId }).strict();

const recordEnsureInput = z.object({
  hostname,
  type: recordType.default('A'),
  /**
   * Contenu de l'enregistrement — une adresse IP dans tous les usages actuels.
   * Borné à 255 caractères : au-delà, ce n'est plus un enregistrement DNS,
   * c'est une charge utile qu'on n'a pas relue.
   */
  content: z.string().trim().min(1).max(255),
  /** TTL en secondes. Plancher à 60 : plus bas, les résolveurs l'ignorent. */
  ttl: z.number().int().min(60).max(86_400).optional(),
  operationId,
}).strict();

/* -------------------------------------------------------------------------- */
/*  SORTIES                                                                   */
/* -------------------------------------------------------------------------- */

const zoneResolveOutput = z.object({
  hostname: z.string(),
  zone: z.string(),
  relativeName: z.string(),
  /** `managed` : la zone figure au portefeuille du Panel. `psl` : déduite. */
  source: z.enum(['managed', 'psl']),
}).strict();

const dnsRecord = z.object({
  name: z.string(),
  type: z.string(),
  ttl: z.number().nullable(),
  contents: z.array(z.string()),
  disabled: z.boolean(),
}).strict();

const recordsReadOutput = z.object({
  zone: z.string(),
  /** RÉDUITS à ce que le projet a le droit de voir (§« Ownership »). */
  records: z.array(dnsRecord),
}).strict();

const recordEnsureOutput = z.object({
  hostname: z.string(),
  zone: z.string(),
  name: z.string(),
  type: z.string(),
  /** Ce que Hostinger a répondu, réduit à un constat. Aucun corps brut. */
  written: z.boolean(),
  /**
   * Identifiant de corrélation du fournisseur. Non secret, et c'est la seule
   * chose qu'un support demande — le taire transforme un incident en enquête.
   */
  correlationId: z.string().nullable(),
}).strict();

/* -------------------------------------------------------------------------- */
/*  DÉFINITIONS                                                               */
/* -------------------------------------------------------------------------- */

/** Même fabrique que le registre L3 — déclarée ici, c'est servie. */
function capability(code, options) {
  const definition = getProviderDefinition('HOSTINGER');
  return Object.freeze({
    code,
    provider: 'HOSTINGER',
    scope: definition?.scope ?? null,
    label: options.label,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    timeoutMs: options.timeoutMs,
    idempotency: options.idempotency,
    requiredPermissions: Object.freeze([...options.requiredPermissions]),
    /**
     * MARQUEUR L9 — cette capacité désigne une RESSOURCE, et son appartenance
     * doit être prouvée avant exécution. Lu par l'adaptateur ; un test vérifie
     * qu'aucune capacité Hostinger ne l'oublie.
     */
    requiresResourceOwnership: true,
  });
}

export const HOSTINGER_CAPABILITIES = Object.freeze({
  'dns.zone.resolve': capability('dns.zone.resolve', {
    label: 'Résoudre le domaine qui gère un nom d’hôte',
    inputSchema: zoneResolveInput,
    outputSchema: zoneResolveOutput,
    timeoutMs: 15_000,
    // Lecture pure : rejouer est sans conséquence, même après un silence.
    idempotency: 'SAFE_RETRY',
    requiredPermissions: [HOSTINGER_PERMISSIONS.DNS_READ],
  }),

  'dns.records.read': capability('dns.records.read', {
    label: 'Lire les enregistrements DNS de mes hôtes',
    inputSchema: recordsReadInput,
    outputSchema: recordsReadOutput,
    timeoutMs: 15_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: [HOSTINGER_PERMISSIONS.DNS_READ],
  }),

  'dns.record.ensure': capability('dns.record.ensure', {
    label: 'Poser un enregistrement DNS',
    inputSchema: recordEnsureInput,
    outputSchema: recordEnsureOutput,
    timeoutMs: 20_000,
    /**
     * Hostinger n'expose AUCUNE clé d'idempotence sur `PUT /zones/{zone}`.
     * L'upsert est convergent — poser deux fois le même enregistrement donne
     * le même état — mais un rejeu APRÈS UN SILENCE peut écraser une
     * correction humaine survenue entre-temps. L'issue reste donc indécidable.
     */
    idempotency: 'UNKNOWN_ON_TIMEOUT',
    requiredPermissions: [HOSTINGER_PERMISSIONS.DNS_WRITE],
  }),
});

export const HOSTINGER_CAPABILITY_CODES = Object.freeze(Object.keys(HOSTINGER_CAPABILITIES));

export function isHostingerCapability(code) {
  return typeof code === 'string' && Object.hasOwn(HOSTINGER_CAPABILITIES, code);
}

/**
 * Cohérence du catalogue — ce qu'un humain casse en éditant ce fichier.
 * @returns {string[]} problèmes, vide si tout est cohérent.
 */
export function validateHostingerCapabilities() {
  const problems = [];
  for (const [code, definition] of Object.entries(HOSTINGER_CAPABILITIES)) {
    if (definition.code !== code) problems.push(`code incohérent : « ${code} ».`);
    if (definition.provider !== 'HOSTINGER') problems.push(`${code} : fournisseur inattendu.`);
    // PANEL_GLOBAL : c'est l'invariant du lot. Une portée par environnement
    // ferait chercher un jeu TEST qui n'existe pas, et refuserait tout.
    if (definition.scope !== 'PANEL_GLOBAL') {
      problems.push(`${code} : Hostinger doit rester PANEL_GLOBAL (trouvé « ${definition.scope} »).`);
    }
    if (!definition.requiresResourceOwnership) {
      problems.push(`${code} : une capacité d’infrastructure sans preuve d’appartenance.`);
    }
    if (!definition.inputSchema || !definition.outputSchema) {
      problems.push(`${code} : servie sans contrat d’entrée ou de sortie.`);
    }
    // Le projet ne nomme JAMAIS la zone : c'est elle qui porte le pouvoir.
    const shape = definition.inputSchema?.shape ?? {};
    for (const forbidden of ['zone', 'domain', 'apiToken', 'credentials', 'baseUrl', 'environment', 'provider']) {
      if (Object.hasOwn(shape, forbidden)) {
        problems.push(`${code} : « ${forbidden} » ne peut pas être une entrée.`);
      }
    }
    if (!Object.hasOwn(shape, 'hostname')) {
      problems.push(`${code} : la ressource doit être désignée par « hostname ».`);
    }
  }
  return problems;
}

export default {
  HOSTINGER_CAPABILITIES,
  HOSTINGER_CAPABILITY_CODES,
  HOSTINGER_PERMISSIONS,
  isHostingerCapability,
  validateHostingerCapabilities,
};
