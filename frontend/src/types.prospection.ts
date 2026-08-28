/**
 * PROSPECTION — les affaires qui ne sont pas encore des clients.
 *
 * Ces types sont le miroir exact de `PanelProspect.model.js`. Un prospect n'est
 * ni un projet (pas d'instance technique) ni une entreprise cliente (pas de
 * SIREN, pas de facture) : voir l'en-tête du modèle pour le pourquoi.
 */

export type ProspectStatus = 'WAITING' | 'IN_PROGRESS' | 'PLANNED' | 'LOST' | 'SIGNED';

export const PROSPECT_STATUSES: ProspectStatus[] = [
  'WAITING', 'IN_PROGRESS', 'PLANNED', 'LOST', 'SIGNED',
];

/**
 * LA NATURE DE L'AFFAIRE — un second axe, distinct du statut.
 *
 *   `status`  où en est-on ?  il bouge.
 *   `type`    que fait-on ?   le prospect a déjà un site, ou il n'en a pas.
 *
 * FACULTATIF à la lecture : les fiches créées avant ce champ ne le portent
 * pas, et `.lean()` n'applique aucun défaut de schéma côté serveur. Toute
 * lecture retombe donc explicitement sur `CREATION` — voir `prospectType()`.
 */
export type ProspectType = 'CREATION' | 'REDESIGN';

export const PROSPECT_TYPES: ProspectType[] = ['CREATION', 'REDESIGN'];

export interface ProspectLink {
  id: string;
  label: string;
  url: string;
}

export interface ProspectImage {
  id: string;
  /** CHEMIN RELATIF (`/uploads/…`) — jamais une adresse absolue. */
  url: string;
  filename: string | null;
  caption: string;
  addedAt?: string;
}

export interface ProspectStatusChange {
  at: string;
  from: ProspectStatus | null;
  to: ProspectStatus;
  actorEmail: string | null;
  note: string | null;
}

/**
 * UN CHAMP D'INFORMATION LIBRE — un nom, un contenu.
 *
 * On ne sait pas d'avance ce qu'on notera : « budget annonce », « hebergeur
 * actuel », « qui decide ». Figer une liste de colonnes aurait oblige a migrer
 * le modele chaque fois qu'une question nouvelle apparait. Le prix paye est
 * qu'aucun de ces champs n'est interrogeable finement : ce sont des NOTES
 * structurees, pas des criteres de recherche.
 */
export interface ProspectInfoField {
  id: string;
  label: string;
  value: string;
}

/**
 * UN MESSAGE — envoye, ou a envoyer.
 *
 * `sentAt` porte l'état À LUI SEUL : `null` = prévu, une date = envoyé. Un
 * booléen à côté d'une date aurait permis les deux incohérences classiques —
 * envoyé sans date, daté sans être envoyé — et il aurait fallu décider
 * laquelle des deux croire.
 *
 * Rien ici n'ENVOIE quoi que ce soit : le Panel note ce qui a ete fait
 * ailleurs.
 */
export interface ProspectMessage {
  id: string;
  /** Texte libre : « e-mail », « LinkedIn », « au telephone », « via son associe ». */
  channel: string;
  /** Interne, jamais envoye : « premier contact », « relance 1 ». */
  title: string;
  body: string;
  sentAt: string | null;
  createdAt?: string;
  createdBy?: string | null;
}

/**
 * UN DOSSIER — un rangement, et rien d'autre.
 *
 * `parentId: null` = à la racine de son arbre. Deux arbres SÉPARÉS :
 * « Restaurants » range des prospects, « Accroches froides » range des modèles.
 * Les mélanger aurait obligé à filtrer partout, puis à expliquer un jour
 * pourquoi un modèle est apparu dans le dossier d'un client.
 *
 * Supprimer un dossier ne supprime RIEN d'autre : ses sous-dossiers et son
 * contenu remontent d'un cran. Un rangement n'est pas une corbeille.
 */
export type FolderKind = 'PROSPECT' | 'TEMPLATE';

export interface ProspectFolder {
  _id: string;
  name: string;
  parentId: string | null;
  kind: FolderKind;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * UN MODÈLE D'ACCROCHE — ce qu'on écrit AVANT de connaître le destinataire.
 *
 * Ce n'est pas un message : un message est adressé à quelqu'un, à une date, sur
 * un canal donné. Un modèle n'est adressé à personne. La `description` est ce
 * qui les sépare vraiment — elle répond à « quand s'en sert-on ? », question
 * qu'un message envoyé ne pose pas.
 */
export interface ProspectTemplate {
  _id: string;
  title: string;
  channel: string;
  description: string;
  body: string;
  folderId: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProspectTemplateInput {
  title?: string;
  channel?: string;
  description?: string;
  body?: string;
  folderId?: string | null;
}

export interface Prospect {
  _id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  links: ProspectLink[];
  images: ProspectImage[];
  /** `null` = à la racine. Un prospect noté pendant un appel n'a pas à être
   *  classé pour exister ; l'écran le montre dans « Sans dossier ». */
  folderId: string | null;
  infoFields: ProspectInfoField[];
  messages: ProspectMessage[];
  status: ProspectStatus;
  type?: ProspectType;
  statusHistory: ProspectStatusChange[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Ce qu'un écran envoie pour créer ou corriger une fiche. */
export interface ProspectInput {
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
  links?: ProspectLink[];
  images?: ProspectImage[];
  folderId?: string | null;
  infoFields?: ProspectInfoField[];
  messages?: ProspectMessage[];
  status?: ProspectStatus;
  type?: ProspectType;
}

export interface ProspectSummary {
  total: number;
  byStatus: Record<ProspectStatus, number>;
  byType: Record<ProspectType, number>;
}

export interface ProspectListResult {
  prospects: Prospect[];
  summary: ProspectSummary;
}
