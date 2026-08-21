/**
 * LES RÔLES DU PANEL — miroir de `backend/src/services/auth/panelRoles.js`.
 *
 * `SUPER_ADMIN` est le rôle SOUVERAIN : tout ce qu'un DEV peut faire, plus
 * l'administration complète des comptes. Il n'existe QUE dans le Panel — un
 * projet client ne le reçoit jamais, la fédération le projette en `DEV`.
 *
 * L'échelle ne se compare pas à la main : voir `@/auth/roles`.
 */
export type Role = 'ADMIN' | 'DEV' | 'SUPER_ADMIN';

/**
 * L'ACCÈS D'UN COMPTE PANEL AUX PROJETS DU PARC (L12.B-F).
 *
 * `NONE` est le DÉFAUT, y compris pour un DEV : le rôle ne suffit pas, l'accès
 * est un acte daté et attribué. `ALL_PAIRED` est DYNAMIQUE — il couvre les
 * projets appairés d'aujourd'hui et ceux de demain, et n'est jamais figé en
 * liste d'identifiants.
 */
export type ProjectAccessMode = 'NONE' | 'EXPLICIT' | 'ALL_PAIRED';

export interface ProjectAccess {
  mode: ProjectAccessMode;
  /** Lu UNIQUEMENT en mode EXPLICIT. Vide ailleurs. */
  projectIds: string[];
}

export interface PanelUser {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  /**
   * `enabled` et `projectAccess` sont DEUX notions distinctes — un compte peut
   * être parfaitement actif dans le Panel sans aucun accès projet. Les fondre
   * dans un seul interrupteur ferait perdre l'un des deux.
   */
  enabled?: boolean;
  projectAccess?: ProjectAccess;
}

/**
 * SON PROPRE PROFIL (L12.C) — ce que `/api/panel-users/me` rend.
 *
 * `projectAccess.projects` porte les NOMS résolus par le serveur : l'écran ne
 * doit pas avoir besoin de la liste du parc pour afficher « Demo SB Auto »
 * plutôt qu'un UUID — il n'a pas le droit de la lire s'il n'est pas DEV.
 */
export interface OwnProfile extends PanelUser {
  enabled: boolean;
  projectAccess: ProjectAccess & {
    projects?: { projectId: string; projectName: string }[];
  };
}

/** Une ligne de l'écran d'administration des comptes. */
export interface PanelUserRow extends PanelUser {
  enabled: boolean;
  projectAccess: ProjectAccess;
  createdAt?: string;
  passwordChangedAt?: string | null;
  /**
   * LE COMPTE A-T-IL ÉTÉ PRIS EN MAIN ?
   *
   * Dérivé de `passwordChangedAt` par le serveur. Un compte créé par
   * invitation porte un mot de passe que personne ne connaît : tant que son
   * titulaire n'a pas suivi le lien d'activation, il existe sans être
   * accessible. Information d'écran, jamais une garde.
   */
  activated?: boolean;
  grantedAt?: string | null;
  grantedBy?: string | null;
}

/** Ce que rend la création d'un compte — le sort de l'invitation compris. */
export interface PanelUserCreated extends PanelUserRow {
  invitation: { sent: boolean; code: string | null };
}

/** Un projet tel que le SERVEUR le propose à la sélection. */
export interface AccessibleProject {
  projectId: string;
  projectName: string;
  pairingStatus: string | null;
  environment: string | null;
  /** `false` ⇒ non appairé : le serveur refusera de l'accorder. */
  selectable: boolean;
}

export interface PanelVersion {
  name: string;
  softwareVersion: string;
  contractVersion: string;
  environment: string;
}

export type PairingStatus = 'DECLARED' | 'PAIRED' | 'REVOKED';

export type Liveness = 'NOT_PAIRED' | 'NEVER_SEEN' | 'ONLINE' | 'STALE' | 'OFFLINE';

export type HealthStatus = 'OK' | 'DEGRADED';

