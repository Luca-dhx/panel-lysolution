export type EmailTemplateVariableType =
  | 'TEXT'
  | 'EMAIL'
  | 'PHONE'
  | 'DATE'
  | 'DATETIME'
  | 'MONEY'
  | 'URL'
  | 'BOOLEAN'
  | 'SAFE_HTML';

export interface EmailTemplateVariable {
  key: string;
  label: string;
  description: string;
  type: EmailTemplateVariableType;
  required: boolean;
}

export interface EmailTemplateValidationError {
  code: string;
  message: string;
  line?: number;
  variable?: string;
}

export interface EmailTemplateValidation {
  valid: boolean;
  errors: EmailTemplateValidationError[];
}

/**
 * LA PORTÉE — qui possède ce contenu (L11.1).
 *
 * `PANEL` : le contenu de L.Y Solution, unique pour le parc.
 * `PROJECT` : le contenu d'UN projet. Le même code peut exister dans les deux,
 * et dans autant de projets qu'on veut — ce sont des documents indépendants,
 * avec des HTML, des sujets, des versions et des historiques distincts.
 */
export type EmailTemplateScopeType = 'PANEL' | 'PROJECT';

/** Une portée telle qu'un appel la DÉSIGNE. `scopeId` n'existe que pour PROJECT. */
export type EmailTemplateScopeRef =
  | { scopeType: 'PANEL' }
  | { scopeType: 'PROJECT'; scopeId: string };

/** Une portée telle que le SERVEUR l'énumère — la liste ne vient jamais du client. */
export interface EmailTemplateScope {
  scopeType: EmailTemplateScopeType;
  scopeId: string | null;
  label: string;
  pairingStatus: string | null;
  /**
   * CE QUE CE PROJET DÉCLARE UTILISER — `null` s'il n'a jamais déclaré.
   *
   * Permet au sélecteur de dire « 9 modèles utilisés » sans ouvrir la portée, et
   * surtout de rendre visible le cas qui compte : un projet muet, dont on ne
   * sait pas s'il n'utilise rien ou s'il n'a simplement jamais parlé.
   */
  declaration: {
    templateCodes: string[];
    count: number;
    revision: string;
    declaredAt: string | null;
    unknown: string[];
    forbidden: string[];
    reconciledAt: string | null;
  } | null;
  /**
   * `commercialState` a été retiré : le serveur ne l'énumère plus, l'ouverture
   * commerciale ayant été supprimée du Panel. Aucun écran ne le lisait.
   */
}

/** La portée telle qu'une réponse la RENVOIE, avec son libellé d'affichage. */
export interface EmailTemplateScopeBadge {
  scopeType: EmailTemplateScopeType;
  scopeId: string | null;
  label: string;
}

/** D'où vient le contenu servi. `REGISTRY_DEFAULT` = aucune instance en base. */
export type EmailTemplateSource = 'PANEL' | 'PROJECT' | 'REGISTRY_DEFAULT';

export interface EmailTemplateSummary {
  templateId: string;
  name: string;
  description: string;
  enabled: boolean;
  /**
   * `false` = aucune instance dans cette portée. En portée PROJECT, cela signifie
   * qu'un envoi ÉCHOUERAIT : le contenu du Panel n'est jamais servi à la place.
   * L'écran doit le montrer, pas le masquer derrière un contenu par défaut.
   */
  configured: boolean;
  /**
   * L'INSTANCE EST-ELLE ARCHIVÉE ? (L12.1)
   *
   * `true` = le projet a cessé de déclarer ce code. L'instance et son
   * historique sont conservés — l'archive n'existe que pour cela — mais l'envoi
   * la refuse et la projection servie au projet ne la contient plus.
   *
   * Elle reste visible ICI, et seulement ici : c'est le seul endroit d'où l'on
   * peut relire le contenu écrit avant le retrait.
   */
  archived?: boolean;
  /**
   * CE PROJET DÉCLARE-T-IL ENCORE CE MODÈLE ? — trois valeurs, trois sens.
   *
   *   true   il l'utilise : modèle ACTIF ;
   *   false  il ne l'utilise plus : contenu conservé, rangé à part ;
   *   null   aucune déclaration reçue — le projet n'a rien dit, et l'écran n'a
   *          donc rien à ranger. À ne SURTOUT pas lire comme `false`.
   *
   * Toujours `null` en portée PANEL : la question ne s'y pose pas.
   */
  declared: boolean | null;
  valid: boolean;
  errorCount: number;
  variableCount: number;
  version: number;
  source: EmailTemplateSource;
  category: string;
  scopes: EmailTemplateScopeType[];
  scope: EmailTemplateScopeBadge;
  updatedAt: string | null;
}

