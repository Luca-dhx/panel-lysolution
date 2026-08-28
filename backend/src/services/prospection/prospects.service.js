/**
 * LA PROSPECTION — les affaires qui ne sont pas encore des clients.
 *
 * ── AUCUN PONT, AUCUNE PUBLICATION ──────────────────────────────────────────
 * Rien ici n'appelle un projet et rien ne part en synchronisation. Un prospect
 * est une note interne : le nom d'un garage croisé sur la route, un numéro
 * obtenu par un tiers, ce qu'on pense de l'affaire. Publier cela chez qui que
 * ce soit serait indéfendable.
 *
 * ── LE STATUT NE BOUGE QUE PAR UNE DÉCISION HUMAINE ─────────────────────────
 * Aucun ordonnanceur ne touche à ce fichier. Voir l'en-tête du modèle.
 */
import crypto from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import {
  PROSPECT_STATUS,
  PROSPECT_STATUS_VALUES,
  PROSPECT_TYPE,
  PROSPECT_TYPE_VALUES,
  PanelProspect,
} from '../../models/PanelProspect.model.js';
import { verifierDossierDeProspect } from './prospectLibrary.service.js';
import { PanelMeeting } from '../../models/PanelMeeting.model.js';
import { PanelProjectEvent } from '../../models/PanelProjectEvent.model.js';

const identifiant = () => crypto.randomUUID();

const texte = (valeur, defaut = '') => (
  valeur === undefined || valeur === null ? defaut : String(valeur).trim()
);

/**
 * UN LIEN DOIT MENER QUELQUE PART.
 *
 * ── POURQUOI ON NORMALISE PLUTÔT QUE DE REFUSER ─────────────────────────────
 * Personne ne tape « https:// » devant l'adresse d'un site. Refuser
 * `garage-dupont.fr` aurait transformé la saisie la plus courante en erreur ;
 * on préfixe donc, ce qui rend le lien cliquable sans rien demander de plus.
 *
 * En revanche, un schéma exotique est REFUSÉ. Un `javascript:` enregistré ici
 * s'exécuterait au clic depuis la fiche : c'est la seule chose que cette
 * fonction protège vraiment.
 */
function normaliserLien(brut) {
  const url = texte(brut?.url);
  if (!url) return null;

  const candidat = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  let analyse;
  try {
    analyse = new URL(candidat);
  } catch {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_LINK_INVALID',
      `Ce lien n’est pas une adresse valide : ${url}`,
    );
  }
  if (!['http:', 'https:'].includes(analyse.protocol)) {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_LINK_SCHEME',
      'Un lien doit être une adresse http ou https.',
    );
  }

  return {
    id: texte(brut?.id) || identifiant(),
    label: texte(brut?.label).slice(0, 120),
    url: analyse.toString(),
  };
}

function normaliserLiens(liste) {
  if (!Array.isArray(liste)) return [];
  return liste.map(normaliserLien).filter(Boolean);
}

/**
 * UNE IMAGE EST UNE RÉFÉRENCE, PAS UN FICHIER.
 *
 * On n'accepte QUE les chemins servis par le Panel (`/uploads/…`). Le
 * navigateur nous enverrait volontiers l'adresse absolue qu'il vient
 * d'afficher — elle porte le domaine courant, et la fiche deviendrait fausse
 * le jour où le Panel change d'adresse. On ne conserve que ce qui identifie.
 */
function normaliserImage(brut) {
  const url = texte(brut?.url);
  if (!url) return null;
  if (!url.startsWith('/uploads/')) {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_IMAGE_INVALID',
      'Une image doit avoir été importée dans le Panel.',
    );
  }
  return {
    id: texte(brut?.id) || identifiant(),
    url,
    filename: texte(brut?.filename) || null,
    caption: texte(brut?.caption).slice(0, 200),
    addedAt: brut?.addedAt ? new Date(brut.addedAt) : new Date(),
  };
}

function normaliserImages(liste) {
  if (!Array.isArray(liste)) return [];
  return liste.map(normaliserImage).filter(Boolean);
}

