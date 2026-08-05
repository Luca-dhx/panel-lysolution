import type { ProjectDataFreshness } from '@/lib/projectFreshness';
import type { BusinessContract, BusinessDocument } from '@/types';

/**
 * DOCUMENT CONTRACTUEL — ce qu'on en dit, et ce qu'on permet d'en faire.
 *
 * ── LE DÉFAUT QUI A CRÉÉ CE MODULE ──────────────────────────────────────────
 * La carte contrat décidait dans son JSX :
 *
 *     downloadAvailable && joignable ? <bouton/>
 *       : document.available        ? « le lien avec le projet est rompu »
 *       :                             « aucun document »
 *
 * Le repli accusait la CONNEXION dès que le téléchargement n'était pas
 * possible. Sur un projet en ligne, dernier contact à l'instant, dont le
 * fichier manquait sur le stockage, l'écran affirmait donc simultanément
 * « connecté » et « lien rompu ». Deux axes indépendants avaient été fondus en
 * un seul test.
 *
 * ── LES QUATRE AXES, ET ILS NE SE DÉDUISENT PAS L'UN DE L'AUTRE ─────────────
 *   · la CONNECTIVITÉ du projet          → `freshness.connection`
 *   · la FRAÎCHEUR de la projection      → environnement et génération
 *   · l'état MÉTIER du contrat           → `contract.status`
 *   · l'état DOCUMENTAIRE                → `document.status`, publié par le projet
 *
 * Un document indisponible ne dit rien du réseau. Un projet en ligne ne prouve
 * pas qu'un fichier existe. Un contrat en cours d'activation n'interdit pas
 * qu'un document soit signé. Ce module lit les quatre séparément, et n'écrit
 * un message de connexion que lorsque la connexion est effectivement en cause.
 *
 * Module PUR (aucun React) : testable directement sous Node.
 */

export type DocumentPresentationState =
  /** Le projet n'a jamais publié de document. */
  | 'NONE'
  /** Téléchargeable, ici et maintenant. */
  | 'DOWNLOADABLE'
  /** Le document existe mais n'est pas encore publiable (workflow en cours). */
  | 'NOT_YET_AVAILABLE'
  /** Signature en cours chez le projet. */
  | 'PENDING_SIGNATURE'
  /** Référencé en base, absent du stockage : le projet le dit lui-même. */
  | 'FILE_MISSING'
  /** Dernier état connu — le projet ne répond pas. */
  | 'LAST_KNOWN_OFFLINE'
  /** Dernier état connu — les données viennent d'un autre monde. */
  | 'LAST_KNOWN_PREVIOUS_GENERATION';

export type BadgeTone = 'ok' | 'warn' | 'neutral';

/**
 * DISPONIBILITÉ — « Disponible » ou « Non disponible », et rien d'autre.
 *
 * Le document contractuel est IMPORTÉ dans le projet, pas fabriqué par lui :
 * « Généré » / « Non généré » décrivait une production qui n'a jamais eu lieu
 * et laissait croire à une étape de fabrication en attente. Ce qui compte pour
 * qui lit la fiche, c'est de savoir s'il peut obtenir le fichier.
 */
export type DocumentAvailability = 'AVAILABLE' | 'UNAVAILABLE';

/** État de signature — indépendant de la disponibilité du fichier. */
export type DocumentSignature = 'NOT_REQUIRED' | 'PENDING' | 'SIGNED';

export interface ContractDocumentPresentation {
  state: DocumentPresentationState;
  /** Libellé court de l'état documentaire — la pastille. */
  title: string;
  /** Le fichier est-il obtenable ? Axe DOCUMENTAIRE, sans la connexion. */
  availability: DocumentAvailability;
  availabilityLabel: string;
  /**
   * Où en est la signature — `null` quand il n'y a pas de document, ou quand
   * la projection est trop ancienne pour le dire.
   */
  signature: DocumentSignature | null;
  signatureLabel: string | null;
  /** Nom du fichier publié par le projet, s'il en porte un. */
  filename: string | null;
  /** Nombre de pages, si le projet le connaît. */
  pages: number | null;
  /** Phrase affichée sous la fiche. Vide quand il n'y a rien à ajouter. */
  message: string;
  badgeTone: BadgeTone;
  showDownload: boolean;
  /** Pourquoi le téléchargement n'est pas proposé — `null` s'il l'est. */
  downloadDisabledReason: string | null;
  /** Les actions distantes (résiliation…) ont-elles un sens ? */
  showRemoteActions: boolean;
  /** Ce qu'on affiche décrit le passé, pas l'instant. */
  isHistorical: boolean;
}

