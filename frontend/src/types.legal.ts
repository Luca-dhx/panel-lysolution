// LES TYPES DES DOCUMENTS LÉGAUX — miroir du contrat servi par `/api`.
//
// Ils décrivent ce que le backend REND, jamais ce que l'écran voudrait. Le
// registre des variables, en particulier, n'est pas recopié ici : il est
// code-first côté serveur et servi par `/api/legal-templates/variables`. Deux
// copies divergeraient à la première variable ajoutée, et l'éditeur proposerait
// une donnée que le validateur refuse.

export type LegalDocumentType = 'LEGAL_NOTICE' | 'PRIVACY_POLICY';
export type LegalTemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type LegalBlockType = 'PARAGRAPH' | 'LIST' | 'FIELDS';
export type LegalVariableSource = 'CLIENT' | 'DEVELOPER' | 'HOST';

export interface LegalVariable {
  key: string;
  label: string;
  description: string;
  source: LegalVariableSource;
  type: string;
  required: boolean;
}

export interface LegalVariableRegistry {
  sources: Record<LegalVariableSource, string>;
  variables: LegalVariable[];
}

/* ── LE CONTENU ÉDITABLE ─────────────────────────────────────────────────── */

export interface LegalFieldItem {
  label: string;
  value: string;
}

/**
 * UN BLOC PORTE LES TROIS FORMES À LA FOIS, et l'éditeur ne peuple que celle
 * de son `type`.
 *
 * Une union discriminée serait plus juste au sens du type. Elle serait pénible
 * à l'usage : changer un paragraphe en liste obligerait à reconstruire l'objet
 * entier, et l'on perdrait le texte déjà saisi au moment précis où l'on veut le
 * garder. Le backend, lui, NORMALISE à l'enregistrement — seuls les champs du
 * type retenu survivent.
 */
export interface LegalBlock {
  blockId: string;
  type: LegalBlockType;
  text: string;
  items: string[];
  fields: LegalFieldItem[];
}

export interface LegalSection {
  sectionId: string;
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalContent {
  title: string;
  sections: LegalSection[];
}

/* ── LE CATALOGUE ────────────────────────────────────────────────────────── */

export interface LegalTemplateSummary {
  legalTemplateId: string;
  name: string;
  type: LegalDocumentType;
  description: string;
  status: LegalTemplateStatus;
  version: number;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
  updatedBy: string | null;
  usageCount: number;
}

export interface LegalTemplateDetail extends LegalTemplateSummary {
  content: LegalContent;
  publishedContent: LegalContent | null;
  variableKeys: string[];
  projects: { projectId: string; projectKey: string; projectName: string }[];
  /** Présent seulement en réponse à une publication. */
  recipients?: number;
}

export interface LegalTemplateVersionRow {
  version: number;
  createdAt: string;
  changedByLabel: string;
  origin: 'SEED' | 'PUBLISH' | 'RESTORE';
  restoredFromVersion: number | null;
}

/* ── LE DOCUMENT RÉSOLU ──────────────────────────────────────────────────── */

/**
 * LE RENDU — il ne contient QUE du texte, et c'est structurel.
 *
 * Aucune balise ne traverse le contrat : la vitrine reçoit exactement cette
 * forme et la rend avec son propre design. L'aperçu du Panel utilise la même,
 * ce qui garantit que ce qu'on relit est ce qui partira.
 */
export type ResolvedBlock =
  | { type: 'PARAGRAPH'; text: string }
  | { type: 'LIST'; items: string[] }
  | { type: 'FIELDS'; items: LegalFieldItem[] };

export interface ResolvedSection {
  heading: string;
  blocks: ResolvedBlock[];
}

export interface ResolvedLegalDocument {
  type: LegalDocumentType;
  templateId: string;
  templateName: string;
  templateVersion: number | null;
  title: string;
  sections: ResolvedSection[];
  updatedAt: string | null;
}

export interface LegalCompletenessField {
  key: string;
  label: string;
  source: LegalVariableSource;
  required: boolean;
  available: boolean;
}

export interface LegalCompleteness {
  total: number;
  available: number;
  missing: LegalCompletenessField[];
  missingRequired: LegalCompletenessField[];
  fields: LegalCompletenessField[];
}

export interface LegalAuthorities {
  client: { id: string; label: string } | null;
  developer: { id: string; label: string | null } | null;
  host: { id: string; label: string } | null;
}

export interface LegalPreview {
  document: ResolvedLegalDocument;
  completeness: LegalCompleteness;
  authorities: LegalAuthorities;
  project: { projectId: string; projectName: string; clientCompanyId: string | null };
}

export interface LegalPreviewTarget {
  projectId: string;
  projectKey: string;
  projectName: string;
  hasClientCompany: boolean;
  assigned: Record<LegalDocumentType, string | null>;
}

/* ── L'AFFECTATION D'UN PROJET ───────────────────────────────────────────── */

/**
 * `blockedReason` explique une page absente — jamais un simple `false`.
 *
 * Un écran ne peut pas expliquer ce qu'on ne lui dit pas, et l'opérateur
 * resterait devant une section vide sans savoir qui la répare.
 */
export type LegalBlockedReason =
  | 'NO_ASSIGNMENT'
  | 'TEMPLATE_MISSING'
  | 'TEMPLATE_DRAFT'
  | 'TEMPLATE_NEVER_PUBLISHED';

export interface ProjectLegalDocument {
  type: LegalDocumentType;
  templateId: string | null;
  template: {
    legalTemplateId: string;
    name: string;
    status: LegalTemplateStatus;
    version: number;
    publishedAt: string | null;
    updatedAt: string;
  } | null;
  served: boolean;
  blockedReason: LegalBlockedReason | null;
  completeness: LegalCompleteness | null;
}

export interface ProjectLegalDocuments {
  projectId: string;
  projectName: string;
  clientCompanyId: string | null;
  authorities: LegalAuthorities;
  documents: Record<LegalDocumentType, ProjectLegalDocument>;
}

/* ── L'HÉBERGEUR ─────────────────────────────────────────────────────────── */

export interface HostCompanyAddress {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  countryCode: string | null;
}

export interface HostCompany {
  hostCompanyId: string;
  legalName: string;
  tradingName: string | null;
  legalForm: string | null;
  registrationNumber: string | null;
  address: HostCompanyAddress;
  email: string | null;
  phone: string | null;
  website: string | null;
  source: string | null;
  verifiedAt: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface HostCompanyScreen {
  hosts: HostCompany[];
  active: HostCompany | null;
  environment: 'TEST' | 'PROD';
}