export interface EmailTemplateDetail {
  templateId: string;
  /** Voir `EmailTemplateSummary.declared` — même sémantique à trois valeurs. */
  declared: boolean | null;
  name: string;
  description: string;
  subject: string;
  html: string;
  enabled: boolean;
  configured: boolean;
  /** Voir `archived` sur le résumé : conservé, hors service, relisible ici. */
  archived?: boolean;
  archivedAt?: string | null;
  archivedReason?: string;
  version: number;
  source: EmailTemplateSource;
  scope: EmailTemplateScopeBadge;
  /**
   * LE CONTRAT FONCTIONNEL — commun à toutes les portées de ce code.
   *
   * Trois projets réécrivent le texte ; aucun n'invente une variable. C'est
   * l'option A du lot : le contenu est scopé, le contrat ne l'est pas.
   */
  contract: {
    category: string;
    scopes: EmailTemplateScopeType[];
    allowedVariables: string[];
    requiredVariables: string[];
    ownershipReason: string;
  };
  updatedAt: string | null;
  validation: EmailTemplateValidation;
  variables: EmailTemplateVariable[];
}

export interface EmailTemplateDraft {
  name: string;
  description: string;
  subject: string;
  html: string;
  enabled: boolean;
}

export interface EmailTemplatePreview {
  templateId: string;
  scope: EmailTemplateScopeBadge;
  subject: string | null;
  html: string | null;
  usedVariables?: string[];
  validation: EmailTemplateValidation;
  sampleVariables: Record<string, unknown>;
  renderError: {
    code: string;
    message: string;
    details: unknown[];
  } | null;
}

export interface EmailTemplateReadinessItem {
  code: string;
  message: string;
}

export interface EmailTemplateReadiness {
  ready: boolean;
  blockers: EmailTemplateReadinessItem[];
  warnings: EmailTemplateReadinessItem[];
  context: {
    provider: string;
    providerMode: string | null;
    sender: {
      email: string | null;
      name: string | null;
    };
    scope: EmailTemplateScopeBadge;
    template: {
      templateId: string;
      version: number;
      enabled: boolean;
      configured: boolean;
      name: string;
    };
  };
}

export interface EmailTemplateTestSendResult {
  operationId: string;
  templateId: string;
  scope: EmailTemplateScopeBadge;
  providerMessageId: string | null;
  /**
   * CE QUI EST RÉELLEMENT PARTI — rendu par l'adaptateur, pas par l'écran.
   *
   * C'est la preuve que l'aperçu et l'envoi ont servi le MÊME document : si
   * `templateScope` ne correspond pas à la portée sélectionnée, quelque chose
   * ment, et il vaut mieux le voir sur l'écran de test que chez un client.
   */
  templateScope: EmailTemplateScopeType | null;
  templateScopeId: string | null;
  templateVersion: number | null;
  sender: {
    email: string | null;
    name: string | null;
  };
  message: string;
  readiness: EmailTemplateReadiness;
}

export interface EmailTemplateVersionSummary {
  version: number;
  name: string;
  description: string;
  enabled: boolean;
  origin: string;
  restoredFromVersion: number | null;
  changedByLabel: string;
  createdAt: string;
}

export interface EmailTemplateVersionDetail {
  templateId: string;
  version: number;
  name: string;
  description: string;
  subject: string;
  html: string;
  enabled: boolean;
  origin: string;
  restoredFromVersion: number | null;
  changedByLabel: string;
  createdAt: string;
  validation: EmailTemplateValidation;
}
