import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { ThemedSelect } from '@/components/ThemedSelect';
import { useToast } from '@/components/ToastProvider';
import { errorMessage } from '@/lib/api';
import { legalApi } from '@/lib/legalApi';
import { DocumentPreview } from '@/components/legal/DocumentPreview';
import type {
  LegalDocumentType,
  LegalPreview,
  LegalTemplateSummary,
  ProjectLegalDocuments,
} from '@/types.legal';

/**
 * LA SECTION « Documents légaux » DE LA FICHE PROJET.
 *
 * ══ CE QU'ELLE DOIT PERMETTRE EN QUELQUES SECONDES ════════════════════════
 *
 *     Mentions légales          [ Template standard vitrine    ▾ ]
 *     Politique de confidentialité  [ Politique standard FR    ▾ ]
 *                                                       Aperçu
 *
 * Deux menus, un bouton. Rien d'autre : ni options, ni cases à cocher, ni
 * réglage par projet. Tout ce qui pourrait être configuré ici l'est déjà
 * ailleurs — le TEXTE dans le template, les DONNÉES dans la fiche entreprise.
 *
 * ══ CE QU'ELLE AFFICHE EN PLUS, ET POURQUOI ═══════════════════════════════
 *
 * Le STATUT et la VERSION du template choisi, parce qu'un brouillon assigné ne
 * produit aucune page et qu'il faut pouvoir le comprendre sans ouvrir un autre
 * écran.
 *
 * L'AVERTISSEMENT de complétude, parce qu'un bloc retiré est invisible : sans
 * lui, une page amputée passerait pour une page complète. Et il MÈNE quelque
 * part — un avertissement sans destination est un reproche.
 *
 * ══ ENREGISTRER SUFFIT ════════════════════════════════════════════════════
 *
 * Le backend publie dans la foulée. Il n'y a pas de « déployer », pas de
 * « synchroniser » à cliquer ensuite : le site affiche le nouveau document
 * sans reconstruction. Le message de confirmation le dit, parce que c'est
 * précisément ce qu'on n'ose pas croire la première fois.
 */

const LABELS: Record<LegalDocumentType, string> = {
  LEGAL_NOTICE: 'Mentions légales',
  PRIVACY_POLICY: 'Politique de confidentialité',
};

const ROUTES: Record<LegalDocumentType, string> = {
  LEGAL_NOTICE: '/mentions-legales',
  PRIVACY_POLICY: '/politique-de-confidentialite',
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Brouillon', ACTIVE: 'Publié', ARCHIVED: 'Archivé',
};

const BLOCKED_MESSAGE: Record<string, string> = {
  NO_ASSIGNMENT: 'Aucun template assigné : la page n’est pas publiée sur le site.',
  TEMPLATE_MISSING: 'Le template assigné n’existe plus. Choisissez-en un autre.',
  TEMPLATE_DRAFT: 'Le template assigné est un brouillon : publiez-le pour que la page apparaisse.',
  TEMPLATE_NEVER_PUBLISHED: 'Ce template n’a jamais été publié : il n’y a rien à servir.',
};

