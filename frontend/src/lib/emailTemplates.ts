import type {
  EmailTemplateDetail,
  EmailTemplateDraft,
  EmailTemplateReadiness,
  EmailTemplateValidation,
  EmailTemplateValidationError,
  EmailTemplateVariable,
  EmailTemplateVariableType,
} from '@/types.emailTemplates';

export const EDITOR_TABS = ['editor', 'preview', 'variables', 'versions', 'guide'] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export const TAB_LABEL: Record<EditorTab, string> = {
  editor: 'Editeur',
  preview: 'Apercu',
  variables: 'Variables',
  versions: 'Versions',
  guide: 'Guide',
};

export function draftFromTemplate(template: EmailTemplateDetail): EmailTemplateDraft {
  return {
    name: template.name,
    description: template.description,
    subject: template.subject,
    html: template.html,
    enabled: template.enabled,
  };
}

export function isTemplateDirty(a: EmailTemplateDraft, b: EmailTemplateDraft): boolean {
  return (
    a.name !== b.name
    || a.description !== b.description
    || a.subject !== b.subject
    || a.html !== b.html
    || a.enabled !== b.enabled
  );
}

export function changedFields(
  draft: EmailTemplateDraft,
  baseline: EmailTemplateDraft,
): Partial<EmailTemplateDraft> {
  const patch: Partial<EmailTemplateDraft> = {};
  if (draft.name !== baseline.name) patch.name = draft.name;
  if (draft.description !== baseline.description) patch.description = draft.description;
  if (draft.subject !== baseline.subject) patch.subject = draft.subject;
  if (draft.html !== baseline.html) patch.html = draft.html;
  if (draft.enabled !== baseline.enabled) patch.enabled = draft.enabled;
  return patch;
}

export function insertVariable(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  key: string,
): { text: string; cursor: number } {
  const token = `{{${key}}}`;
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  return {
    text: `${text.slice(0, start)}${token}${text.slice(end)}`,
    cursor: start + token.length,
  };
}

function usedVariableKeys(draft: EmailTemplateDraft): string[] {
  const keys: string[] = [];
  const re = /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\}\}/g;
  const content = `${draft.subject}\n${draft.html}`;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

export function variableUsage(draft: EmailTemplateDraft, variables: EmailTemplateVariable[]) {
  const used = new Set(usedVariableKeys(draft));
  return variables.map((variable) => ({
    key: variable.key,
    used: used.has(variable.key),
    required: variable.required,
    missing: variable.required && !used.has(variable.key),
  }));
}

const VARIABLE_TYPE_LABEL: Record<EmailTemplateVariableType, string> = {
  TEXT: 'Texte',
  EMAIL: 'Adresse e-mail',
  PHONE: 'Telephone',
  DATE: 'Date',
  DATETIME: 'Date et heure',
  MONEY: 'Montant',
  URL: 'Lien',
  BOOLEAN: 'Oui / Non',
  SAFE_HTML: 'HTML sur',
};

export function variableTypeLabel(type: EmailTemplateVariableType): string {
  return VARIABLE_TYPE_LABEL[type] ?? 'Type inconnu';
}

const VALIDATION_CODE_LABEL: Record<string, string> = {
  UNKNOWN_TEMPLATE: 'Template inconnu',
  TEMPLATE_DISABLED: 'Template desactive',
  TEMPLATE_INVALID: 'Template invalide',
  SUBJECT_EMPTY: 'Sujet vide',
  SUBJECT_TOO_LONG: 'Sujet trop long',
  HTML_EMPTY: 'Contenu vide',
  HTML_TOO_LONG: 'Contenu trop volumineux',
  FORBIDDEN_TAG: 'Balise interdite',
  FORBIDDEN_ATTRIBUTE: 'Attribut interdit',
  DANGEROUS_URL: 'URL interdite',
  UNKNOWN_VARIABLE: 'Variable inconnue',
  MISSING_REQUIRED_VARIABLE: 'Variable obligatoire absente',
  INVALID_PLACEHOLDER: 'Placeholder invalide',
  UNRESOLVED_PLACEHOLDER: 'Placeholder non resolu',
  INVALID_VARIABLE_VALUE: 'Valeur invalide',
};

export function groupErrors(errors: EmailTemplateValidationError[]) {
  const groups: { code: string; label: string; items: EmailTemplateValidationError[] }[] = [];
  for (const error of errors) {
    let group = groups.find((item) => item.code === error.code);
    if (!group) {
      group = {
        code: error.code,
        label: VALIDATION_CODE_LABEL[error.code] ?? 'Erreur de validation',
        items: [],
      };
      groups.push(group);
    }
    group.items.push(error);
  }
  return groups;
}

export function validationSummary(validation: EmailTemplateValidation): string {
  if (validation.valid) return 'Valide';
  return validation.errors.length === 1 ? '1 erreur' : `${validation.errors.length} erreurs`;
}

const READINESS_CODE_LABEL: Record<string, string> = {
  TEMPLATE_DISABLED: 'Template desactive',
  TEMPLATE_INVALID: 'Template invalide',
  SENDER_NOT_CONFIGURED: 'Expediteur absent',
  PROVIDER_NOT_CONFIGURED: 'Brevo non configure',
  PROVIDER_NOT_VALIDATED: 'Brevo non valide',
  PROVIDER_INVALID_CREDENTIALS: 'Identifiants Brevo invalides',
  PROVIDER_UNREACHABLE: 'Brevo injoignable',
  PROVIDER_UNAVAILABLE: 'Brevo indisponible',
};

export function readinessCodeLabel(code: string): string {
  return READINESS_CODE_LABEL[code] ?? 'Condition non remplie';
}

const VERSION_ORIGIN_LABEL: Record<string, string> = {
  BOOTSTRAP: 'Creation',
  EDIT: 'Modification',
  RESTORE: 'Restauration',
};

export function versionOriginLabel(origin: string): string {
  return VERSION_ORIGIN_LABEL[origin] ?? 'Origine inconnue';
}

export const PREVIEW_WIDTHS = {
  desktop: 600,
  mobile: 375,
} as const;

export type PreviewDevice = keyof typeof PREVIEW_WIDTHS;

export function previewWidth(device: PreviewDevice): number {
  return PREVIEW_WIDTHS[device];
}

export function isSenderMissing(readiness: EmailTemplateReadiness | null): boolean {
  return Boolean(readiness?.blockers.some((item) => item.code === 'SENDER_NOT_CONFIGURED'));
}
