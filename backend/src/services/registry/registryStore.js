// Persistance du registre — MongoDB (bases TEST/PROD du Panel selon ENV).
// Interface stable depuis la Phase 2B : les services manipulent des fiches
// « plain object », le store est le seul à connaître Mongoose.
//
// ══ LE SEUL POINT DE CHARGEMENT — ET DONC LE SEUL RÉSOLVEUR ═════════════════
//
// Toute fiche qui sort d'ici porte `activeNetwork` : les adresses de la
// destination ACTIVE du projet, dans son environnement courant. C'est ce qui
// rend le résolveur unique par CONSTRUCTION plutôt que par discipline — un
// écran, un service ou une sonde ne peut pas « oublier » de l'appeler, puisque
// la fiche arrive déjà résolue.
//
// Le champ est CALCULÉ, jamais persisté : `save()` le retire avant écriture.
// Le laisser filtrer dans `panelprojects` créerait une quatrième copie des
// URLs — exactement la multiplication de sources qu'on supprime.
import PanelProject from '../../models/PanelProject.model.js';
import { PanelProjectPresentation } from '../../models/PanelProjectProjection.model.js';
import PanelProjectDestination, { DESTINATION_STATUS } from '../../models/PanelProjectDestination.model.js';
import { projectEnvironmentOf } from './projectDestination.service.js';

const toRecord = (doc) => {
  if (!doc) return null;
  const { _id, ...record } = doc;
  return record;
};

/** Les adresses d'une destination, sous la forme que lisent les descripteurs. */
function networkOf(destination) {
  if (!destination) {
    return {
      destinationId: null, host: null, environment: null,
      website: null, manager: null, backend: null,
      status: null, resolved: false, reason: 'AUCUNE_DESTINATION_ACTIVE',
    };
  }
  return {
    destinationId: destination.destinationId,
    host: destination.host,
    environment: destination.environment,
    website: destination.urls?.website ?? null,
    manager: destination.urls?.manager ?? null,
    backend: destination.urls?.backend ?? null,
    status: destination.status,
    resolved: true,
    reason: 'DESTINATION_ACTIVE',
  };
}

/**
 * LA PRÉSENTATION POUSSÉE PAR LE PROJET — la photographie la plus récente.
 *
 * ══ POURQUOI ELLE REJOINT LE POINT DE CHARGEMENT ════════════════════════════
 *
 * Le nom affiché d'un projet se lisait dans son MANIFESTE. Or un manifeste est
 * une photographie prise à l'appairage, relue seulement sur action d'un
 * opérateur : renommer l'entreprise dans le Manager ne le touche pas. Le
 * projet poussait pourtant sa nouvelle présentation en moins d'une seconde, le
 * Panel la persistait — et personne ne la lisait.
 *
 * C'est mot pour mot le défaut déjà corrigé sur les URLs, un champ plus loin :
 * deux sources pour une même vérité, dont une seule vivante.
 *
 * La correction est la même, et pour la même raison : la fiche arrive DÉJÀ
 * résolue. Un écran, un service ou une sonde ne peut plus « oublier » de lire
 * la projection, puisqu'elle est là.
 *
 * Le champ est CALCULÉ, jamais persisté — `save()` le retire avant écriture.
 */
function presentationOf(projection) {
  if (!projection) return null;
  return {
    companyName: projection.companyName ?? null,
    tagline: projection.tagline ?? null,
    logoUrl: projection.logoUrl ?? null,
    logo: projection.logo ?? null,
    contacts: projection.contacts ?? null,
    faviconUrl: projection.faviconUrl ?? null,
    /** Le projet tel qu’il se nomme et se décrit — mis à plat par le projecteur. */
    projectName: projection.projectName ?? null,
    description: projection.description ?? null,
    network: projection.network ?? null,
    /**
     * QUAND LE PROJET A PRODUIT CETTE PHOTOGRAPHIE — jamais quand on l'a reçue.
     *
     * Le projecteur l'écrit sous `sourceModifiedAt` : c'est la date que le
     * PROJET a mise sur son écriture, pas celle de notre réception. Les deux
     * diffèrent dès qu'une livraison a été retardée, et c'est la première qui
     * dit si l'on regarde bien son dernier état.
     */
    modifiedAt: projection.sourceModifiedAt ?? null,
    receivedAt: projection.updatedAt ?? null,
  };
}

/** Décore UNE fiche avec sa destination active. */
async function withNetwork(record) {
  if (!record) return null;
  // MÊME RÈGLE D'ENVIRONNEMENT que l'annonce — écrite une seule fois, dans le
  // service. Deux règles divergentes classeraient une destination dans un
  // environnement où plus personne n'irait la chercher : elle existerait sans
  // jamais être trouvée.
  const environment = projectEnvironmentOf(record);
  if (!environment) {
    const seule = await PanelProjectPresentation.findOne({ projectId: record.projectId }).lean();
    return {
      ...record,
      activeNetwork: networkOf(null),
      activePresentation: presentationOf(seule),
    };
  }
  const destination = await PanelProjectDestination.findOne({
    projectId: record.projectId,
    environment,
    status: DESTINATION_STATUS.ACTIVE,
  }).lean();
  const presentation = await PanelProjectPresentation.findOne({
    projectId: record.projectId,
  }).lean();
  return {
    ...record,
    activeNetwork: networkOf(destination),
    activePresentation: presentationOf(presentation),
  };
}