export interface DocumentPresentationInput {
  document: BusinessDocument | null | undefined;
  contract: Pick<BusinessContract, 'status'> | null | undefined;
  freshness: ProjectDataFreshness;
  /** Le projet est-il RELIÉ ? (appairage — distinct de « répond-il ? »). */
  paired: boolean;
}

/**
 * L'ORDRE DE DÉCISION, et pourquoi il est celui-là.
 *
 * On tranche d'abord ce qui rend TOUT le reste incertain : une projection
 * venue d'un autre environnement ou d'une autre génération ne décrit pas ce
 * projet-ci, et un projet muet ne permet plus d'affirmer quoi que ce soit au
 * présent. Vient ensuite l'état documentaire lui-même, qui est le seul à
 * pouvoir dire ce qu'il en est du fichier.
 *
 * Ce qu'on ne fait JAMAIS : conclure d'un axe sur un autre.
 */
/** Le fichier est-il réellement obtenable, d'après ce que le projet publie ? */
function estDisponible(doc: BusinessDocument | null): boolean {
  if (!doc || doc.status === 'NONE' || doc.status === 'UNAVAILABLE') return false;
  return doc.downloadAvailable === true;
}

/**
 * Où en est la signature — lu sur le document, JAMAIS sur le contrat.
 *
 * Un contrat en cours d'activation peut porter un document déjà signé, et un
 * contrat actif un document qui n'exigeait aucune signature.
 */
function signatureDe(doc: BusinessDocument | null): DocumentSignature | null {
  if (!doc || doc.status === 'NONE') return null;
  if (doc.signatureRequired === false || doc.signatureStatus === 'NOT_REQUIRED') return 'NOT_REQUIRED';
  if (doc.status === 'SIGNED') return 'SIGNED';
  return 'PENDING';
}

const SIGNATURE_LABEL: Record<DocumentSignature, string> = {
  NOT_REQUIRED: 'Signature non requise',
  PENDING: 'En attente de signature',
  SIGNED: 'Signé',
};

