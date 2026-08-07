/**
 * FRAÎCHEUR DES DONNÉES D'UN PROJET — une seule règle, pour tous les écrans.
 *
 * ── LE PRINCIPE ─────────────────────────────────────────────────────────────
 * Quand la connexion est perdue, le Panel peut montrer le dernier état connu,
 * mais jamais le présenter comme l'état actuel.
 *
 * ── CE QUI ARRIVAIT ─────────────────────────────────────────────────────────
 * Une même destination a été redéployée de PROD vers TEST. Le Panel a continué
 * d'afficher l'identité, l'équipe et le contrat de PROD — pastille « Actif »
 * comprise — alors que le contrat avait été résilié dans le nouvel
 * environnement. Rien à l'écran ne distinguait une donnée constatée d'une
 * donnée périmée : chaque carte appliquait sa propre règle, ou aucune.
 *
 * Cette fonction est désormais la seule source. Identité, contrat, équipe,
 * document : tous s'y réfèrent, et aucun ne redécide dans son coin.
 */
import type { PublicProject } from '@/types';

export type ConnectionState = 'ONLINE' | 'STALE' | 'OFFLINE';

export interface ProjectDataFreshness {
  connection: ConnectionState;
  /** Environnement d'où viennent les données affichées (PROD, TEST, inconnu). */
  projectionEnvironment: string | null;
  /** Environnement que le projet déclare AUJOURD'HUI. */
  runtimeEnvironment: string | null;
  /** Les deux ne concordent pas : les données viennent d'un autre monde. */
  isEnvironmentMismatch: boolean;
  /** Le projet a été réappairé ou redéployé : génération différente. */
  isGenerationMismatch: boolean;
  /** VRAI seulement si l'on peut affirmer que les données décrivent l'instant. */
  isBusinessDataFresh: boolean;
  lastContactAt: string | null;
  lastFullSyncAt: string | null;
}

/**
 * Un projet « en ligne » est un projet dont on a des nouvelles RÉCENTES. La
 * vivacité est déjà calculée côté serveur (`liveness`) : on ne la recalcule
 * pas, on la traduit.
 */
function connectionOf(project: PublicProject): ConnectionState {
  switch (project.liveness) {
    case 'ONLINE':
      return 'ONLINE';
    case 'STALE':
      return 'STALE';
    default:
      // NEVER_SEEN, OFFLINE, NOT_PAIRED : dans tous les cas, personne ne
      // répond. Le nuancer à l'écran n'aiderait pas à décider.
      return 'OFFLINE';
  }
}

export function getProjectDataFreshness(project: PublicProject): ProjectDataFreshness {
  const f = project.business?.freshness ?? null;
  const connection = connectionOf(project);

  const projectionEnvironment = f?.projectionEnvironment ?? null;
  const runtimeEnvironment = f?.runtimeEnvironment ?? null;

  /**
   * LES DEUX VERDICTS SONT RENDUS PAR LE BACKEND — l'écran ne les recalcule pas.
   *
   * ── CE QUE CET ÉCRAN A COÛTÉ ──────────────────────────────────────────────
   * Il comparait `projectionGeneration !== runtimeGeneration`, deux chaînes
   * dont il ignorait la structure. Or l'une des cases de cette clé peut valoir
   * « je ne sais pas » : l'écran lisait alors une ignorance comme un désaccord,
   * et déclarait périmée une photographie reçue trois minutes plus tôt.
   *
   * La règle appartient au modèle. Ici, on met en forme.
   */
  const isEnvironmentMismatch = f?.environmentMismatch === true;
  const isGenerationMismatch = f?.generationMismatch === true;

  return {
    connection,
    projectionEnvironment,
    runtimeEnvironment,
    isEnvironmentMismatch,
    isGenerationMismatch,
    // FRAÎCHE veut dire : le projet répond, et ce qu'on affiche vient bien de
    // l'instance qui répond. Les deux, sans quoi c'est de l'histoire.
    isBusinessDataFresh:
      connection === 'ONLINE' && !isEnvironmentMismatch && !isGenerationMismatch,
    lastContactAt: project.runtime?.lastHeartbeatAt ?? null,
    lastFullSyncAt: f?.lastSyncAt ?? null,
  };
}

/**
 * Le préfixe à poser devant une valeur métier quand elle n'est plus certaine.
 * « Actif » devient « Dernier état connu : Actif » — la donnée reste lisible,
 * son statut change.
 */
export function derniereValeurConnue(fraicheur: ProjectDataFreshness): boolean {
  return !fraicheur.isBusinessDataFresh;
}

/** Une action DISTANTE n'a de sens que si le projet répond, ici et maintenant. */
export function actionsDistantesPossibles(fraicheur: ProjectDataFreshness): boolean {
  return fraicheur.connection === 'ONLINE'
    && !fraicheur.isEnvironmentMismatch
    && !fraicheur.isGenerationMismatch;
}

export default getProjectDataFreshness;
