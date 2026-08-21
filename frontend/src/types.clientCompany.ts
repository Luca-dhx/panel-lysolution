/**
 * LES ENTREPRISES CLIENTES — l'identité JURIDIQUE des clients de L.Y Solution.
 *
 * ══ NE JAMAIS CONFONDRE AVEC `types.company.ts` ═════════════════════════════
 *
 *   Company        L.Y SOLUTION elle-même — le VENDEUR. Une seule fiche, celle
 *                  du tenant, diffusée à tout le parc.
 *   ClientCompany  UN CLIENT — l'ACHETEUR. Autant de fiches que de clients, et
 *                  c'est cette identité que porte le « Facturer à » d'une
 *                  facture.
 *
 * Un fichier de types séparé, et non un ajout dans `types.company.ts` : deux
 * notions qui se ressemblent et ne se remplacent jamais doivent se lire à deux
 * endroits différents.
 */

/** Une adresse postale — décomposée, jamais une chaîne libre. */
export interface ClientAddress {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
}

/** La personne physique qui engage l'entreprise cliente. */
export interface ClientContractualSigner {
  firstName: string;
  lastName: string;
  jobTitle: string;
  email: string;
  phone: string;
}

/**
 * LE VERDICT DE COMPLÉTUDE — calculé par le BACKEND, jamais dans l'écran.
 *
 * ══ POURQUOI IL VOYAGE PLUTÔT QU'IL NE SE CALCULE ═══════════════════════════
 *
 * La complétude décide de ce qu'un client peut faire : payer, signer. C'est une
 * règle de FACTURATION, portée par le backend, appliquée à l'ouverture des
 * paiements. La recopier ici produirait une seconde implémentation qui
 * divergerait au premier changement de mention obligatoire — et l'écran dirait
 * « prêt » là où la garde refuse.
 */
export interface ClientCompanyReadiness {
  state: 'READY' | 'MISSING_COMPANY' | 'MISSING_BILLING_IDENTITY' | 'MISSING_SIGNER';
  ready: boolean;
  clientCompanyId: string | null;
  archived: boolean;
  billing: { ready: boolean; missing: string[] };
  signing: { ready: boolean; missing: string[] };
}

/** Un document administratif — le LIEN, jamais les octets, jamais une URL. */
export interface ClientDocument {
  documentId: string;
  label: string;
  type: string | null;
  documentDate: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
}

/** Un projet rattaché — le strict nécessaire pour l'afficher et y naviguer. */
export interface ClientLinkedProject {
  projectId: string;
  projectKey: string;
  projectName: string;
  paired: boolean;
  environment: string | null;
}

export interface ClientCompany {
  clientCompanyId: string;
  legalName: string;
  tradingName: string | null;
  legalForm: string | null;
  siren: string | null;
  siret: string | null;
  vatNumber: string | null;
  registrationCity: string | null;
  registeredOffice: ClientAddress | null;
  billingAddress: ClientAddress | null;
  /** L'adresse RÉELLEMENT utilisée : celle de facturation, ou le siège. */
  billingAddressEffective: ClientAddress | null;
  billingEmail: string | null;
  phone: string | null;
  website: string | null;
  administrativeContact: { name: string | null; email: string | null; phone: string | null } | null;
  contractualSigner: ClientContractualSigner | null;
  status: 'ACTIVE' | 'ARCHIVED';
  /** Note interne de gestion. JAMAIS publiée à un projet, jamais facturée. */
  notes: string | null;
  environment: 'TEST' | 'PROD';
  publishedVersion: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  documents: ClientDocument[];
  readiness: ClientCompanyReadiness;
}

/** Une ligne de la liste — la fiche, plus le compte de projets. */
export interface ClientCompanyRow extends ClientCompany {
  projectCount: number;
}

/** La fiche complète — la liste des projets rattachés en plus. */
export interface ClientCompanyDetail extends ClientCompany {
  projects: ClientLinkedProject[];
}

/**
 * LE SIREN EST-IL DÉJÀ PORTÉ PAR UNE AUTRE FICHE ?
 *
 * Un doublon n'est pas REFUSÉ — une reprise de fiche, une fusion, une
 * correction en deux temps en produisent légitimement. Il est SIGNALÉ, avec le
 * nom de l'autre fiche : c'est exactement l'information qui manquait à
 * l'opérateur pour trancher.
 */
export interface DuplicateSiren {
  clientCompanyId: string;
  legalName: string;
}

/** Ce que rend une écriture de fiche. */
export interface ClientCompanySaveResult {
  clientCompany: ClientCompanyDetail;
  duplicateSiren: DuplicateSiren | null;
}

/** Ce que rend un rattachement — avec l'avertissement sur le contrat en cours. */
export interface ClientCompanyLinkResult {
  linked: boolean;
  unchanged: boolean;
  projectId: string;
  clientCompanyId: string;
  previousClientCompanyId?: string | null;
  /**
   * LE CONTRAT EN COURS, quand il y en a un.
   *
   * Il garde son client Stripe et son identité de facturation : le nouveau
   * rattachement ne vaut que pour les opérations À VENIR. L'écran le DIT plutôt
   * que de laisser le découvrir sur la facture suivante.
   */
  pendingContract?: { sourceContractId: string; reference: string | null; status: string | null } | null;
}
