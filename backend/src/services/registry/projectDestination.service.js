// DESTINATIONS D'UN PROJET — l'autorité du Panel, et le résolveur unique.
//
// ══ CE QUE CE MODULE EST ════════════════════════════════════════════════════
//
// La SEULE source d'URL d'un projet, pour toutes les vues et tous les appels
// sortants du Panel. Un écran, un service ou une sonde qui lirait ailleurs
// rouvrirait exactement le défaut qu'on corrige.
//
// ══ CE QUE CE MODULE N'EST PAS ══════════════════════════════════════════════
//
// Il ne déploie rien, ne migre rien, ne redéploie rien, et n'ouvre aucune
// connexion. Le déploiement est piloté depuis le poste du projet ; le Panel
// ENREGISTRE ce que le projet annonce et arbitre les états.
//
// ══ COMMENT UN PROJET ANNONCE SA DESTINATION ════════════════════════════════
//
// Par trois canaux, et le module les traite tous de la même façon :
//
//   BOOTSTRAP     à l'appairage — porte `publicBackendUrl` et le manifeste ;
//   PRESENTATION  projection poussée à chaque modification — porte les trois
//                 adresses (`website`, `manager`, `backend`) ;
//   MANIFEST      relecture du manifeste, sur action d'un opérateur.
//
// Le battement de cœur, lui, ne transporte AUCUNE URL (schéma `.strict()`) :
// c'est pourquoi une migration sans réappairage passait inaperçue.
import { randomUUID } from 'node:crypto';

import PanelProjectDestination, {
  DESTINATION_STATUS,
} from '../../models/PanelProjectDestination.model.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { currentGeneration } from '../sync/projectGeneration.js';

/**
 * Les états du cycle de vie, réexportés depuis le modèle : les appelants du
 * service n'ont pas à connaître le chemin du modèle pour nommer un état.
 */
export { DESTINATION_STATUS };

/** Les trois adresses qu'une photographie réseau complète doit porter. */
export const NETWORK_KEYS = Object.freeze(['website', 'manager', 'backend']);

/**
 * L'ENVIRONNEMENT D'UN PROJET — une seule règle, écrite une seule fois.
 *
 * ── POURQUOI ELLE VIT ICI ───────────────────────────────────────────────────
 * L'annonce et la lecture doivent employer EXACTEMENT la même : si l'annonce
 * classait une destination en PROD (d'après le manifeste) pendant que la
 * lecture cherchait en `null` (d'après le runtime), la destination existait
 * sans jamais être trouvée. Une règle écrite à deux endroits finit toujours
 * par diverger — celle-ci l'a fait le temps d'un test.
 *
 * Les deux valeurs viennent du PROJET : ce qu'il a annoncé en dernier
 * (`runtime`), et à défaut ce que son manifeste déclare. Le Panel ne devine
 * jamais un environnement.
 */
export function projectEnvironmentOf(record) {
  return record?.runtime?.environment ?? record?.manifest?.project?.environment ?? null;
}

/* -------------------------------------------------------------------------- */
/*  NORMALISATION                                                             */
/* -------------------------------------------------------------------------- */

