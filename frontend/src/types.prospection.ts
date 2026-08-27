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

export interface Prospect {
  _id: string;
  name: string;
  email: string;
  phone: string;
  notes: string;
  links: ProspectLink[];
  images: ProspectImage[];
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