export interface PublicProject {
  projectId: string;
  /**
   * L’ENTREPRISE CLIENTE À QUI CE PROJET APPARTIENT.
   *
   * ══ PRÉSENTE SUR LA FICHE, ABSENTE DE LA LISTE ══════════════════════
   *
   * Sa résolution coûte une lecture par projet : la joindre à la liste
   * transformerait un affichage de parc en balayage. La fiche, elle, n’en
   * montre qu’un — et c’est là qu’on se demande à qui l’on facture.
   *
   * `undefined` = « la liste ne le dit pas » ; `null` = « aucun client
   * légal rattaché », un ÉTAT qui bloque paiements et signatures.
   */
  clientCompany?: {
    clientCompanyId: string;
    legalName: string;
    tradingName: string | null;
    siren: string | null;
    status: 'ACTIVE' | 'ARCHIVED';
    readiness: {
      state: 'READY' | 'MISSING_COMPANY' | 'MISSING_BILLING_IDENTITY' | 'MISSING_SIGNER';
      ready: boolean;
      billing: { ready: boolean; missing: string[] };
      signing: { ready: boolean; missing: string[] };
    };
  } | null;
  projectKey: string;
  /**
   * L'ENVIRONNEMENT DE CETTE INSTANCE — DÉCLARÉ par le projet, ou `null`.
   *
   * ── `logicalProjectKey` A QUITTÉ CE TYPE ─────────────────────────────────
   * Le backend ne le publie plus. Une fiche du Panel décrit UNE instance
   * appairée ; plus rien à l'écran ne regroupe deux fiches, donc plus rien
   * n'a besoin de savoir qu'elles se ressemblent.
   *
   * ── `null` EST UNE VALEUR NORMALE ────────────────────────────────────────
   * Tant que la fiche n'est pas appairée, l'environnement est INCONNU : ni
   * l'intention saisie, ni le manifeste, ni le nom du domaine n'en tiennent
   * lieu. L'écran doit afficher « non connu », jamais une valeur devinée.
   */
  environment: 'TEST' | 'PROD' | null;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  pairing: {
    status: PairingStatus;
    pairedAt: string | null;
    revokedAt: string | null;
    pairingCodeExpiresAt: string | null;
  };
  runtime: {
    environment: 'TEST' | 'PROD' | null;
    softwareVersion: string | null;
    contractVersion: string | null;
    /**
     * L'ADRESSE PUBLIQUE DE L'API — VIVANTE depuis le contrat de pont 1.9.0.
     *
     * Elle était posée au bootstrap et jamais revue : la fiche annonçait
     * l'adresse du jour de l'appairage, et seul un RÉAPPAIRAGE pouvait la
     * corriger. Elle est désormais rafraîchie par ce que le projet DÉCLARE —
     * battement (>= 1.9.0) ou projection de présentation (>= 1.4.x).
     */
    publicBackendUrl: string | null;
    /** Quand le Panel l'a APPRISE — jamais l'horloge du projet. */
    publicBackendUrlUpdatedAt?: string | null;
    /** `BOOTSTRAP` | `HEARTBEAT` | `PRESENTATION` — jamais deviné. */
    publicBackendUrlSource?: string | null;
    lastHeartbeatAt: string | null;
    /**
     * QUAND LE PANEL A REÇU ET APPLIQUÉ UN ÉTAT MÉTIER — jamais le battement
     * de cœur. `null` se lit « jamais reçu », ce qui n'est pas « ancien ».
     */
    lastBusinessSyncAt: string | null;
    lastHealth: { status: HealthStatus; details: string | null } | null;
    bridgeStats: { outboxSize?: number; lastSyncAt?: string | null } | null;
  };
  liveness: Liveness;
  /** Secondes depuis le dernier contact ; `null` si le projet n'a jamais parlé. */
  secondsSinceLastHeartbeat: number | null;
  /**
   * CARTE DE VISITE du projet — entièrement dérivée de ce qu'il publie, jamais
   * ressaisie côté Panel. C'est la seule source d'un libellé présentable
   * aujourd'hui : le pont ne transporte encore ni logo ni raison sociale.
   */
  descriptor: ProjectDescriptor;
  capabilities: {
    enabled: string[];
    reserved: string[];
    unknown: string[];
    panelModules: string[];
  };
  manifest: unknown | null;
  manifestSource: 'BRIDGE' | 'MANUAL' | null;
  manifestUpdatedAt: string | null;
  /** Ce que le projet déclare avoir APPLIQUÉ. `null` = jamais constaté. */
  appliedConfiguration: AppliedConfiguration | null;
  /**
   * SES ÉCRITURES PASSENT-ELLES ? — le troisième fait, distinct des deux
   * autres, et le seul qui explique une fiche « connectée » dont les données
   * n'ont pas bougé depuis des semaines.
   *
   * `UNKNOWN` n'est PAS `HEALTHY` : un projet antérieur au champ ne le publie
   * pas, et son silence ne prouve rien. L'écran doit faire la différence —
   * déduire la santé d'une absence est l'erreur que toute cette fiche
   * s'applique à ne plus commettre.
   */
  businessSync: BusinessSyncHealth;
  /** Note de supervision saisie côté Panel, jamais transmise au projet. */
  note: string | null;
  /**
   * PROJECTIONS MÉTIER poussées par le projet (Lot 1b). `null` = jamais reçue,
   * ce qui n'est pas « vide » : le Panel ne suppose rien à leur place.
   */
  business: {
    presentation: BusinessPresentation | null;
    contract: BusinessContract | null;
    /**
     * ÉTAT D'ACCESSIBILITÉ DU SITE — projeté par le projet, jamais déduit.
     *
     * `null` se lit « jamais reçu depuis ce projet ». Le Panel ne suppose PAS
     * « accessible » : il ne connaît ni les contrats vivants de l'instance, ni
     * ses suspensions techniques.
     *
     * Ce bloc remplace une lecture directe que la carte faisait sur le projet
     * à chaque affichage — la seule du Panel, et la seule qui rendait une
     * information métier indisponible dès que le projet ne répondait pas.
     */
    siteStatus: BusinessSiteStatus | null;
    /** Présente sur la FICHE seulement — la liste ne l'affiche pas. */
    team?: TeamMember[];
    /** Génération de la source : dit si ces projections sont encore actuelles. */
    freshness?: BusinessFreshness | null;
  };
}