/**
 * Décore un LOT de fiches — une seule requête pour tout le parc.
 *
 * Une requête par projet ferait N+1 sur la page « Projets clients », qui
 * charge l'ensemble du parc à chaque affichage.
 */
async function withNetworkAll(records) {
  if (records.length === 0) return [];
  const destinations = await PanelProjectDestination.find({
    projectId: { $in: records.map((r) => r.projectId) },
    status: DESTINATION_STATUS.ACTIVE,
  }).lean();
  const par = new Map(destinations.map((d) => [`${d.projectId}|${d.environment}`, d]));
  // UNE seule requête pour tout le parc — la fiche projet et la liste lisent
  // la même chose, et personne ne paie un N+1 pour l'obtenir.
  const presentations = await PanelProjectPresentation.find({
    projectId: { $in: records.map((r) => r.projectId) },
  }).lean();
  const parProjet = new Map(presentations.map((p) => [p.projectId, p]));
  return records.map((r) => ({
    ...r,
    activeNetwork: networkOf(par.get(`${r.projectId}|${projectEnvironmentOf(r) ?? ''}`) ?? null),
    activePresentation: presentationOf(parProjet.get(r.projectId) ?? null),
  }));
}

/**
 * Retire ce qui est CALCULÉ avant toute écriture.
 *
 * Sans cela, `activeNetwork` serait persisté dans `panelprojects` à la
 * première sauvegarde, et deviendrait une quatrième copie des URLs — figée,
 * celle-là, puisque plus rien ne la recalculerait.
 */
function forStorage(record) {
  const { _id, activeNetwork, activePresentation, ...data } = record;
  return data;
}

export const registryStore = {
  async insert(record) {
    await PanelProject.create(forStorage(record));
    return record;
  },

  async getById(projectId) {
    return withNetwork(toRecord(await PanelProject.findOne({ projectId }).lean()));
  },

  async getByKey(projectKey) {
    return withNetwork(toRecord(await PanelProject.findOne({ projectKey }).lean()));
  },

  /**
   * Recherche par ADRESSE — la fiche et le projet distant sont la même chose
   * vus des deux bouts.
   *
   * On interroge d'abord les DESTINATIONS : c'est là que vit l'adresse
   * courante. `runtime.publicBackendUrl` n'est plus qu'un repli pour les
   * fiches antérieures aux destinations — figée au bootstrap, elle désigne
   * l'ancien domaine après un déménagement, et s'y fier seule ferait déclarer
   * « déjà connu » un projet qu'on ne reconnaît plus, ou l'inverse.
   */
  async getByBackendUrl(normalizedUrl) {
    if (!normalizedUrl) return null;
    const destination = await PanelProjectDestination.findOne({
      'urls.backend': normalizedUrl,
      status: DESTINATION_STATUS.ACTIVE,
    }).lean();
    if (destination) {
      return withNetwork(toRecord(await PanelProject.findOne({ projectId: destination.projectId }).lean()));
    }
    return withNetwork(toRecord(await PanelProject.findOne({ 'runtime.publicBackendUrl': normalizedUrl }).lean()));
  },

  async list() {
    return withNetworkAll((await PanelProject.find({}).lean()).map(toRecord));
  },

  async save(record) {
    record.updatedAt = new Date().toISOString();
    await PanelProject.updateOne({ projectId: record.projectId }, { $set: forStorage(record) });
    return record;
  },

  /**
   * Écriture CONDITIONNELLE au code d'appairage encore en place.
   *
   * Le bootstrap lit la fiche, vérifie le code, puis écrit — deux temps. Entre
   * les deux, un second bootstrap portant le MÊME code passait les mêmes
   * contrôles sur la même fiche encore intacte : les deux réussissaient, et le
   * dernier écrasait le bridgeToken du premier, qui se retrouvait appairé avec
   * un jeton mort. Le filtre porte donc sur le hash lu au début : la première
   * écriture consomme le code, la seconde ne correspond plus à rien.
   *
   * @returns {Promise<boolean>} vrai si CETTE écriture a consommé le code.
   */
  async saveIfPairingCodeMatches(record, expectedHash) {
    record.updatedAt = new Date().toISOString();
    const result = await PanelProject.updateOne(
      { projectId: record.projectId, 'pairing.pairingCodeHash': expectedHash },
      { $set: forStorage(record) },
    );
    return result.matchedCount === 1;
  },

  async remove(projectId) {
    const result = await PanelProject.deleteOne({ projectId });
    return result.deletedCount > 0;
  },

  async clear() {
    await PanelProject.deleteMany({});
  },
};

export default registryStore;