export function getContractDocumentPresentation(
  { document, freshness, paired }: DocumentPresentationInput,
): ContractDocumentPresentation {
  /*
    `contract` fait partie de l'entrée et n'est DÉLIBÉRÉMENT pas lu ici.
    L'état du contrat — brouillon, en cours d'activation, terminé — ne dit rien
    de l'existence ni de la disponibilité d'un fichier. Le champ reste dans la
    signature parce que l'appelant l'a sous la main et qu'un lecteur pourrait
    croire l'oubli involontaire : il est ici, et il ne sert pas. Un test
    vérifie que faire varier le statut du contrat ne change aucune sortie.
  */
  const doc = document ?? null;
  const statut = doc?.status ?? 'NONE';
  const connecte = paired && freshness.connection === 'ONLINE';
  const monde = freshness.isEnvironmentMismatch || freshness.isGenerationMismatch;
  const actionsPossibles = connecte && !monde;

  // Les faits documentaires, calculés UNE fois : ils ne dépendent ni du réseau,
  // ni de la fraîcheur, ni du contrat. Ils accompagnent chaque réponse.
  const signature = signatureDe(doc);
  const disponible = estDisponible(doc);
  const disponibleOuReference = Boolean(doc) && statut !== 'NONE';
  const faits = {
    availability: (disponible ? 'AVAILABLE' : 'UNAVAILABLE') as DocumentAvailability,
    availabilityLabel: disponible ? 'Disponible' : 'Non disponible',
    signature,
    signatureLabel: signature ? SIGNATURE_LABEL[signature] : null,
    // Un document absent n'a ni nom ni pages : les exposer ferait croire
    // qu'un fichier attend quelque part.
    filename: disponibleOuReference ? doc?.filename ?? null : null,
    pages: disponibleOuReference && doc?.pages && doc.pages > 0 ? doc.pages : null,
  };

  // Aucun document : rien d'autre à dire, quel que soit l'état du réseau.
  // C'est un fait publié par le projet, pas une conséquence de la connexion.
  if (statut === 'NONE' || !doc) {
    return {
      ...faits,
      state: 'NONE',
      title: 'Non disponible',
      message: 'Le projet n’a publié aucun document contractuel.',
      badgeTone: 'neutral',
      showDownload: false,
      downloadDisabledReason: null, // rien à télécharger : ce n'est pas un empêchement
      showRemoteActions: actionsPossibles,
      isHistorical: !freshness.isBusinessDataFresh,
    };
  }

  // Données d'un autre monde : on ne présente plus que de l'histoire.
  if (monde) {
    return {
      ...faits,
      state: 'LAST_KNOWN_PREVIOUS_GENERATION',
      title: `Dernier état connu : ${faits.availabilityLabel}`,
      message: freshness.isEnvironmentMismatch
        ? 'Données de l’environnement précédent : le projet en déclare un autre aujourd’hui.'
        : 'Données de la génération précédente : le projet a été redéployé ou réappairé depuis.',
      badgeTone: 'neutral',
      showDownload: false,
      downloadDisabledReason:
        'Ce document appartient à une génération précédente du projet.',
      showRemoteActions: false,
      isHistorical: true,
    };
  }

  // Le projet ne répond pas : le dernier état documentaire reste lisible, mais
  // il est daté. C'est le SEUL cas où l'on parle de projet injoignable.
  if (!connecte) {
    return {
      ...faits,
      state: 'LAST_KNOWN_OFFLINE',
      title: `Dernier état connu : ${faits.availabilityLabel}`,
      message: paired
        ? 'Le projet est momentanément injoignable : le document sera de nouveau téléchargeable dès son retour.'
        : 'Le projet n’est pas relié : le document n’est pas accessible depuis le Panel.',
      badgeTone: 'warn',
      showDownload: false,
      downloadDisabledReason: 'Le projet est momentanément injoignable.',
      showRemoteActions: false,
      isHistorical: true,
    };
  }

  /* À partir d'ici : projet relié, qui répond, données du bon monde. Tout ce
     qui suit ne parle QUE du document. */

  // Référencé en base, absent du stockage — le projet l'a constaté lui-même en
  // croisant sa base et son disque. Ce n'est ni un problème de réseau, ni un
  // document manquant : c'est un fichier manquant, et il faut le dire ainsi.
  if (statut === 'UNAVAILABLE') {
    return {
      ...faits,
      state: 'FILE_MISSING',
      title: 'Non disponible',
      /*
        On ne dit pas « le document SIGNÉ » : quand le fichier manque, le
        projet publie `UNAVAILABLE` sans préciser quelle variante était
        référencée. Qualifier le document reviendrait à inventer ce que la
        source ne dit pas.
      */
      message: 'Le document contractuel est référencé, mais le fichier est actuellement indisponible sur le projet.',
      badgeTone: 'warn',
      showDownload: false,
      downloadDisabledReason: 'Le fichier est introuvable sur le stockage du projet.',
      showRemoteActions: true,
      isHistorical: false,
    };
  }

  if (doc.downloadAvailable) {
    return {
      ...faits,
      state: 'DOWNLOADABLE',
      title: 'Disponible',
      message: '',
      badgeTone: 'ok',
      showDownload: true,
      downloadDisabledReason: null,
      showRemoteActions: true,
      isHistorical: false,
    };
  }

  // Le document existe, le projet répond, mais il n'est pas encore publiable.
  // La raison est documentaire, jamais réseau.
  /*
    `signatureRequired === false` l'emporte sur un statut de signature.
    SB Auto n'émet pas cette combinaison — `PENDING_SIGNATURE` suppose une
    signature requise. Mais si une projection ancienne ou incohérente en
    produisait une, annoncer « en attente de signature » sur un parcours qui
    n'en demande aucune ferait chercher une procédure inexistante.
  */
  if (statut === 'PENDING_SIGNATURE' && doc.signatureRequired !== false) {
    return {
      ...faits,
      state: 'PENDING_SIGNATURE',
      title: 'Non disponible',
      message: 'Le document est en cours de signature : il sera téléchargeable une fois la procédure terminée.',
      badgeTone: 'warn',
      showDownload: false,
      downloadDisabledReason: 'La procédure de signature est en cours.',
      showRemoteActions: true,
      isHistorical: false,
    };
  }

  return {
    ...faits,
    state: 'NOT_YET_AVAILABLE',
    title: 'Non disponible',
    message: 'Le document contractuel n’est pas encore disponible au téléchargement.',
    badgeTone: 'warn',
    showDownload: false,
    downloadDisabledReason: 'Le projet ne propose pas encore ce document au téléchargement.',
    showRemoteActions: true,
    isHistorical: false,
  };
}

export default getContractDocumentPresentation;