export interface BusinessPresentation {
  companyName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  contacts: { email: string | null; phone: string | null; website: string | null };
  projectName: string | null;
  description: string | null;
  network: { website: string | null; manager: string | null; backend: string | null };
  sourceModifiedAt: string;
  receivedAt: string;
}

/**
 * LA RÉCURRENCE CONTRACTUELLE — « tous les <interval> <unit> ».
 * `3 + MONTH` se lit « tous les trois mois », et le montant de la ligne est ce
 * qui est débité à CHACUN de ces rendez-vous — jamais un prix mensuel.
 */
export interface BusinessRecurrence {
  unit: 'MONTH' | 'YEAR';
  interval: number;
}

export interface BusinessAmount {
  amountIncludingTax: number | null;
  currency: string | null;
  /** La périodicité, quand le projet la publie. `null` = projection antérieure. */
  recurrence?: BusinessRecurrence | null;
  /** Le libellé français publié par le projet. Jamais ce qui fait foi. */
  recurrenceLabel?: string | null;
  /** HÉRITAGE : l'UNITÉ seule (`MONTH`/`YEAR`), sous son ancien nom. */
  interval?: string | null;
}

export interface TeamMember {
  entityId: string;
  name: string | null;
  email: string;
  role: string;
  createdAt: string | null;
  receivedAt: string;
}

export type DocumentStatus =
  | 'NONE' | 'GENERATED' | 'PENDING_SIGNATURE' | 'SIGNED' | 'UNAVAILABLE';

/**
 * D'où viennent les projections affichées, et le projet est-il encore le même.
 * Voir `getProjectDataFreshness` : c'est la seule règle d'interprétation.
 */