export function ProjectLegalSection({ projectId }: { projectId: string }) {
  const toast = useToast();
  const [state, setState] = useState<ProjectLegalDocuments | null>(null);
  const [catalogue, setCatalogue] = useState<LegalTemplateSummary[]>([]);
  const [choice, setChoice] = useState<Record<LegalDocumentType, string>>({
    LEGAL_NOTICE: '', PRIVACY_POLICY: '',
  });
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState<LegalDocumentType | null>(null);
  const [preview, setPreview] = useState<LegalPreview | null>(null);

  const reload = useCallback(async () => {
    try {
      const [docs, list] = await Promise.all([
        legalApi.projectDocuments(projectId),
        legalApi.list(),
      ]);
      setState(docs);
      setCatalogue(list.templates);
      setChoice({
        LEGAL_NOTICE: docs.documents.LEGAL_NOTICE.templateId ?? '',
        PRIVACY_POLICY: docs.documents.PRIVACY_POLICY.templateId ?? '',
      });
    } catch (err) {
      toast.error(errorMessage(err, 'Lecture des documents légaux impossible.'));
    }
  }, [projectId, toast]);

  useEffect(() => { void reload(); }, [reload]);

  /**
   * LE SÉLECTEUR NE MONTRE QUE CE QUI PEUT ÊTRE SERVI — les templates ACTIFS
   * du bon type.
   *
   * Un brouillon y figurerait pour être refusé à l'enregistrement : proposer
   * un choix impossible n'est pas une information, c'est un piège. L'exception
   * est le template DÉJÀ assigné : s'il a été archivé entre-temps, le retirer
   * de la liste ferait apparaître le menu comme vide alors qu'un document est
   * bel et bien servi.
   */
  const optionsFor = useMemo(() => (type: LegalDocumentType) => {
    const assigned = state?.documents[type].templateId ?? null;
    return catalogue
      .filter((t) => t.type === type && (t.status === 'ACTIVE' || t.legalTemplateId === assigned))
      .map((t) => ({
        value: t.legalTemplateId,
        label: t.name,
        hint: [
          STATUS_LABEL[t.status],
          t.version > 0 ? `v${t.version}` : null,
          t.usageCount > 0 ? `${t.usageCount} projet${t.usageCount > 1 ? 's' : ''}` : null,
        ].filter(Boolean).join(' · '),
      }));
  }, [catalogue, state]);

  const dirty = useMemo(() => {
    if (!state) return false;
    return (['LEGAL_NOTICE', 'PRIVACY_POLICY'] as LegalDocumentType[])
      .some((t) => (state.documents[t].templateId ?? '') !== choice[t]);
  }, [state, choice]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await legalApi.assignProjectDocuments(projectId, {
        legalNoticeTemplateId: choice.LEGAL_NOTICE || null,
        privacyPolicyTemplateId: choice.PRIVACY_POLICY || null,
      });
      setState(updated);
      toast.success(
        'Documents légaux enregistrés. Le site les affiche déjà — aucun redéploiement n’est nécessaire.',
      );
    } catch (err) {
      toast.error(errorMessage(err, 'Enregistrement impossible.'));
    } finally {
      setSaving(false);
    }
  };

  const openPreview = async (type: LegalDocumentType) => {
    const templateId = choice[type];
    if (!templateId) return;
    setPreviewing(type);
    setPreview(null);
    try {
      setPreview(await legalApi.preview(templateId, projectId));
    } catch (err) {
      toast.error(errorMessage(err, 'Aperçu indisponible.'));
      setPreviewing(null);
    }
  };

  if (!state) return <Card title="Documents légaux"><p className="muted">Chargement…</p></Card>;

  return (
    <Card title="Documents légaux" className="legal-project-section">
      <p className="muted">
        Le texte vient du référentiel du Panel ; les données viennent de l’entreprise cliente, de
        notre entreprise et de l’hébergeur. Le site n’en détient aucune copie modifiable.
      </p>

      {!state.clientCompanyId && (
        <div className="alert alert-warning">
          <Icon name="exclamation-triangle" /> Aucune entreprise cliente n’est rattachée à ce projet :
          les mentions légales ne peuvent pas nommer d’éditeur.
        </div>
      )}

      {(['LEGAL_NOTICE', 'PRIVACY_POLICY'] as LegalDocumentType[]).map((type) => {
        const doc = state.documents[type];
        const missing = doc.completeness?.missing ?? [];
        return (
          <div key={type} className="legal-assign-row">
            <div className="legal-assign-head">
              <label className="field-label">{LABELS[type]}</label>
              <code className="legal-assign-route">{ROUTES[type]}</code>
            </div>

            <div className="legal-assign-control">
              <ThemedSelect
                value={choice[type]}
                ariaLabel={`Template de ${LABELS[type]}`}
                placeholder="Aucun template"
                options={[{ value: '', label: 'Aucun template' }, ...optionsFor(type)]}
                onChange={(v) => setChoice((c) => ({ ...c, [type]: v }))}
              />
              <button
                type="button"
                className="btn btn-small"
                disabled={!choice[type]}
                onClick={() => void openPreview(type)}
              >
                <Icon name="eye" /> Aperçu
              </button>
            </div>

            <div className="legal-assign-state">
              {doc.template && (
                <span className="muted">
                  {STATUS_LABEL[doc.template.status]}
                  {doc.template.version > 0 ? ` · v${doc.template.version}` : ''}
                  {doc.template.publishedAt ? ` · publié le ${formatDate(doc.template.publishedAt)}` : ''}
                </span>
              )}
              {doc.blockedReason && (
                <p className="alert alert-warning legal-assign-alert">
                  <Icon name="exclamation-triangle" /> {BLOCKED_MESSAGE[doc.blockedReason]}
                </p>
              )}
              {/*
                L'AVERTISSEMENT DE COMPLÉTUDE MÈNE QUELQUE PART.

                « 1 information non renseignée » sans destination oblige à
                chercher laquelle et où. Le lien va droit à la fiche à corriger.
              */}
              {missing.length > 0 && (
                <p className="alert alert-warning legal-assign-alert">
                  <Icon name="exclamation-triangle" />
                  {' '}Ce template utilise {missing.length} information{missing.length > 1 ? 's' : ''} non
                  renseignée{missing.length > 1 ? 's' : ''} : {missing.map((m) => m.label).join(', ')}.
                  {' '}
                  {missing.some((m) => m.source === 'CLIENT') && state.clientCompanyId && (
                    <Link to={`/clients/${state.clientCompanyId}`}>Compléter l’entreprise</Link>
                  )}
                  {missing.every((m) => m.source === 'DEVELOPER') && (
                    <Link to="/company">Compléter « Mon entreprise »</Link>
                  )}
                  {missing.every((m) => m.source === 'HOST') && (
                    <Link to="/hebergeur">Compléter l’hébergeur</Link>
                  )}
                </p>
              )}
              {doc.served && missing.length === 0 && !doc.blockedReason && (
                <p className="legal-ok"><Icon name="check-circle" /> Servi au site.</p>
              )}
            </div>
          </div>
        );
      })}

      <div className="legal-assign-actions">
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          Enregistrer
        </button>
        <Link className="btn btn-small btn-ghost" to="/documents-legaux">
          <Icon name="file-earmark-text" /> Gérer les templates
        </Link>
      </div>

      {previewing && (
        <div className="legal-project-preview">
          <div className="legal-pane-head">
            <h3>Aperçu — {LABELS[previewing]}</h3>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => { setPreviewing(null); setPreview(null); }}>
              <Icon name="x-lg" /> Fermer
            </button>
          </div>
          <DocumentPreview
            document={preview?.document ?? null}
            completeness={preview?.completeness ?? null}
            projectName={state.projectName}
            loading={!preview}
          />
        </div>
      )}
    </Card>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fr-FR');
}

export default ProjectLegalSection;