/** Une URL absolue, sans slash final — ou `null`. Jamais une valeur recomposée. */
function cleanUrl(valeur) {
  const brut = String(valeur ?? '').trim();
  if (!/^https?:\/\//i.test(brut)) return null;
  try {
    const u = new URL(brut);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * HÔTE CANONIQUE d'une destination.
 *
 * Dérivé du SITE quand il est connu, sinon du backend avec son préfixe d'API
 * retiré : `api.demo.fr` et `demo.fr` désignent la même destination, et les
 * traiter comme deux hôtes ferait voir une migration là où il n'y en a pas.
 */
export function destinationHostOf(urls) {
  const source = cleanUrl(urls?.website) ?? cleanUrl(urls?.backend) ?? cleanUrl(urls?.manager);
  if (!source) return null;
  try {
    const h = new URL(source).hostname.toLowerCase();
    /**
     * LES ALIAS DE BOUCLE LOCALE SONT UN SEUL HÔTE.
     *
     * `127.0.0.1`, `localhost` et `::1` désignent la même machine. Les traiter
     * comme trois hôtes fabriquait une MIGRATION là où il n'y en a aucune :
     * un projet qui s'appairait sur `127.0.0.1` puis publiait ses adresses en
     * `localhost` était vu comme ayant déménagé, et le Panel basculait sur une
     * destination qui n'existait pas.
     */
    if (h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0') return 'localhost';
    return h.replace(/^(api|manager)\./, '');
  } catch {
    return null;
  }
}

/** Les trois adresses, nettoyées. Ce qui n'est pas absolu vaut `null`. */
export function normalizeUrls(urls) {
  return {
    website: cleanUrl(urls?.website),
    manager: cleanUrl(urls?.manager),
    backend: cleanUrl(urls?.backend),
  };
}

/** Ce qui manque à une photographie réseau pour être complète. */
export function missingKeys(urls) {
  const n = normalizeUrls(urls);
  return NETWORK_KEYS.filter((k) => !n[k]);
}

/* -------------------------------------------------------------------------- */
/*  LECTURE — LE RÉSOLVEUR UNIQUE                                             */
/* -------------------------------------------------------------------------- */

/** La destination ACTIVE d'un projet dans un environnement, ou `null`. */
export async function activeDestination(projectId, environment) {
  if (!projectId || !environment) return null;
  return PanelProjectDestination.findOne({
    projectId, environment, status: DESTINATION_STATUS.ACTIVE,
  }).lean();
}

/** La clé de lecture du lot : un projet a une destination active PAR environnement. */
export const destinationKey = (projectId, environment) => `${projectId}|${environment}`;

/**
 * LES HÔTES ACTIFS D'UN LOT DE PROJETS — une requête, pas N.
 *
 * ══ POURQUOI CETTE FONCTION EXISTE ══════════════════════════════════════════
 *
 * La génération d'un projet inclut l'hôte de sa destination active. L'écriture
 * d'une projection le lisait ; la LECTURE de la fiche, elle, ne pouvait pas :
 * `toPublicProject` est synchrone, et se contentait donc d'un champ inexistant.
 * Les deux côtés produisaient deux clés différentes, et toute photographie
 * fraîchement reçue était présentée comme venant de l'instance précédente.
 *
 * Charger la destination projet par projet aurait fait N+1 sur la liste du
 * parc. On charge donc le lot ICI, et `toPublicProject` reste synchrone et pur.
 *
 * @param {Array<{projectId:string, environment:string|null}>} projets
 * @returns {Promise<Map<string, string|null>>} `projectId|environment` → hôte
 */
export async function loadActiveDestinationHosts(projets = []) {
  const carte = new Map();
  const cibles = projets.filter((p) => p?.projectId && p?.environment);
  if (cibles.length === 0) return carte;

  // Une absence est une RÉPONSE : « ce projet n'a pas de destination active ».
  // Sans elle, l'appelant ne saurait pas distinguer ce fait d'une ignorance.
  for (const p of cibles) carte.set(destinationKey(p.projectId, p.environment), null);

  const docs = await PanelProjectDestination.find({
    projectId: { $in: [...new Set(cibles.map((p) => p.projectId))] },
    status: DESTINATION_STATUS.ACTIVE,
  }).select('projectId environment host').lean();

  for (const d of docs) {
    const cle = destinationKey(d.projectId, d.environment);
    if (carte.has(cle)) carte.set(cle, d.host ?? null);
  }
  return carte;
}

/**
 * LE RÉSOLVEUR — la seule fonction autorisée à répondre « où vit ce projet ».
 *
 * ── POURQUOI IL NE LIT NI LE MANIFESTE NI LE RUNTIME ────────────────────────
 * Les deux sont des photographies prises à l'appairage, que rien ne rafraîchit
 * ensuite : le battement de cœur ne porte pas d'URL. Les lire en secours
 * ferait resurgir l'ancien domaine dès que la destination est incomplète —
 * c'est précisément le mélange qu'on supprime. Mieux vaut « inconnu » qu'une
 * adresse périmée présentée comme actuelle.
 *
 * @returns {Promise<{
 *   destinationId:string|null, host:string|null, environment:string|null,
 *   website:string|null, manager:string|null, backend:string|null,
 *   status:string|null, resolved:boolean, reason:string
 * }>}
 */
export async function resolveProjectNetwork(record) {
  const environment = projectEnvironmentOf(record);
  const vide = {
    destinationId: null, host: null, environment,
    website: null, manager: null, backend: null,
    status: null, resolved: false,
  };

  if (!record?.projectId) return { ...vide, reason: 'AUCUN_PROJET' };
  if (!environment) return { ...vide, reason: 'ENVIRONNEMENT_INCONNU' };

  const dest = await activeDestination(record.projectId, environment);
  if (!dest) return { ...vide, reason: 'AUCUNE_DESTINATION_ACTIVE' };

  return {
    destinationId: dest.destinationId,
    host: dest.host,
    environment: dest.environment,
    website: dest.urls?.website ?? null,
    manager: dest.urls?.manager ?? null,
    backend: dest.urls?.backend ?? null,
    status: dest.status,
    resolved: true,
    reason: 'DESTINATION_ACTIVE',
  };
}

/**
 * L'URL DE BACKEND à appeler pour ce projet — contrats, santé, opérations.
 *
 * Tous les appels sortants passent par ici. Ils lisaient
 * `runtime.publicBackendUrl`, figée au bootstrap : après un changement de
 * domaine, le Panel interrogeait donc l'ANCIEN serveur, et concluait que le
 * projet était en panne alors qu'il tournait ailleurs.
 */
export async function resolveProjectBackendUrl(record) {
  const reseau = await resolveProjectNetwork(record);
  return reseau.backend;
}

/**
 * L'ADRESSE À APPELER pour ce projet — contrats, santé, découverte, opérations.
 *
 * ── LE DÉFAUT CORRIGÉ ───────────────────────────────────────────────────────
 * Tous les appels sortants lisaient `runtime.publicBackendUrl`, posée au
 * bootstrap et jamais revue. Après un changement de domaine sans réappairage,
 * le Panel interrogeait donc l'ANCIEN serveur : il en concluait que le projet
 * était injoignable ou dégradé, alors qu'il tournait parfaitement ailleurs — et
 * il téléchargeait les contrats depuis un serveur périmé.
 *
 * La fiche arrive déjà résolue par `registryStore` : on lit la destination
 * active, et rien d'autre. `null` quand aucune n'est connue — les appelants
 * refusent alors explicitement, ce qui vaut mieux qu'appeler la mauvaise.
 */
export function outboundBaseUrl(record) {
  return record?.activeNetwork?.backend ?? null;
}

/** Toutes les destinations d'un projet, la plus récente d'abord. */
export async function listDestinations(projectId, { includeDeleted = false } = {}) {
  const query = includeDeleted
    ? { projectId }
    : { projectId, status: { $ne: DESTINATION_STATUS.DELETED } };
  return PanelProjectDestination.find(query).sort({ announcedAt: -1 }).lean();
}

/** Vue lisible d'une destination — ce que l'écran affiche. */
export function describeDestination(d) {
  if (!d) return null;
  return {
    destinationId: d.destinationId,
    projectId: d.projectId,
    environment: d.environment,
    host: d.host,
    urls: {
      website: d.urls?.website ?? null,
      manager: d.urls?.manager ?? null,
      backend: d.urls?.backend ?? null,
    },
    status: d.status,
    generation: d.generation ?? null,
    announcedBy: d.announcedBy ?? null,
    missing: d.missing ?? [],
    announcedAt: d.announcedAt,
    activatedAt: d.activatedAt ?? null,
    retiredAt: d.retiredAt ?? null,
    emptiedAt: d.emptiedAt ?? null,
    deletedAt: d.deletedAt ?? null,
    lastSeenAt: d.lastSeenAt ?? null,
    previousDestinationId: d.previousDestinationId ?? null,
    /**
     * Ce que l'écran a le droit de proposer — calculé ici, jamais dans le
     * navigateur. Il n'y a volontairement AUCUN « retirer » sur une
     * destination active : c'est le projet qui annonce son déménagement, le
     * Panel n'en décide pas. Les deux seules actions humaines sont de
     * constater qu'il ne reste rien, puis de supprimer la fiche.
     */
    canMarkEmpty: d.status === DESTINATION_STATUS.RETIRED,
    canDelete: d.status === DESTINATION_STATUS.EMPTY,
  };
}

/**
 * LES DESTINATIONS D'UN PROJET, GROUPÉES PAR ENVIRONNEMENT.
 *
 * C'est la forme que l'écran attend : pour TEST et pour PROD, la destination
 * active et l'historique. Jamais une liste plate, où deux environnements se
 * mélangeraient à l'œil.
 */
export async function describeByEnvironment(projectId) {
  const toutes = await listDestinations(projectId);
  const par = {};
  for (const env of ['TEST', 'PROD']) {
    const duLot = toutes.filter((d) => d.environment === env);
    par[env] = {
      active: describeDestination(duLot.find((d) => d.status === DESTINATION_STATUS.ACTIVE) ?? null),
      pending: describeDestination(duLot.find((d) => d.status === DESTINATION_STATUS.PENDING) ?? null),
      history: duLot
        .filter((d) => d.status !== DESTINATION_STATUS.ACTIVE && d.status !== DESTINATION_STATUS.PENDING)
        .map(describeDestination),
    };
  }
  return par;
}

/* -------------------------------------------------------------------------- */
/*  ANNONCE ET MIGRATION                                                      */
/* -------------------------------------------------------------------------- */

/**
 * LE PROJET ANNONCE OÙ IL VIT. Le Panel enregistre, arbitre, et ne déploie rien.
 *
 * Quatre situations, et une seule est délicate :
 *
 *  1. aucune destination active   → on l'active, même incomplète. Refuser
 *     laisserait le projet sans aucune adresse, ce qui est pire qu'une adresse
 *     partielle honnêtement signalée ;
 *  2. même hôte                   → rafraîchissement en place ;
 *  3. autre hôte, photographie INCOMPLÈTE → destination `PENDING`. On ne
 *     bascule pas : afficher un projet à moitié décrit est exactement le
 *     défaut qu'on corrige ;
 *  4. autre hôte, photographie COMPLÈTE   → migration contrôlée : l'ancienne
 *     passe `RETIRED`, la nouvelle devient `ACTIVE`, et les projections
 *     techniques de l'ancienne génération sont invalidées.
 *
 * @param {object} args
 * @param {object} args.record   fiche `PanelProject`
 * @param {object} args.urls     { website, manager, backend } tels qu'annoncés
 * @param {string} args.source   BOOTSTRAP · PRESENTATION · MANIFEST · REPAIR
 */
export async function announceDestination({ record, urls, source = null, actor = null }) {
  const projectId = record?.projectId;
  const environment = projectEnvironmentOf(record);
  if (!projectId || !environment) {
    return { applied: false, reason: 'ENVIRONNEMENT_INCONNU' };
  }

  const propres = normalizeUrls(urls);
  const host = destinationHostOf(propres);
  if (!host) return { applied: false, reason: 'AUCUNE_URL_ABSOLUE' };

  const at = nowIso();
  // La génération D'UNE DESTINATION inclut son hôte — c'est-à-dire celui qu'on
  // est en train d'annoncer. L'omettre estampillait toutes les destinations
  // « sans destination », ce qui ne veut rien dire de la part d'une destination.
  const { generation } = currentGeneration(record, host);
  const manque = missingKeys(propres);

  const active = await activeDestination(projectId, environment);

  // ── 2. MÊME HÔTE : on complète et on rafraîchit, sans rien basculer ─────
  if (active && active.host === host) {
    const fusion = {};
    for (const k of NETWORK_KEYS) {
      // Une annonce partielle ne DÉTRUIT pas ce qu'on savait déjà : elle
      // complète. C'est le seul endroit où compléter est correct — on parle
      // du même hôte, donc du même monde.
      fusion[k] = propres[k] ?? active.urls?.[k] ?? null;
    }

    /**
     * ── L'ADRESSE OPÉRATIONNELLE NE SE FAIT PAS ÉCRASER PAR UNE DÉCLARATION ──
     *
     * `backend` n'est pas une adresse comme les autres : c'est celle que le
     * Panel APPELLE. Deux canaux la portent, et ils ne disent pas la même
     * chose :
     *
     *   · BOOTSTRAP  — « rappelez-moi ici ». C'est l'adresse par laquelle le
     *     lien vient d'être établi : elle répond, par construction ;
     *   · PRESENTATION — l'adresse que le projet PUBLIE à ses utilisateurs,
     *     lue dans sa configuration. Elle est descriptive, et peut être
     *     restée sur une valeur par défaut ou une valeur périmée.
     *
     * Sur le MÊME hôte, une déclaration ne remplace donc pas une adresse
     * opérationnelle déjà connue — elle ne fait que la fournir si elle
     * manquait. Sans cette règle, un projet dont la configuration annonce un
     * port par défaut devenait injoignable alors que le Panel savait
     * parfaitement où le joindre.
     *
     * Sur un AUTRE hôte, c'est un déménagement : la nouvelle destination
     * prend les valeurs annoncées telles quelles, et rien de l'ancienne.
     */
    if (source !== 'BOOTSTRAP' && active.urls?.backend) {
      fusion.backend = active.urls.backend;
    }
    await PanelProjectDestination.updateOne(
      { destinationId: active.destinationId },
      {
        $set: {
          urls: fusion,
          missing: missingKeys(fusion),
          generation,
          lastSeenAt: at,
          updatedAt: at,
          ...(source ? { announcedBy: source } : {}),
        },
      },
    );
    return { applied: true, action: 'REFRESHED', destinationId: active.destinationId, host };
  }

  // ── 1. PREMIÈRE DESTINATION : on active, même incomplète ────────────────
  if (!active) {
    const destinationId = randomUUID();
    await PanelProjectDestination.create({
      destinationId,
      projectId,
      environment,
      host,
      urls: propres,
      status: DESTINATION_STATUS.ACTIVE,
      generation,
      announcedBy: source,
      missing: manque,
      announcedAt: at,
      activatedAt: at,
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    logger.info(`[destination] ${record.projectName ?? projectId} ${environment} : première destination « ${host} » (${source ?? 'source inconnue'}).`);
    return { applied: true, action: 'ACTIVATED', destinationId, host, missing: manque };
  }

  // ── 3 & 4. AUTRE HÔTE : migration ───────────────────────────────────────
  const enAttente = await PanelProjectDestination.findOne({
    projectId, environment, host, status: DESTINATION_STATUS.PENDING,
  }).lean();

  const fusionAttente = {};
  for (const k of NETWORK_KEYS) fusionAttente[k] = propres[k] ?? enAttente?.urls?.[k] ?? null;
  const manqueAttente = missingKeys(fusionAttente);

  const destinationId = enAttente?.destinationId ?? randomUUID();
  if (enAttente) {
    await PanelProjectDestination.updateOne(
      { destinationId },
      { $set: { urls: fusionAttente, missing: manqueAttente, generation, lastSeenAt: at, updatedAt: at, ...(source ? { announcedBy: source } : {}) } },
    );
  } else {
    await PanelProjectDestination.create({
      destinationId,
      projectId,
      environment,
      host,
      urls: fusionAttente,
      status: DESTINATION_STATUS.PENDING,
      generation,
      announcedBy: source,
      missing: manqueAttente,
      announcedAt: at,
      lastSeenAt: at,
      previousDestinationId: active.destinationId,
      createdAt: at,
      updatedAt: at,
    });
    logger.warn(`[destination] ${record.projectName ?? projectId} ${environment} : migration annoncée « ${active.host} » → « ${host} ». `
      + 'La bascule attend la photographie complète.');
  }

  /**
   * ── UN BOOTSTRAP BASCULE IMMÉDIATEMENT ────────────────────────────────────
   *
   * Se réappairer est un acte EXPLICITE du projet, et l'adresse qu'il donne
   * alors est celle par laquelle le lien vient d'être établi : elle répond,
   * par construction. Lui imposer d'attendre une photographie complète
   * laisserait le Panel appeler l'ANCIENNE adresse après un déménagement
   * annoncé — c'est-à-dire exactement le défaut qu'on corrige, à l'envers.
   *
   * L'attente ne protège que des annonces DÉCLARATIVES (présentation,
   * manifeste), qui décrivent une intention sans prouver qu'on répond là.
   */
  const bascule = source === 'BOOTSTRAP' || manqueAttente.length === 0;

  // 3. Photographie incomplète et annonce déclarative : on attend.
  if (!bascule) {
    return {
      applied: true, action: 'PENDING', destinationId, host,
      missing: manqueAttente, from: active.host,
    };
  }

  // 4. Photographie COMPLÈTE : bascule contrôlée, en une transition par état.
  await PanelProjectDestination.updateOne(
    { destinationId: active.destinationId, status: DESTINATION_STATUS.ACTIVE },
    { $set: { status: DESTINATION_STATUS.RETIRED, retiredAt: at, updatedAt: at } },
  );
  await PanelProjectDestination.updateOne(
    { destinationId, status: DESTINATION_STATUS.PENDING },
    { $set: { status: DESTINATION_STATUS.ACTIVE, activatedAt: at, updatedAt: at } },
  );

  logger.info(`[destination] ${record.projectName ?? projectId} ${environment} : bascule effectuée « ${active.host} » → « ${host} ».`);
  return {
    applied: true, action: 'MIGRATED', destinationId, host,
    from: active.host, retiredDestinationId: active.destinationId, actor,
  };
}

/* -------------------------------------------------------------------------- */
/*  CYCLE DE VIE — les seules actions offertes à l'opérateur                   */
/* -------------------------------------------------------------------------- */

/**
 * RETIRED → EMPTY. L'opérateur constate qu'il ne reste rien sur le serveur.
 *
 * Le Panel ne le VÉRIFIE pas : il ne se connecte à aucun serveur de projet.
 * C'est une déclaration humaine, et elle est tracée comme telle.
 */
export async function markDestinationEmpty(destinationId, { actor = null } = {}) {
  const at = nowIso();
  const doc = await PanelProjectDestination.findOneAndUpdate(
    { destinationId, status: DESTINATION_STATUS.RETIRED },
    { $set: { status: DESTINATION_STATUS.EMPTY, emptiedAt: at, updatedAt: at } },
    { new: true },
  );
  if (!doc) {
    throw ApiError.conflict('PANEL_DESTINATION_NOT_RETIRED',
      'Seule une destination RETIRÉE peut être déclarée vide. Une destination active '
      + 'ne se retire pas depuis le Panel : c’est le projet qui annonce son déménagement.');
  }
  logger.info(`[destination] ${doc.host} déclarée vide${actor ? ` par ${actor}` : ''}.`);
  return describeDestination(doc.toObject());
}

/** EMPTY → DELETED. Suppression LOGIQUE : l'audit et l'historique survivent. */
export async function deleteDestination(destinationId, { actor = null } = {}) {
  const at = nowIso();
  const doc = await PanelProjectDestination.findOneAndUpdate(
    { destinationId, status: DESTINATION_STATUS.EMPTY },
    { $set: { status: DESTINATION_STATUS.DELETED, deletedAt: at, updatedAt: at } },
    { new: true },
  );
  if (!doc) {
    throw ApiError.conflict('PANEL_DESTINATION_NOT_EMPTY',
      'Seule une destination VIDE peut être supprimée. Déclarez-la vide d’abord.');
  }
  logger.info(`[destination] ${doc.host} supprimée${actor ? ` par ${actor}` : ''} — historique conservé.`);
  return describeDestination(doc.toObject());
}

/* -------------------------------------------------------------------------- */
/*  REPRISE DE L'EXISTANT                                                     */
/* -------------------------------------------------------------------------- */

/**
 * LES TROIS CANAUX PAR LESQUELS UN PROJET A DÉJÀ ANNONCÉ SON ADRESSE.
 *
 * Chacun porte sa DATE : c'est elle, et rien d'autre, qui départage. On ne
 * privilégie aucun canal par principe — on retient la déclaration la plus
 * RÉCENTE du projet. Départager autrement (« le manifeste fait foi ») ferait
 * gagner une photographie prise à l'appairage contre une annonce du lendemain.
 */
export function announcementsOf(record, presentation) {
  const candidats = [];

  if (presentation?.network) {
    candidats.push({
      source: 'PRESENTATION',
      urls: normalizeUrls(presentation.network),
      at: presentation.receivedAt ?? presentation.sourceModifiedAt ?? null,
    });
  }
  if (record?.manifest?.network?.urls) {
    candidats.push({
      source: 'MANIFEST',
      urls: normalizeUrls(record.manifest.network.urls),
      at: record.manifestUpdatedAt ?? null,
    });
  }
  if (record?.runtime?.publicBackendUrl) {
    candidats.push({
      source: 'BOOTSTRAP',
      urls: normalizeUrls({ backend: record.runtime.publicBackendUrl }),
      at: record.pairing?.pairedAt ?? record.createdAt ?? null,
    });
  }

  return candidats
    .map((c) => ({ ...c, host: destinationHostOf(c.urls) }))
    .filter((c) => c.host !== null)
    // Une annonce sans date est la plus ancienne possible : on ne lui fait pas
    // gagner un départage qu'on ne peut pas justifier.
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

/**
 * REPRISE — donne une destination aux projets qui n'en ont pas encore.
 *
 * ══ CE QU'ELLE CORRIGE ══════════════════════════════════════════════════════
 *
 * Les fiches antérieures aux destinations portent leurs adresses dans trois
 * champs écrits à trois moments. Quand un projet a déménagé sans se
 * réappairer, ces champs DIVERGENT — et le Panel affichait les deux.
 *
 * La reprise retient l'annonce la plus RÉCENTE du projet comme destination
 * ACTIVE, et conserve les hôtes plus anciens en `RETIRED`. Elle n'invente
 * rien : toutes les valeurs viennent du projet lui-même, et l'ordre est celui
 * de leurs dates.
 *
 * ══ CE QU'ELLE NE FAIT PAS ══════════════════════════════════════════════════
 *
 * Elle ne contacte aucun serveur, ne déploie rien, ne supprime aucune fiche et
 * ne réécrit ni le manifeste ni le runtime : ces champs restent tels quels,
 * simplement plus jamais lus comme des adresses. Relancée, elle ne change rien.
 */
export async function reconcileDestinations({ actor = null, dryRun = false } = {}) {
  const PanelProject = (await import('../../models/PanelProject.model.js')).default;
  const { PanelProjectPresentation } = await import('../../models/PanelProjectProjection.model.js');

  const projets = await PanelProject.find({}).lean();
  const rapport = {
    dryRun, scanned: projets.length, activated: 0, retired: 0,
    alreadyKnown: 0, skipped: [], divergences: [],
  };

  for (const record of projets) {
    const environment = projectEnvironmentOf(record);
    if (!environment) {
      rapport.skipped.push({ projectId: record.projectId, reason: 'ENVIRONNEMENT_INCONNU' });
      continue;
    }
    if (await activeDestination(record.projectId, environment)) {
      rapport.alreadyKnown += 1;
      continue;
    }

    const presentation = await PanelProjectPresentation.findOne({ projectId: record.projectId }).lean();
    const annonces = announcementsOf(record, presentation);
    if (annonces.length === 0) {
      rapport.skipped.push({ projectId: record.projectId, reason: 'AUCUNE_ADRESSE_ANNONCEE' });
      continue;
    }

    const [courante, ...anciennes] = annonces;
    const hotesAnciens = [...new Set(anciennes.map((a) => a.host).filter((h) => h !== courante.host))];

    if (hotesAnciens.length > 0) {
      // C'est le cas de Demo SB Auto : on le NOMME, avec ses dates, pour que
      // la reprise soit vérifiable plutôt que crue sur parole.
      rapport.divergences.push({
        projectId: record.projectId,
        projectName: record.projectName,
        environment,
        retained: { host: courante.host, source: courante.source, at: courante.at },
        superseded: anciennes
          .filter((a) => a.host !== courante.host)
          .map((a) => ({ host: a.host, source: a.source, at: a.at })),
      });
    }

    if (dryRun) continue;

    const at = nowIso();
    const { generation } = currentGeneration(record, courante.host);

    // Les hôtes plus anciens deviennent l'HISTOIRE du projet — jamais un
    // silence. L'opérateur pourra les déclarer vides puis les supprimer.
    for (const ancien of hotesAnciens) {
      const source = anciennes.find((a) => a.host === ancien);
      await PanelProjectDestination.create({
        destinationId: randomUUID(),
        projectId: record.projectId,
        environment,
        host: ancien,
        urls: source.urls,
        status: DESTINATION_STATUS.RETIRED,
        generation: null,
        announcedBy: source.source,
        missing: missingKeys(source.urls),
        announcedAt: source.at ?? at,
        retiredAt: at,
        createdAt: at,
        updatedAt: at,
      });
      rapport.retired += 1;
    }

    await PanelProjectDestination.create({
      destinationId: randomUUID(),
      projectId: record.projectId,
      environment,
      host: courante.host,
      urls: courante.urls,
      status: DESTINATION_STATUS.ACTIVE,
      generation,
      announcedBy: courante.source,
      missing: missingKeys(courante.urls),
      announcedAt: courante.at ?? at,
      activatedAt: at,
      lastSeenAt: record.runtime?.lastHeartbeatAt ?? null,
      createdAt: at,
      updatedAt: at,
    });
    rapport.activated += 1;

    logger.info(`[destination] Reprise « ${record.projectName} » ${environment} : `
      + `active « ${courante.host} » (${courante.source}, ${courante.at ?? 'sans date'})`
      + (hotesAnciens.length ? `, retirée(s) : ${hotesAnciens.join(', ')}` : '') + `.${actor ? ` — ${actor}` : ''}`);
  }

  return rapport;
}

export default {
  DESTINATION_STATUS,
  announcementsOf,
  reconcileDestinations,
  outboundBaseUrl,
  NETWORK_KEYS,
  normalizeUrls,
  missingKeys,
  destinationHostOf,
  activeDestination,
  resolveProjectNetwork,
  resolveProjectBackendUrl,
  listDestinations,
  describeDestination,
  describeByEnvironment,
  announceDestination,
  markDestinationEmpty,
  deleteDestination,
};