export interface BusinessFreshness {
  runtimeEnvironment: string | null;
  runtimeGeneration: string | null;
  projectionEnvironment: string | null;
  projectionGeneration: string | null;
  /**
   * LES VERDICTS, rendus par le backend. Les deux clés de génération restent
   * publiées — elles servent au diagnostic — mais l'écran ne les compare plus
   * lui-même : il ignorait qu'une case peut valoir « je ne sais pas ».
   */
  generationMismatch?: boolean;
  environmentMismatch?: boolean;
  /** Le backend a-t-il pu se prononcer sur la destination active ? */
  destinationKnown?: boolean;
  /** Âge de la photographie la plus récente ENCORE STOCKÉE — recalculé. */
  lastSyncAt: string | null;
  /** La réception OBSERVÉE et persistée — la source canonique. */
  lastBusinessSyncAt?: string | null;
  /** `false` = rien n'a jamais été reçu. Ne jamais afficher « à jour ». */
  businessDataEverReceived?: boolean;
}

export interface BusinessDocument {
  available: boolean;
  /** L'état RÉEL, constaté par le projet en croisant sa base et son stockage. */
  status: DocumentStatus;
  downloadAvailable: boolean;
  filename?: string | null;
  pages?: number;
  sha256?: string | null;
  version?: number;
  /** Le parcours EXIGE-t-il une signature ? `null`/absent = projection ancienne. */
  signatureRequired?: boolean | null;
  signatureStatus?: string | null;
  signedAt?: string | null;
  generatedAt?: string | null;
}

export interface ContractOperation {
  id: string;
  label: string;
  description?: string;
  available: boolean;
  effect?: string;
}

/**
 * CE QUE LA COMMANDE `set_protection` RAPPORTE — un accusé, pas un état.
 *
 * ── CE QU'IL NE FAUT PLUS EN FAIRE ──────────────────────────────────────────
 * L'écran affichait cette réponse. Elle décrit pourtant l'instant d'une
 * commande, n'est persistée nulle part, et un rechargement de page la
 * contredisait. L'état affiché vient désormais de `BusinessSiteStatus` — la
 * projection que le projet réémet après avoir réconcilié.
 *
 * Ce type reste utile pour TYPER la réponse de la commande, et pour le
 * diagnostic. Jamais pour peindre l'interrupteur.
 */
/**
 * L'ÉTAT DU SITE, tel que le projet l'a DÉCLARÉ.
 *
 * `accessible` est le verdict ; `suspensionSource` en donne la cause, et les
 * deux causes possibles restent distinctes : une maintenance TECHNIQUE n'est
 * pas un fait contractuel. `contractProtectionEnabled` est le RÉGLAGE, vrai
 * même lorsqu'il ne produit aucun effet.
 */
export interface BusinessSiteStatus {
  accessible: boolean | null;
  status: string | null;
  suspensionSource: 'NONE' | 'TECHNICAL' | 'CONTRACT' | string;
  reason: string | null;
  suspendedAt: string | null;
  contractProtectionEnabled: boolean | null;
  technicalSuspension: boolean | null;
  /** Quand le PROJET a produit cette photographie. */
  modifiedAt: string | null;
  /** Quand le PANEL l'a reçue — ce qu'une lecture directe ne savait pas dire. */
  receivedAt: string | null;
}

export interface ContractProtection {
  enabled: boolean;
  siteStatus: string;
  suspensionSource: string;
  /** Le site est-il suspendu POUR CETTE CAUSE ? (calculé par le projet.) */
  suspendedByProtection: boolean;
}

export interface ContractAction {
  operationId: string;
  outcome: 'REQUESTED' | 'SUCCEEDED' | 'FAILED';
  requestedAt: string;
  reason: string | null;
  actor: { email: string | null; role: string | null };
  contract: { previousStatus: string | null; newStatus: string | null; endsAt: string | null };
  errorMessage: string | null;
}

/** Un contrat TERMINÉ — consultable, jamais présenté comme celui du moment. */
export interface PreviousContract {
  sourceContractId: string;
  status: string;
  reference: string | null;
  createdAt: string | null;
  activatedAt: string | null;
  endedAt: string | null;
  cancellationReason: string | null;
  document?: BusinessDocument | null;
  pricing: { subscription: BusinessAmount | null; launchFee: BusinessAmount | null };
}