/**
 * UN CHAMP D'INFORMATION LIBRE.
 *
 * Sans NOM, il n'y a pas de champ : une valeur sans étiquette est illisible
 * pour quiconque relit la fiche. La valeur, elle, peut être vide — on crée
 * souvent l'étiquette avant d'avoir la réponse.
 */
function normaliserChampInfo(brut) {
  const label = texte(brut?.label);
  if (!label) return null;
  return {
    id: texte(brut?.id) || identifiant(),
    label: label.slice(0, 120),
    value: texte(brut?.value).slice(0, 4000),
  };
}

function normaliserChampsInfo(liste) {
  if (!Array.isArray(liste)) return [];
  return liste.map(normaliserChampInfo).filter(Boolean).slice(0, 100);
}

/**
 * UN MESSAGE — envoyé, ou à envoyer.
 *
 * Un message sans canal NI titre NI contenu n'est rien : il est écarté plutôt
 * que d'occuper une ligne vide dans la liste. N'importe lequel des trois suffit
 * à le garder — on note parfois le canal et le titre avant d'écrire le texte.
 *
 * `sentAt` porte l'état à lui seul : `null` = prévu, une date = envoyé.
 */
function normaliserMessage(brut) {
  const channel = texte(brut?.channel).slice(0, 120);
  const title = texte(brut?.title).slice(0, 200);
  const body = brut?.body === undefined || brut?.body === null ? '' : String(brut.body);
  if (!channel && !title && !body.trim()) return null;

  let sentAt = null;
  if (brut?.sentAt) {
    const date = new Date(brut.sentAt);
    if (Number.isNaN(date.getTime())) {
      throw ApiError.badRequest(
        'PANEL_PROSPECT_MESSAGE_DATE_INVALID',
        'La date d’envoi doit être une date valide.',
      );
    }
    sentAt = date;
  }

  return {
    id: texte(brut?.id) || identifiant(),
    channel,
    title,
    body: body.slice(0, 20000),
    sentAt,
    createdAt: brut?.createdAt ? new Date(brut.createdAt) : new Date(),
    createdBy: texte(brut?.createdBy) || null,
  };
}

function normaliserMessages(liste) {
  if (!Array.isArray(liste)) return [];
  return liste.map(normaliserMessage).filter(Boolean).slice(0, 200);
}

function normaliserStatut(valeur) {
  if (!PROSPECT_STATUS_VALUES.includes(valeur)) {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_STATUS_UNKNOWN',
      'Statut de prospect inconnu.',
    );
  }
  return valeur;
}

/**
 * LA NATURE DE L'AFFAIRE — conception ou refonte.
 *
 * Une valeur hors liste est REFUSÉE plutôt que ramenée au défaut : retomber
 * silencieusement sur « conception » ferait apparaître une refonte comme un
 * site à créer, et c'est précisément la confusion que ce champ existe pour
 * lever — le devis et les questions du premier rendez-vous n'en sont pas les
 * mêmes.
 */
function normaliserType(valeur) {
  if (!PROSPECT_TYPE_VALUES.includes(valeur)) {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_TYPE_UNKNOWN',
      'Un prospect est une conception ou une refonte.',
    );
  }
  return valeur;
}

/* ── Écritures ────────────────────────────────────────────────────────────── */

