// Types de la surface ENTREPRISE (/api/company) — Phase 4.
//
// Remarque de sécurité qui se lit dans les types eux-mêmes : nulle part un
// champ ne porte la VALEUR d'un identifiant d'API. `keys` liste des noms,
// `fingerprints` des empreintes. Le navigateur ne peut pas afficher un secret
// qu'il ne reçoit jamais.

export interface CompanyIdentity {
  name: string;
  legalName: string | null;
  tagline: string | null;
  description: string | null;
}

export interface CompanyBranding {
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
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
  photoUrl: string | null;
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

export interface CompanyState {
  company: Company | null;
  published: { version: number; publishedAt: string; reason: string } | null;
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
