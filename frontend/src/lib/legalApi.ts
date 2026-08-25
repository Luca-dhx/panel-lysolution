// L'ACCÈS AUX DOCUMENTS LÉGAUX — un module à part, comme `clientCompanies`.
//
// Volontairement HORS de `api.*`, où vivent les projets et l'infrastructure :
// un template de mentions légales n'appartient ni au registre, ni à
// l'entreprise, ni à un client. C'est un contenu commun cité par les trois, et
// le ranger sous l'un d'eux aurait entretenu exactement la confusion que ce
// chantier dissipe.
import { request } from '@/lib/api';
import type {
  HostCompany,
  HostCompanyScreen,
  LegalContent,
  LegalDocumentType,
  LegalPreview,
  LegalPreviewTarget,
  LegalTemplateDetail,
  LegalTemplateSummary,
  LegalTemplateVersionRow,
  LegalVariableRegistry,
  ProjectLegalDocuments,
} from '@/types.legal';

const base = '/api/legal-templates';
const id = (value: string) => encodeURIComponent(value);

export const legalApi = {
  /* ── LE REGISTRE ─────────────────────────────────────────────────────── */

  /**
   * La palette « + Insérer une donnée », servie par le backend.
   *
   * Jamais recopiée dans le frontend : le registre est code-first côté
   * serveur. Une copie divergerait à la première variable ajoutée, et l'écran
   * proposerait alors une donnée que le validateur refuse — ou l'inverse, ce
   * qui est pire, puisqu'on ne saurait pas qu'elle existe.
   */
  variables: () => request<LegalVariableRegistry>(`${base}/variables`),

  previewTargets: () => request<{ projects: LegalPreviewTarget[] }>(`${base}/preview-targets`),

  /* ── CATALOGUE ───────────────────────────────────────────────────────── */

  list: (type?: LegalDocumentType) =>
    request<{ templates: LegalTemplateSummary[] }>(
      type ? `${base}?type=${type}` : base,
    ),

  detail: (legalTemplateId: string) =>
    request<LegalTemplateDetail>(`${base}/${id(legalTemplateId)}`),

  create: (body: { name: string; type: LegalDocumentType; description?: string; content?: LegalContent }) =>
    request<LegalTemplateDetail>(base, { method: 'POST', body }),

  update: (legalTemplateId: string, body: { name?: string; description?: string; content?: LegalContent }) =>
    request<LegalTemplateDetail>(`${base}/${id(legalTemplateId)}`, { method: 'PUT', body }),

  /**
   * PUBLIER — le seul geste qui atteint les sites.
   *
   * Il republie vers tous les projets rattachés ; `recipients` dit combien.
   * L'écran l'affiche : « publié — 2 sites mis à jour » est la seule preuve
   * immédiate que le changement est effectivement parti.
   */
  publish: (legalTemplateId: string) =>
    request<LegalTemplateDetail>(`${base}/${id(legalTemplateId)}/publish`, { method: 'POST' }),

  archive: (legalTemplateId: string) =>
    request<LegalTemplateDetail>(`${base}/${id(legalTemplateId)}/archive`, { method: 'POST' }),

  restore: (legalTemplateId: string) =>
    request<LegalTemplateDetail>(`${base}/${id(legalTemplateId)}/restore`, { method: 'POST' }),

  /**
   * SUPPRIMER — refusé par le backend dès qu'un projet utilise le template.
   *
   * L'erreur porte `details.usageCount` et `details.projects` : l'écran nomme
   * les sites concernés et propose l'archivage. Un « êtes-vous sûr ? » n'aurait
   * rien protégé — personne ne peut savoir, devant une modale, quels sites vont
   * perdre leur page.
   */
  remove: (legalTemplateId: string) =>
    request<{ deleted: boolean }>(`${base}/${id(legalTemplateId)}`, { method: 'DELETE' }),

  versions: (legalTemplateId: string) =>
    request<{ versions: LegalTemplateVersionRow[] }>(`${base}/${id(legalTemplateId)}/versions`),

  restoreVersion: (legalTemplateId: string, version: number) =>
    request<LegalTemplateDetail>(
      `${base}/${id(legalTemplateId)}/versions/${version}/restore`,
      { method: 'POST' },
    ),

  /**
   * L'APERÇU AVEC LES DONNÉES RÉELLES D'UN PROJET.
   *
   * Il sert le BROUILLON — c'est tout l'objet : voir ce qu'on s'apprête à
   * publier, pas ce qui est déjà en ligne. Et il passe par le même résolveur
   * que la publication, ce qui garantit que l'écran ne ment pas.
   */
  preview: (legalTemplateId: string, projectId: string) =>
    request<LegalPreview>(
      `${base}/${id(legalTemplateId)}/preview?projectId=${id(projectId)}`,
    ),

  /* ── AFFECTATION D'UN PROJET ─────────────────────────────────────────── */

  projectDocuments: (projectId: string) =>
    request<ProjectLegalDocuments>(`/api/projects/${id(projectId)}/legal-documents`),

  /**
   * ASSIGNER — le backend publie dans la foulée, sans redéploiement du site.
   *
   * `null` retire l'affectation ; un champ absent la laisse inchangée. La
   * distinction compte : un écran qui n'envoie qu'un des deux champs ne doit
   * pas effacer l'autre.
   */
  assignProjectDocuments: (
    projectId: string,
    body: { legalNoticeTemplateId?: string | null; privacyPolicyTemplateId?: string | null },
  ) =>
    request<ProjectLegalDocuments>(`/api/projects/${id(projectId)}/legal-documents`, {
      method: 'PUT',
      body,
    }),

  resyncProjectDocuments: (projectId: string) =>
    request<{ published: Record<string, unknown> }>(
      `/api/projects/${id(projectId)}/legal-documents/resync`,
      { method: 'POST' },
    ),

  /* ── HÉBERGEUR ───────────────────────────────────────────────────────── */

  hosts: () => request<HostCompanyScreen>('/api/host-companies'),

  createHost: (body: Record<string, unknown>) =>
    request<HostCompany>('/api/host-companies', { method: 'POST', body }),

  updateHost: (hostCompanyId: string, body: Record<string, unknown>) =>
    request<HostCompany>(`/api/host-companies/${id(hostCompanyId)}`, { method: 'PUT', body }),

  setHostStatus: (hostCompanyId: string, status: 'ACTIVE' | 'ARCHIVED') =>
    request<HostCompany>(`/api/host-companies/${id(hostCompanyId)}/status`, {
      method: 'POST',
      body: { status },
    }),
};

export default legalApi;