export async function createProspect(data = {}, actor = {}) {
  const name = texte(data.name);
  if (!name) {
    throw ApiError.badRequest('PANEL_PROSPECT_NAME_REQUIRED', 'Un nom est requis.');
  }

  const status = data.status === undefined || data.status === null
    ? PROSPECT_STATUS.WAITING
    : normaliserStatut(data.status);

  const type = data.type === undefined || data.type === null
    ? PROSPECT_TYPE.CREATION
    : normaliserType(data.type);

  return PanelProspect.create({
    name,
    email: texte(data.email),
    phone: texte(data.phone),
    notes: data.notes === undefined ? '' : String(data.notes),
    links: normaliserLiens(data.links),
    images: normaliserImages(data.images),
    folderId: await verifierDossierDeProspect(data.folderId),
    infoFields: normaliserChampsInfo(data.infoFields),
    messages: normaliserMessages(data.messages),
    status,
    type,
    // Même la création est datée dans l'historique : sans cette première
    // ligne, un prospect créé directement « en cours » n'aurait aucune origine.
    statusHistory: [{
      at: new Date(),
      from: null,
      to: status,
      actorEmail: actor.email ?? null,
      note: null,
    }],
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

async function chargerOuLever(prospectId) {
  const prospect = await PanelProspect.findById(prospectId).catch(() => null);
  if (!prospect) {
    throw ApiError.notFound('PANEL_PROSPECT_NOT_FOUND', 'Prospect introuvable.');
  }
  return prospect;
}

/**
 * MODIFIER — champ par champ, jamais un remplacement en bloc.
 *
 * Chaque propriété n'est touchée que si elle est PRÉSENTE dans le corps. Un
 * `PATCH` qui ne parle que du téléphone ne doit pas effacer les notes parce
 * qu'il ne les mentionne pas — c'est la façon la plus banale de perdre du
 * travail sans que personne ne s'en aperçoive.
 *
 * Le STATUT n'est volontairement pas modifiable ici : il a sa propre route,
 * parce qu'il produit une entrée d'historique et qu'il se pilote depuis une
 * liste déroulante, pas depuis un formulaire d'édition.
 */
export async function updateProspect(prospectId, data = {}, actor = {}) {
  const prospect = await chargerOuLever(prospectId);

  if (data.name !== undefined) {
    const name = texte(data.name);
    if (!name) {
      throw ApiError.badRequest('PANEL_PROSPECT_NAME_REQUIRED', 'Un nom est requis.');
    }
    prospect.name = name;
  }
  if (data.email !== undefined) prospect.email = texte(data.email);
  if (data.phone !== undefined) prospect.phone = texte(data.phone);
  if (data.notes !== undefined) prospect.notes = String(data.notes);
  if (data.links !== undefined) prospect.links = normaliserLiens(data.links);
  if (data.images !== undefined) prospect.images = normaliserImages(data.images);
  if (data.folderId !== undefined) prospect.folderId = await verifierDossierDeProspect(data.folderId);
  if (data.infoFields !== undefined) prospect.infoFields = normaliserChampsInfo(data.infoFields);
  if (data.messages !== undefined) prospect.messages = normaliserMessages(data.messages);
  /**
   * LE TYPE PASSE PAR ICI, ET NON PAR UNE ROUTE À LUI.
   *
   * Contrairement au statut, il ne produit aucune entrée d'historique : ce
   * n'est pas une étape du pipeline, c'est une caractéristique de l'affaire.
   * Un « journal des changements de type » aurait consigné une correction de
   * saisie comme un événement commercial.
   */
  if (data.type !== undefined) prospect.type = normaliserType(data.type);

  prospect.updatedBy = actor.email ?? null;
  await prospect.save();
  return prospect;
}

/**
 * CHANGER LE STATUT — l'unique geste qui fait avancer une affaire.
 *
 * Toutes les transitions sont permises, y compris les retours en arrière : une
 * affaire perdue se rouvre, un « signé » cliqué par erreur se corrige. Ce qui
 * est conservé, c'est QUI a bougé le curseur, QUAND et DEPUIS QUOI.
 *
 * Reposer le même statut ne consigne rien : un historique rempli de
 * « en cours → en cours » ne se lit plus.
 */
export async function setProspectStatus(prospectId, { status, note = null } = {}, actor = {}) {
  const cible = normaliserStatut(status);
  const prospect = await chargerOuLever(prospectId);

  if (prospect.status === cible) return prospect;

  prospect.statusHistory.push({
    at: new Date(),
    from: prospect.status,
    to: cible,
    actorEmail: actor.email ?? null,
    note: texte(note) || null,
  });
  prospect.status = cible;
  prospect.updatedBy = actor.email ?? null;
  await prospect.save();
  return prospect;
}

/**
 * SUPPRIMER — et emporter l'agenda qui allait avec.
 *
 * ── POURQUOI ON NE LAISSE PAS LES RENDEZ-VOUS DERRIÈRE ──────────────────────
 * Une réunion cite son sujet par identifiant. Supprimer la fiche sans les
 * réunions aurait laissé dans l'agenda de l'équipe des rendez-vous intitulés
 * « Visite » sans plus personne au bout — et un lien « voir le prospect » qui
 * mène à une page introuvable.
 *
 * On ne conserve donc rien : un prospect n'est pas une pièce comptable, et
 * l'archivage silencieux d'un carnet de prospection n'a aucune valeur légale.
 */
export async function deleteProspect(prospectId) {
  const prospect = await chargerOuLever(prospectId);
  const id = String(prospect._id);

  await Promise.all([
    PanelMeeting.deleteMany({ projectId: id, subjectType: 'PROSPECT' }),
    PanelProjectEvent.deleteMany({ projectId: id, subjectType: 'PROSPECT' }),
  ]);
  await prospect.deleteOne();

  return { deleted: true, prospectId: id };
}

/* ── Lectures ─────────────────────────────────────────────────────────────── */

/**
 * LE TABLEAU DE PROSPECTION.
 *
 * Le tri et le filtrage fin se font à l'écran, sur une liste déjà en main : un
 * carnet de prospection se compte en dizaines, pas en dizaines de milliers, et
 * un aller-retour réseau par clic de colonne aurait rendu le tri poussif pour
 * rien. La borne existe malgré tout — elle protège la page, pas la base.
 */
export async function listProspects({ status = null, type = null, limit = 500 } = {}) {
  const filtre = {};
  if (status) filtre.status = normaliserStatut(status);
  /**
   * FILTRER SUR « CONCEPTION » DOIT RAMENER LES FICHES SANS CHAMP.
   *
   * Celles créées avant l'arrivée du type ne le portent pas : une égalité
   * stricte les aurait rendues introuvables dans les DEUX filtres, donc
   * invisibles dès qu'on en pose un. `CREATION` est le défaut du schéma — on
   * le demande donc par « ce n'est pas une refonte ».
   */
  if (type === 'REDESIGN') filtre.type = 'REDESIGN';
  else if (type === 'CREATION') filtre.type = { $ne: 'REDESIGN' };
  else if (type) normaliserType(type);
  return PanelProspect.find(filtre).sort({ updatedAt: -1 }).limit(limit).lean();
}

/**
 * LA FICHE — le prospect ET son suivi.
 *
 * Les trois lectures partent ENSEMBLE : servies l'une après l'autre, l'écran
 * se serait peint en trois fois, et l'onglet « suivi » aurait clignoté à
 * chaque ouverture.
 */
export async function describeProspect(prospectId) {
  const prospect = await chargerOuLever(prospectId);
  const id = String(prospect._id);

  const [meetings, events] = await Promise.all([
    PanelMeeting.find({ projectId: id, subjectType: 'PROSPECT' })
      .sort({ scheduledAt: 1 }).lean(),
    PanelProjectEvent.find({ projectId: id, subjectType: 'PROSPECT' })
      .sort({ occurredAt: -1 }).limit(100).lean(),
  ]);

  return { prospect: prospect.toObject(), meetings, events };
}

/**
 * COMBIEN, ET DANS QUEL ÉTAT — pour l'en-tête du tableau.
 *
 * Tous les statuts sont présents, y compris ceux à zéro : une colonne qui
 * disparaît quand elle est vide fait croire que l'état n'existe pas.
 */
export async function summarizeProspects() {
  const lignes = await PanelProspect.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const parStatut = Object.fromEntries(PROSPECT_STATUS_VALUES.map((s) => [s, 0]));
  for (const ligne of lignes) {
    if (ligne._id in parStatut) parStatut[ligne._id] = ligne.count;
  }

  /**
   * LE COMPTE PAR TYPE — les fiches sans champ comptent pour « conception ».
   *
   * C'est le pendant du filtre : un total qui ne retomberait pas sur celui du
   * pipeline ferait douter des deux.
   */
  const parType = { CREATION: 0, REDESIGN: 0 };
  const refontes = await PanelProspect.countDocuments({ type: 'REDESIGN' });
  const total = Object.values(parStatut).reduce((a, b) => a + b, 0);
  parType.REDESIGN = refontes;
  parType.CREATION = total - refontes;

  return { total, byStatus: parStatut, byType: parType };
}

export default {
  createProspect,
  updateProspect,
  setProspectStatus,
  deleteProspect,
  listProspects,
  describeProspect,
  summarizeProspects,
};