export interface BusinessContract {
  document?: BusinessDocument | null;
  /**
   * Y a-t-il un contrat ACTUEL ? Faux = le projet n'a plus d'engagement en
   * cours ; les champs ci-dessous sont alors vides, et seul l'historique parle.
   */
  hasCurrent?: boolean;
  sourceContractId: string | null;
  status: string | null;
  reference: string | null;
  createdAt: string | null;
  activatedAt: string | null;
  pricing: { subscription: BusinessAmount | null; launchFee: BusinessAmount | null };
  previousContracts?: PreviousContract[];
  sourceModifiedAt: string;
  receivedAt: string;
}

/** Descripteur publié par le projet (voir `describeProject` côté Panel). */
export interface ProjectPresentation {
  companyName?: string;
  tagline?: string;
  logoUrl?: string;
  faviconUrl?: string;
  contacts?: { email?: string; phone?: string; website?: string };
}

export interface ProjectDescriptor {
  slug: string;
  name: string;
  /** Identité commerciale publiée par le projet (contrat >= 1.4.x). */
  presentation: ProjectPresentation | null;
  /** D'où sort ce qui est affiché : flux vivant, manifeste d'appairage, registre. */
  presentationSource?: 'PROJECTION' | 'MANIFEST' | 'REGISTRY';
  /** Quand le PROJET déclare avoir modifié — sa parole, pas notre réception. */
  presentationModifiedAt?: string | null;
  descriptorSource?: 'PROJECTION' | 'MANIFEST' | 'NONE';
  type: string | null;
  description: string | null;
  layout: string | null;
  environment: 'TEST' | 'PROD' | null;
  /** Hôte de la destination ACTIVE — `null` si aucune n'est connue. */
  primaryDomain: string | null;
  /**
   * D'OÙ vient l'adresse. `DESTINATION_ACTIVE` quand elle est résolue ; sinon
   * une raison lisible (`AUCUNE_DESTINATION_ACTIVE`, `ENVIRONNEMENT_INCONNU`).
   * L'écran peut ainsi dire « inconnu » plutôt que de laisser un tiret muet.
   */
  networkSource?: string;
  destinationId?: string | null;
  urls: Record<string, string> | null;
  versions: {
    software: string | null;
    contract: string | null;
    manifestFormat: string | null;
    deploymentEngine: string | null;
    duplicationEngine: string | null;
  };
  dates: {
    createdAt: string;
    pairedAt: string | null;
    lastHeartbeatAt: string | null;
    lastBusinessSyncAt: string | null;
    lastActivityAt: string;
    manifestUpdatedAt: string | null;
  };
}

/**
 * SANTÉ DE LA LIVRAISON MÉTIER — déclarée par l'instance, jamais déduite.
 *
 * `HEALTHY` : elle publie « aucune écriture refusée ».
 * `BLOCKED` : elle en déclare au moins une, et dit laquelle.
 * `UNKNOWN` : elle ne sait pas le dire — un projet antérieur au champ. Ce
 *             n'est pas une bonne nouvelle, seulement une absence de nouvelle.
 */
export interface BusinessSyncHealth {
  status: 'HEALTHY' | 'BLOCKED' | 'UNKNOWN';
  rejectedCount: number | null;
  blocked: {
    entityType: string | null;
    /** TRANSIENT · COMPATIBILITY · SECURITY · BUSINESS · IDEMPOTENT */
    failureClass: string | null;
    code: string | null;
    since: string | null;
    rejections: number | null;
  } | null;
}

export interface AppliedConfiguration {
  companyId: string | null;
  companySlug: string | null;
  companyVersion: number | null;
  companyAppliedAt: string | null;
  integratedApiCount: number;
  integratedApiKeys: string[];
  lastSyncAt: string | null;
  observedAt: string;
}

