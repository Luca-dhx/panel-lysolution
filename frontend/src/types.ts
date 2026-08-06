export type Role = 'ADMIN' | 'DEV';

export interface PanelUser {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
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
  projectKey: string;
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
    publicBackendUrl: string | null;
    lastHeartbeatAt: string | null;
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
  /** Note de supervision saisie côté Panel, jamais transmise au projet. */
  note: string | null;
  /**
   * PROJECTIONS MÉTIER poussées par le projet (Lot 1b). `null` = jamais reçue,
   * ce qui n'est pas « vide » : le Panel ne suppose rien à leur place.
   */
  business: {
    presentation: BusinessPresentation | null;
    contract: BusinessContract | null;
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

export interface BusinessAmount {
  amountIncludingTax: number | null;
  currency: string | null;
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
  lastSyncAt: string | null;
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
    lastActivityAt: string;
    manifestUpdatedAt: string | null;
  };
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