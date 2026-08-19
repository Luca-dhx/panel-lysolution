// LES COMPTES D'UN PROJET, VUS DU PANEL — une LECTURE, jamais une copie.
//
// ══ CE QUE CE SERVICE REMPLACE ══════════════════════════════════════════════
//
// La fiche projet affichait « Équipe du projet » depuis `PanelProjectMember`,
// une collection du Panel alimentée par le flux de synchronisation. Trois
// défauts, tous conséquences d'une même cause — une deuxième source de vérité :
//
//   · elle VIEILLIT. Entre deux synchronisations, un compte créé, renommé ou
//     supprimé dans le Manager restait invisible ou fantôme, et rien à l'écran
//     ne distinguait « à jour » de « en retard » ;
//   · elle ne montrait QUE LA MOITIÉ. Les accès L.Y Solution — les identités
//     fédérées qui entrent réellement dans ce projet — n'y figuraient pas. Un
//     opérateur qui se demandait « qui peut entrer ici » lisait une réponse
//     incomplète sans le savoir ;
//   · elle avait SA PROPRE FORME. `entityId`, `name`, `role` — là où le
//     Manager parlait de `_id`, `displayName`, `source`. Les mêmes personnes,
//     deux vocabulaires, aucune comparaison possible.
//
// ══ LA DOCTRINE ═════════════════════════════════════════════════════════════
//
//   LE PROJET EST L'AUTORITÉ SUR SES COMPTES. Le Panel les REGARDE.
//
// Le Panel ne possède aucune collection de comptes de projet. Il demande, au
// moment où l'écran s'affiche, et il rend ce que le projet répond — dans la
// représentation que le projet publie, celle-là même que son Manager utilise.
//
// ══ ET QUAND LE PROJET NE RÉPOND PAS ════════════════════════════════════════
//
// On le DIT. On ne ressort pas une vieille projection en la faisant passer
// pour l'état courant : c'est exactement le mensonge que ce service existe
// pour supprimer. Un écran qui annonce « temporairement indisponible » est
// plus utile qu'un écran qui affiche des données périmées sans le signaler.
import ProjectBridgeClient from '../../bridge/ProjectBridgeClient.js';
import logger from '../../utils/logger.js';
import { getOutboundBridgeToken } from '../pairing/pairing.service.js';
import { outboundBaseUrl } from './projectDestination.service.js';

/** Pourquoi la lecture n'a pas pu avoir lieu. Codes fermés, lisibles à l'écran. */
export const ACCOUNTS_UNAVAILABLE = Object.freeze({
  NOT_PAIRED: 'PROJECT_ACCOUNTS_NOT_PAIRED',
  NO_ADDRESS: 'PROJECT_ACCOUNTS_NO_ADDRESS',
  UNREACHABLE: 'PROJECT_ACCOUNTS_UNREACHABLE',
  /** Le projet répond, mais ne connaît pas encore cette lecture de pont. */
  UNSUPPORTED: 'PROJECT_ACCOUNTS_UNSUPPORTED',
});

/**
 * LIT les comptes d'un projet, MAINTENANT.
 *
 * Ne lève jamais : une indisponibilité est un RÉSULTAT que l'écran doit
 * pouvoir peindre, pas une exception qui casse la fiche entière. La fiche
 * projet porte une dizaine d'autres informations, et aucune ne doit
 * disparaître parce que le projet est en train de redémarrer.
 *
 * @returns {Promise<{available: boolean, accounts: object[], summary: object|null,
 *                    readAt: string|null, reason: string|null, message: string|null}>}
 */
export async function readProjectAccounts(record, { fetchImpl } = {}) {
  const indisponible = (reason, message) => ({
    available: false,
    accounts: [],
    summary: null,
    readAt: null,
    reason,
    message,
  });

  if (record?.pairing?.status !== 'PAIRED') {
    return indisponible(
      ACCOUNTS_UNAVAILABLE.NOT_PAIRED,
      'Ce projet n’est pas relié : le Panel ne peut pas lire ses comptes.',
    );
  }

  const baseUrl = outboundBaseUrl(record);
  const bridgeToken = getOutboundBridgeToken(record);
  if (!baseUrl || !bridgeToken) {
    return indisponible(
      ACCOUNTS_UNAVAILABLE.NO_ADDRESS,
      'L’adresse ou le jeton de ce projet est inconnu : lecture impossible.',
    );
  }

  const client = new ProjectBridgeClient({
    baseUrl,
    bridgeToken,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  try {
    const data = await client.getAccounts();
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    return {
      available: true,
      accounts,
      summary: data?.summary ?? null,
      /**
       * L'HEURE VIENT DU PROJET, PAS DE NOUS.
       *
       * C'est lui qui a lu sa base ; c'est donc lui qui sait quand. Dater la
       * réponse au moment où elle nous parvient affirmerait une fraîcheur
       * qu'on n'a pas constatée — d'un millième de seconde ici, de plusieurs
       * secondes derrière un intermédiaire lent.
       */
      readAt: data?.readAt ?? null,
      reason: null,
      message: null,
    };
  } catch (error) {
    /**
     * UN PROJET QUI NE CONNAÎT PAS LA ROUTE N'EST PAS UN PROJET EN PANNE.
     *
     * Le parc n'est pas déployé d'un bloc : une instance antérieure à ce lot
     * répondra 404. C'est une différence de VERSION, et l'écran doit le dire
     * autrement qu'une coupure — l'un se répare par un déploiement, l'autre
     * en attendant.
     */
    const statut = error?.details?.httpStatus ?? error?.status ?? null;
    const inconnue = statut === 404 || /not found|introuvable/i.test(error?.message ?? '');

    logger.info(
      `[projects] lecture des comptes impossible pour ${record.projectId} `
      + `— ${error?.code ?? 'ERREUR'}${statut ? ` (HTTP ${statut})` : ''}.`,
    );

    return indisponible(
      inconnue ? ACCOUNTS_UNAVAILABLE.UNSUPPORTED : ACCOUNTS_UNAVAILABLE.UNREACHABLE,
      inconnue
        ? 'Ce projet ne publie pas encore ses comptes : son connecteur est antérieur à cette lecture.'
        : 'Comptes du projet temporairement indisponibles.',
    );
  }
}

export default { ACCOUNTS_UNAVAILABLE, readProjectAccounts };
