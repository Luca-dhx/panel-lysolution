// Types de la surface ENTREPRISE (/api/company) — Phase 4.
//
// Remarque de sécurité qui se lit dans les types eux-mêmes : nulle part un
// champ ne porte la VALEUR d'un identifiant d'API. `keys` liste des noms,
// `fingerprints` des empreintes. Le navigateur ne peut pas afficher un secret
// qu'il ne reçoit jamais.

/**
 * DESCRIPTEUR MÉDIA CANONIQUE — ce que le Panel publie à côté d'une URL.
 *
 * Une URL seule ne dit ni si l'image a changé (aucune empreinte), ni son type
 * réel, ni ses dimensions — donc ni comment réserver la place à l'écran, ni
 * comment distinguer un remplacement d'un simple rechargement.
 *
 * Il est rendu par l'import, et republié aux projets à chaque publication.
 */
export interface MediaDescriptor {
  mediaId: string | null;
  /** Absolue et canonique — jamais localhost, jamais un chemin disque. */
  url: string;
  mime: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  /** Empreinte du CONTENU : ce qui distingue « même image » d'« autre ». */
  sha256: string | null;
  /** Monotone — un projet refuse une projection plus ancienne. */
  version: number | null;
  updatedAt: string | null;
  role: string | null;
  /** Vrai pour une URL externe dont le Panel n'a aucune métadonnée. */
  external?: boolean;
}

export interface CompanyIdentity {
  name: string;
  legalName: string | null;
  tagline: string | null;
  description: string | null;
}

/**
 * DESCRIPTEUR STABLE D'UN MÉDIA — ce qu'une fiche conserve d'une image.
 *
 * Aucune adresse : l'identité d'un média est sa clé d'objet et son empreinte.
 * L'URL en est DÉRIVÉE à la lecture, contre la destination active du moment.
 *
 * C'est ce qui permet de configurer un Panel de recette AVANT son premier
 * déploiement : il n'a alors aucune adresse publique, et il n'en a pas besoin.
 */
export interface StoredMediaDescriptor {
  mediaId?: string | null;
  objectKey: string;
  /** TEST ou PROD — un média ne franchit jamais cette frontière. */
  environment?: 'TEST' | 'PROD' | null;
  sha256?: string | null;
  mime?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  version?: number | null;
}

/**
 * Deux médias de marque : le logo et le favicon.
 *
 * Le « logo sombre » a été retiré du produit — plus d'écran, plus de
 * validation, plus de publication. Le type ne le déclare donc plus : le
 * conserver ici laisserait croire qu'un écran peut encore le poser.
 */
export interface CompanyBranding {
  /** Chemin de stockage (`/uploads/…`) — repli historique, plus l'autorité. */
  logoUrl: string | null;
  faviconUrl: string | null;
  /** LA SOURCE DE VÉRITÉ du média. */
  logo?: StoredMediaDescriptor | null;
  favicon?: StoredMediaDescriptor | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  fontFamily: string | null;
}

export interface CompanyDomains {
  primaryDomain: string | null;
  websiteUrl: string | null;
  wildcardBases: string[];
}

export interface CompanyContacts {
  email: string | null;
  phone: string | null;
  supportEmail: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
  };
}

export interface CompanyLegal {
  legalForm: string | null;
  siret: string | null;
  vatNumber: string | null;
  rcs: string | null;
  shareCapital: string | null;
  legalRepresentative: string | null;
  hostingProvider: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
}

export interface CompanySettings {
  locale: string;
  timezone: string;
  currency: string;
}

export interface CompanySigner {
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
}

export interface CompanyReference {
  type: 'TEXT' | 'LINK';
  icon: string | null;
  name: string | null;
  value: string | null;
  order: number;
}

/**
 * UN MEMBRE DE L’ÉQUIPE — affiché sur la page Support des projets.
 *
 * Prénom et nom sont SÉPARÉS : une page affiche « Prénom NOM », un message
 * s’adresse au prénom. Les recoller est trivial, les séparer ne l’est pas.
 *
 * `active` retire quelqu’un de l’affichage sans effacer son passage : un
 * départ n’est pas une erreur de saisie.
 */
export interface CompanyTeamMember {
  firstName: string | null;
  lastName: string | null;
  /** La fonction montrée au client, pas un rôle technique. */
  role: string | null;
  email: string | null;
  phone: string | null;
  /** Chemin de stockage — repli historique, plus l'autorité. */
  photoUrl: string | null;
  /** LA SOURCE DE VÉRITÉ du portrait. */
  photo?: StoredMediaDescriptor | null;
  active: boolean;
  /** Canaux propres à la personne : ligne directe, profil, agenda. */
  references: CompanyReference[];
  order: number;
}