/**
 * DESTINATION D'UN PROJET — ce que le Panel sait de l'endroit où il vit.
 *
 * ══ LE PANEL NE DÉPLOIE JAMAIS ══════════════════════════════════════════════
 *
 * Il ENREGISTRE ce que le projet annonce depuis son propre poste, et arbitre
 * les états. Il n'y a donc AUCUNE action « déployer », « redéployer » ni
 * « migrer » — et il ne faut jamais en ajouter. Les deux seules actions
 * humaines sont de constater qu'une destination retirée est vide, puis de
 * supprimer sa fiche.
 *
 *   ACTIVE ──► RETIRED ──► EMPTY ──► DELETED
 *
 * `PENDING` : une migration annoncée dont la photographie n'est pas complète.
 * Elle n'est jamais lue par les vues — basculer avant d'avoir tout reçu
 * afficherait un projet à moitié décrit.
 */
export type ProjectDestinationStatus =
  | 'PENDING' | 'ACTIVE' | 'RETIRED' | 'EMPTY' | 'DELETED';

export interface ProjectDestination {
  destinationId: string;
  projectId: string;
  environment: 'TEST' | 'PROD';
  /** Hôte canonique, préfixe d'API retiré. */
  host: string;
  urls: { website: string | null; manager: string | null; backend: string | null };
  status: ProjectDestinationStatus;
  generation: string | null;
  /** Par quel canal le projet l'a annoncée. */
  announcedBy: 'BOOTSTRAP' | 'PRESENTATION' | 'MANIFEST' | 'REPAIR' | null;
  /** Ce qui manque à la photographie réseau pour être complète. */
  missing: string[];
  announcedAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  emptiedAt: string | null;
  deletedAt: string | null;
  lastSeenAt: string | null;
  previousDestinationId: string | null;
  /** Ce que l'écran a le droit de proposer — décidé par le backend. */
  canMarkEmpty: boolean;
  canDelete: boolean;
}

/** Une entrée par environnement : chacun a SA destination active. */
export interface ProjectDestinationsByEnvironment {
  TEST: { active: ProjectDestination | null; pending: ProjectDestination | null; history: ProjectDestination[] };
  PROD: { active: ProjectDestination | null; pending: ProjectDestination | null; history: ProjectDestination[] };
}
/**
 * UN COMPTE D'UN PROJET — la représentation CANONIQUE, publiée par le projet.
 *
 * ══ POURQUOI CE TYPE EST ICI ET NON DÉRIVÉ D'UNE PROJECTION DU PANEL ════════
 *
 * Parce que le Panel ne possède pas cette donnée. Elle est lue en direct chez
 * le projet, dans la forme que son propre Manager utilise
 * (`services/accounts/projectAccountView.js` côté projet). Toute divergence
 * entre les deux est un défaut, et une suite la fait tomber.
 *
 * `role` est un rôle DE PROJET. Un `SUPER_ADMIN` du Panel apparaît ici en
 * `DEV`, source `PANEL` : la hiérarchie du Panel ne franchit pas la frontière.
 */
export interface ProjectAccountView {
  id: string;
  displayName: string;
  email: string;
  role: string;
  source: 'LOCAL' | 'PANEL';
  principalType: 'LOCAL_USER' | 'PANEL_USER';
  enabled: boolean;
  /**
   * `PENDING_ACTIVATION` n'est pas `DISABLED` : un accès JAMAIS OUVERT n'est pas
   * un accès RETIRÉ. Le premier se répare par un lien d'activation, le second
   * par un interrupteur — les confondre fait chercher au mauvais endroit.
   */
  status: 'ACTIVE' | 'DISABLED' | 'PENDING_ACTIVATION';
  /** Renseigné pour une identité fédérée seulement : fraîcheur de ce qu'on sait. */
  lastSyncedAt: string | null;
  createdAt: string | null;
}

/** Ce que rend la lecture vivante des comptes d'un projet. */
export interface ProjectAccountsRead {
  available: boolean;
  accounts: ProjectAccountView[];
  summary: { total: number; local: number; panel: number; disabled: number } | null;
  /** L'heure de lecture, posée par le PROJET. Jamais calculée par le Panel. */
  readAt: string | null;
  reason: string | null;
  message: string | null;
}
