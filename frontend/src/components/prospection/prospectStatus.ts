/**
 * LE VOCABULAIRE DES ÉTATS — un seul endroit, pour les cinq.
 *
 * ── POURQUOI UNE TABLE, ET NON UN `switch` PAR ÉCRAN ────────────────────────
 * Le tableau, la fiche, le filtre et l'historique affichent tous le même
 * statut. Recopier « En attente » dans chacun aurait fini par produire quatre
 * libellés légèrement différents — et, plus grave, quatre couleurs
 * différentes, ce qui casse la seule chose qu'une pastille sait faire : se
 * reconnaître sans se lire.
 *
 * ── LES COULEURS SONT DES INTENTIONS, PAS DES TEINTES ───────────────────────
 * Les noms rendus ici (`gray`, `orange`, `blue`, `error`, `success`) sont ceux
 * de la librairie. Ce qu'ils VALENT est décidé dans `styles/bridge.css`, où
 * chaque famille est remixée sur le thème du Panel. Une pastille reste donc
 * lisible que le Panel soit clair ou sombre — et écrire un code hexadécimal
 * ici l'aurait figée sur un seul des deux.
 */
import type { ProspectStatus } from '@/types.prospection';

/** Le nom de couleur attendu par `BadgeWithDot` de la librairie. */
export type ProspectStatusColor = 'gray' | 'orange' | 'blue' | 'error' | 'success';

interface StatusDef {
  label: string;
  color: ProspectStatusColor;
  /** Ce que l'état veut dire — affiché dans la liste déroulante. */
  hint: string;
}

export const PROSPECT_STATUS_DEFS: Record<ProspectStatus, StatusDef> = {
  WAITING: {
    label: 'En attente',
    color: 'gray',
    hint: 'Noté, rien n’a encore été entrepris.',
  },
  IN_PROGRESS: {
    label: 'En cours',
    color: 'orange',
    hint: 'Un échange est engagé.',
  },
  PLANNED: {
    label: 'Planifié',
    color: 'blue',
    hint: 'Un rendez-vous est pris.',
  },
  LOST: {
    label: 'Perdu',
    color: 'error',
    hint: 'L’affaire ne se fera pas.',
  },
  SIGNED: {
    label: 'Signé',
    color: 'success',
    hint: 'L’affaire est gagnée.',
  },
};

export const prospectStatusLabel = (status: ProspectStatus): string =>
  PROSPECT_STATUS_DEFS[status]?.label ?? status;

export const prospectStatusColor = (status: ProspectStatus): ProspectStatusColor =>
  PROSPECT_STATUS_DEFS[status]?.color ?? 'gray';

/**
 * L'ORDRE DU PIPELINE — celui dans lequel une affaire avance.
 *
 * Il gouverne le tri par statut et l'ordre de la liste déroulante. Trier sur
 * l'identifiant technique aurait donné « IN_PROGRESS, LOST, PLANNED, SIGNED,
 * WAITING » : l'ordre alphabétique d'un code que personne ne lit.
 */
export const PROSPECT_STATUS_ORDER: ProspectStatus[] = [
  'WAITING', 'IN_PROGRESS', 'PLANNED', 'SIGNED', 'LOST',
];

export const prospectStatusRank = (status: ProspectStatus): number => {
  const rang = PROSPECT_STATUS_ORDER.indexOf(status);
  return rang === -1 ? PROSPECT_STATUS_ORDER.length : rang;
};