export interface Company {
  companyId: string;
  slug: string;
  environment: 'TEST' | 'PROD';
  identity: CompanyIdentity;
  /** Personne physique qui engage l'entreprise. `null` tant qu'elle n'est pas renseignée. */
  signer: CompanySigner | null;
  /** Liens et informations affichés par les projets. */
  references: CompanyReference[];
  /** L’équipe visible par les clients. */
  team: CompanyTeamMember[];
  branding: CompanyBranding;
  domains: CompanyDomains;
  contacts: CompanyContacts;
  legal: CompanyLegal;
  settings: CompanySettings;
  active: boolean;
  publishedVersion: number | null;
  publishedAt: string | null;
  /** Le brouillon a changé depuis la dernière publication. */
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * ADRESSE D'AFFICHAGE D'UN MÉDIA — calculée par le serveur à chaque lecture.
 *
 * Elle n'est jamais renvoyée en enregistrant : ce que la fiche conserve, c'est
 * le descripteur. Une adresse écrite en base redeviendrait fausse au premier
 * changement de domaine.
 */
export interface ResolvedMedia {
  url: string | null;
  /** Servi par une destination active — donc visible hors de ce Panel. */
  published: boolean;
  reason: string;
}

/** Indexé par le chemin du descripteur : `branding.logo`, `team.0.photo`. */
export type MediaResolution = Record<string, ResolvedMedia>;

/** L'application de la configuration, INSTANCE par instance. */
export interface CompanyDistributionInstance {
  projectId: string;
  projectName: string;
  environment: 'TEST' | 'PROD' | null;
  paired: boolean;
  expectedVersion: number | null;
  appliedVersion: number | null;
  appliedAt: string | null;
  state: 'NOT_PAIRED' | 'UNKNOWN' | 'PENDING' | 'OFFLINE' | 'APPLIED';
}

export interface CompanyDistribution {
  expectedVersion: number | null;
  global: 'NEVER_PUBLISHED' | 'NO_CONNECTED_PROJECT' | 'UP_TO_DATE' | 'PARTIAL' | 'NOT_DISTRIBUTED';
  instances: CompanyDistributionInstance[];
  pendingProjectIds: string[];
}

export interface CompanyState {
  company: Company | null;
  media?: MediaResolution;
  published: { version: number; publishedAt: string; reason: string } | null;
  /** L'application de la configuration, instance par instance. */
  distribution?: CompanyDistribution;
}

export interface VersionRow {
  version: number;
  reason: string;
  publishedAt: string;
  publishedBy: string | null;
  changeCount: number;
  current: boolean;
}

export interface VersionDetail {
  companyId: string;
  version: number;
  payload: Record<string, unknown>;
  reason: string;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
  publishedAt: string;
  publishedByEmail: string | null;
}

/**
 * CE QUE REND UN ENREGISTREMENT — qui publie du même geste.
 *
 * `published` distingue « une version a été diffusée » de « rien n'avait
 * changé ». Le second cas est un succès : enregistrer deux fois de suite est
 * un geste anodin, pas une faute à signaler.
 */
export interface SaveResult {
  company: Company;
  media?: MediaResolution;
  published: boolean;
  version: number | null;
  changes: { path: string; from: unknown; to: unknown }[];
  recipients: number;
}

export interface PublishResult {
  version: number;
  publishedAt: string;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
  recipients: number;
}

/** Vue d'une API intégrée — sans aucune valeur d'identifiant. */
export interface IntegratedApi {
  apiId: string;
  companyId: string;
  key: string;
  label: string;
  provider: string;
  description: string | null;
  category: string;
  mode: 'TEST' | 'PROD';
  enabled: boolean;
  settings: Record<string, unknown>;
  credentials: Record<'TEST' | 'PROD', {
    configured: boolean;
    /** NOMS des clés renseignées — jamais leurs valeurs. */
    keys: string[];
    /** Empreintes courtes : constater un changement sans lire le secret. */
    fingerprints: Record<string, string>;
    updatedAt: string | null;
  }>;
  grants: Array<{
    projectId: string;
    projectName: string | null;
    keys: string[];
    grantedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Ce qu'un projet a réellement appliqué — relevé, jamais déduit. */
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

/** Résultat d'une sonde d'URL, avant appairage. */
export interface ProbeResult {
  url: string;
  reachable: boolean;
  isProjectBridge: boolean;
  contractVersion: string | null;
  compatible: boolean;
  alreadyPaired: boolean | null;
  /** Identité annoncée par le projet sur son ping public (contrat >= 1.4.0). */
  bridgeIdentity: { projectKey: string | null; projectName: string | null } | null;
  panelContractVersion?: string;
  reason: string;
  checkedAt: string;
}
