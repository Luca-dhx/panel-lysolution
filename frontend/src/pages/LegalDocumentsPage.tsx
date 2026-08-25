import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Card, EmptyState } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { ThemedSelect } from '@/components/ThemedSelect';
import { useToast } from '@/components/ToastProvider';
import { ApiError, errorMessage } from '@/lib/api';
import { legalApi } from '@/lib/legalApi';
import { DocumentPreview } from '@/components/legal/DocumentPreview';
import { TokenField, insertAtCursor } from '@/components/legal/TokenField';
import { VariablePalette } from '@/components/legal/VariablePalette';
import type {
  LegalBlock,
  LegalContent,
  LegalDocumentType,
  LegalPreview,
  LegalPreviewTarget,
  LegalSection,
  LegalTemplateDetail,
  LegalTemplateSummary,
  LegalVariableRegistry,
} from '@/types.legal';

/**
 * DOCUMENTS LÉGAUX — le catalogue et l'éditeur.
 *
 * ══ CE QUE CET ÉCRAN DOIT FAIRE COMPRENDRE EN DIX SECONDES ════════════════
 *
 * Qu'on écrit le texte COMMUN une seule fois, qu'on y insère des DONNÉES, et
 * que chaque projet qui utilise ce template reçoit le document avec SES
 * valeurs. Tout le reste — statuts, versions, décomptes d'usage — est au
 * service de cette phrase.
 *
 * D'où trois partis pris :
 *
 *   · DEUX CATÉGORIES, PAS UN FILTRE. « Mentions légales » et « Politique de
 *     confidentialité » sont deux onglets, pas deux valeurs d'une liste
 *     déroulante. Ce sont deux documents différents dans la tête de celui qui
 *     vient les écrire, et un filtre les aurait présentés comme une nuance ;
 *
 *   · ÉDITEUR ET APERÇU CÔTE À CÔTE. On n'écrit pas un document juridique en
 *     basculant entre deux écrans : la moitié droite montre en permanence ce
 *     que le site affichera, avec les vraies données d'un projet choisi ;
 *
 *   · L'AIDE EST COURTE ET AU BON ENDROIT. Une phrase au-dessus de l'éditeur,
 *     une au-dessus de l'aperçu. Pas de page d'aide : personne ne l'ouvrirait.
 */

const TABS: { type: LegalDocumentType; label: string; hint: string }[] = [
  {
    type: 'LEGAL_NOTICE',
    label: 'Mentions légales',
    hint: "Qui édite le site, qui l'a conçu, qui l'héberge.",
  },
  {
    type: 'PRIVACY_POLICY',
    label: 'Politique de confidentialité',
    hint: 'Quelles données sont collectées, pourquoi, et pour combien de temps.',
  },
];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Brouillon',
  ACTIVE: 'Publié',
  ARCHIVED: 'Archivé',
};

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'badge-warn',
  ACTIVE: 'badge-ok',
  ARCHIVED: 'badge-muted',
};

function newId(prefix: string) {
  return `${prefix}${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

function emptyBlock(type: LegalBlock['type']): LegalBlock {
  return { blockId: newId('blk'), type, text: '', items: type === 'LIST' ? [''] : [], fields: type === 'FIELDS' ? [{ label: '', value: '' }] : [] };
}

function emptySection(): LegalSection {
  return { sectionId: newId('sec'), heading: '', blocks: [emptyBlock('PARAGRAPH')] };
}

export function LegalDocumentsPage() {
  const [tab, setTab] = useState<LegalDocumentType>('LEGAL_NOTICE');
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="page legal-page">
      <header className="page-header">
        <h1>Documents légaux</h1>
        <p className="page-description">
          Le référentiel des textes que les sites du parc publient. Écrivez le texte une seule fois,
          insérez les données de l’entreprise, du concepteur ou de l’hébergeur : chaque projet reçoit
          le document avec ses propres valeurs.
        </p>
      </header>

      {editing ? (
        <TemplateEditor legalTemplateId={editing} onBack={() => setEditing(null)} />
      ) : (
        <Catalogue tab={tab} onTab={setTab} onOpen={setEditing} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  CATALOGUE                                                                 */
/* -------------------------------------------------------------------------- */

function Catalogue({
  tab, onTab, onOpen,
}: {
  tab: LegalDocumentType;
  onTab: (t: LegalDocumentType) => void;
  onOpen: (id: string) => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<LegalTemplateSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await legalApi.list();
      setTemplates(res.templates);
    } catch (err) {
      toast.error(errorMessage(err, 'Lecture du catalogue impossible.'));
      setTemplates([]);
    }
  }, [toast]);

  useEffect(() => { void reload(); }, [reload]);

  const rows = useMemo(
    () => (templates ?? []).filter((t) => t.type === tab),
    [templates, tab],
  );

  const create = async () => {
    if (newName.trim().length < 3) {
      toast.error('Donnez un nom d’au moins 3 caractères.');
      return;
    }
    setBusy(true);
    try {
      const created = await legalApi.create({ name: newName.trim(), type: tab });
      setCreating(false);
      setNewName('');
      onOpen(created.legalTemplateId);
    } catch (err) {
      toast.error(errorMessage(err, 'Création impossible.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * LA SUPPRESSION EST REFUSÉE PAR LE BACKEND DÈS QU'UN PROJET UTILISE LE
   * TEMPLATE, et l'erreur NOMME les projets.
   *
   * On les affiche, et on propose l'archivage — la sortie honorable. Une modale
   * « êtes-vous sûr ? » n'aurait rien protégé : personne ne peut savoir, devant
   * une modale, quels sites vont perdre leur page.
   */
  const remove = async (row: LegalTemplateSummary) => {
    try {
      await legalApi.remove(row.legalTemplateId);
      toast.success(`« ${row.name} » supprimé.`);
      void reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'LEGAL_TEMPLATE_IN_USE') {
        const details = err.details as { projects?: { projectName: string }[] } | null;
        const noms = (details?.projects ?? []).map((p) => p.projectName).join(', ');
        toast.error(`${err.message}${noms ? ` — ${noms}` : ''}`);
        return;
      }
      toast.error(errorMessage(err, 'Suppression impossible.'));
    }
  };

  const archive = async (row: LegalTemplateSummary) => {
    try {
      if (row.status === 'ARCHIVED') await legalApi.restore(row.legalTemplateId);
      else await legalApi.archive(row.legalTemplateId);
      void reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Opération impossible.'));
    }
  };

  return (
    <>
      <div className="legal-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.type}
            role="tab"
            type="button"
            aria-selected={tab === t.type}
            className={`legal-tab ${tab === t.type ? 'is-active' : ''}`}
            onClick={() => onTab(t.type)}
          >
            <span className="legal-tab-label">{t.label}</span>
            <span className="legal-tab-hint">{t.hint}</span>
          </button>
        ))}
      </div>

      <Card
        title={TABS.find((t) => t.type === tab)!.label}
        className="legal-catalogue"
      >
        <div className="legal-catalogue-actions">
          {creating ? (
            <div className="legal-create-row">
              <input
                type="text"
                autoFocus
                value={newName}
                placeholder="Nom du template — ex. « Mentions légales — vitrine FR »"
                aria-label="Nom du nouveau template"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
              />
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>
                Créer
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                Annuler
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus-lg" /> Créer un template
            </button>
          )}
        </div>

        {templates === null && <p className="muted">Chargement…</p>}

        {templates !== null && rows.length === 0 && (
          <EmptyState
            title="Aucun template pour l’instant"
            hint="Créez-en un : vous pourrez y insérer les données de l’entreprise, du concepteur et de l’hébergeur, puis le publier."
          />
        )}

        {rows.length > 0 && (
          <div className="table-scroll">
            <table className="data-table legal-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Statut</th>
                  <th>Dernière modification</th>
                  <th>Projets</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.legalTemplateId}>
                    <td>
                      <button type="button" className="link-button" onClick={() => onOpen(row.legalTemplateId)}>
                        {row.name}
                      </button>
                      {row.description && <p className="muted legal-row-desc">{row.description}</p>}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                      {row.version > 0 && <span className="muted"> v{row.version}</span>}
                      {/*
                        « Modifications non publiées » répond à la seule question
                        qui compte devant un catalogue : ce que je vois en ligne
                        est-il ce que je viens d'écrire ?
                      */}
                      {row.hasUnpublishedChanges && (
                        <p className="legal-chip is-warn">modifications non publiées</p>
                      )}
                    </td>
                    <td className="muted">{formatDate(row.updatedAt)}</td>
                    <td>
                      {row.usageCount === 0
                        ? <span className="muted">—</span>
                        : <span>Utilisé par {row.usageCount} projet{row.usageCount > 1 ? 's' : ''}</span>}
                    </td>
                    <td className="legal-row-actions">
                      <button type="button" className="btn btn-small" onClick={() => onOpen(row.legalTemplateId)}>
                        <Icon name="pencil" /> Ouvrir
                      </button>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => void archive(row)}>
                        <Icon name="archive" /> {row.status === 'ARCHIVED' ? 'Désarchiver' : 'Archiver'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        title={row.usageCount > 0 ? `Utilisé par ${row.usageCount} projet(s) — archivage recommandé` : 'Supprimer'}
                        onClick={() => void remove(row)}
                      >
                        <Icon name="trash" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  ÉDITEUR                                                                   */
/* -------------------------------------------------------------------------- */

const PREVIEW_DEBOUNCE_MS = 500;

function TemplateEditor({ legalTemplateId, onBack }: { legalTemplateId: string; onBack: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();

  const [template, setTemplate] = useState<LegalTemplateDetail | null>(null);
  const [draft, setDraft] = useState<LegalContent | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [registry, setRegistry] = useState<LegalVariableRegistry | null>(null);
  const [targets, setTargets] = useState<LegalPreviewTarget[]>([]);
  const [previewProject, setPreviewProject] = useState('');
  const [preview, setPreview] = useState<LegalPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  /**
   * LE CHAMP QUI A LE FOCUS — pour que « Insérer une donnée » tombe au bon
   * endroit.
   *
   * Une `ref` et non un état : elle change à chaque clic dans un textarea, et
   * la porter en état rerendrait tout l'éditeur à chaque déplacement du
   * curseur.
   */
  const focused = useRef<{ el: HTMLTextAreaElement | null; apply: (v: string) => void } | null>(null);

  useEffect(() => {
    let annule = false;
    (async () => {
      try {
        const [detail, vars, tg] = await Promise.all([
          legalApi.detail(legalTemplateId),
          legalApi.variables(),
          legalApi.previewTargets(),
        ]);
        if (annule) return;
        setTemplate(detail);
        setDraft(detail.content);
        setName(detail.name);
        setDescription(detail.description);
        setRegistry(vars);
        setTargets(tg.projects);
        /**
         * LE PROJET D'APERÇU EST PRÉ-CHOISI — le premier qui utilise DÉJÀ ce
         * template, sinon le premier qui a une entreprise cliente.
         *
         * Ouvrir l'éditeur sur un aperçu vide obligerait à un clic pour voir la
         * seule chose qu'on est venu voir. Et pré-choisir un projet sans
         * entreprise montrerait un document amputé qui ferait croire à un
         * défaut du template.
         */
        const utilise = tg.projects.find((p) => p.assigned[detail.type] === legalTemplateId);
        const avecClient = tg.projects.find((p) => p.hasClientCompany);
        setPreviewProject(utilise?.projectId ?? avecClient?.projectId ?? tg.projects[0]?.projectId ?? '');
      } catch (err) {
        toast.error(errorMessage(err, 'Ouverture du template impossible.'));
      }
    })();
    return () => { annule = true; };
  }, [legalTemplateId, toast]);

  /**
   * L'APERÇU SUIT LA FRAPPE, AVEC UN TEMPS D'ARRÊT.
   *
   * Sans le délai, chaque caractère déclencherait une résolution serveur — donc
   * trois lectures de base par frappe. Avec un délai trop long, l'aperçu cesse
   * d'être un aperçu et devient un rapport.
   */
  useEffect(() => {
    if (!draft || !previewProject) { setPreview(null); return undefined; }
    let annule = false;
    setPreviewing(true);
    const timer = window.setTimeout(async () => {
      try {
        /**
         * ON ENREGISTRE LE BROUILLON AVANT DE DEMANDER L'APERÇU.
         *
         * L'aperçu est servi par le RÉSOLVEUR, à partir du brouillon EN BASE —
         * c'est ce qui garantit que ce qu'on relit est ce qui partira. Résoudre
         * un contenu envoyé dans la requête aurait exigé un second chemin de
         * rendu, et deux chemins finissent toujours par diverger.
         *
         * Un brouillon enregistré n'atteint AUCUN site : seule la publication
         * le fait. L'enregistrement automatique est donc sans risque ici, et
         * c'est précisément ce qui distingue `content` de `publishedContent`.
         */
        if (dirty) {
          await legalApi.update(legalTemplateId, { name, description, content: draft });
          if (!annule) setDirty(false);
        }
        const res = await legalApi.preview(legalTemplateId, previewProject);
        if (!annule) setPreview(res);
      } catch (err) {
        if (!annule) {
          setPreview(null);
          // Un contenu invalide est le cas NORMAL en cours de frappe (une
          // variable à moitié tapée). On ne crie pas : le message s'affiche
          // sous l'aperçu, et disparaît dès que la phrase est finie.
          if (err instanceof ApiError && !String(err.code ?? '').startsWith('LEGAL_CONTENT_')) {
            toast.error(errorMessage(err, 'Aperçu indisponible.'));
          }
        }
      } finally {
        if (!annule) setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => { annule = true; window.clearTimeout(timer); };
    // `dirty`, `name` et `description` sont lus dans le corps mais ne doivent
    // pas relancer l'aperçu à eux seuls : c'est la frappe du CONTENU qui le
    // pilote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, previewProject, legalTemplateId]);

  const availability = useMemo(() => {
    if (!preview) return null;
    const map: Record<string, boolean> = {};
    for (const field of preview.completeness.fields) map[field.key] = field.available;
    return map;
  }, [preview]);

  const patch = (updater: (c: LegalContent) => LegalContent) => {
    setDraft((current) => (current ? updater(current) : current));
    setDirty(true);
  };

  const insert = (key: string) => {
    const target = focused.current;
    if (!target) {
      toast.error('Placez d’abord le curseur dans un texte.');
      return;
    }
    const el = target.el;
    const { value, caret } = insertAtCursor(el, el?.value ?? '', key);
    target.apply(value);
    // Le curseur est replacé APRÈS le rendu de React : le faire tout de suite
    // le poserait dans la valeur précédente, donc au mauvais endroit.
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await legalApi.update(legalTemplateId, { name, description, content: draft });
      setTemplate(updated);
      setDirty(false);
      toast.success('Brouillon enregistré. Il n’est pas encore en ligne.');
    } catch (err) {
      toast.error(errorMessage(err, 'Enregistrement impossible.'));
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await legalApi.update(legalTemplateId, { name, description, content: draft });
      const published = await legalApi.publish(legalTemplateId);
      setTemplate(published);
      setDirty(false);
      const n = published.recipients ?? 0;
      toast.success(
        n > 0
          ? `Publié en version ${published.version} — ${n} site${n > 1 ? 's' : ''} mis à jour.`
          : `Publié en version ${published.version}. Aucun projet n’utilise encore ce template.`,
      );
    } catch (err) {
      toast.error(errorMessage(err, 'Publication impossible.'));
    } finally {
      setSaving(false);
    }
  };

  if (!template || !draft || !registry) return <p className="muted">Chargement…</p>;

  const projectName = targets.find((t) => t.projectId === previewProject)?.projectName ?? null;

  return (
    <div className="legal-editor">
      {/* ── EN-TÊTE : ce qu'on édite, dans quel état, et les deux gestes ── */}
      <header className="legal-editor-head">
        <div className="legal-editor-head-main">
          <button type="button" className="btn btn-small btn-ghost" onClick={onBack}>
            <Icon name="chevron-right" className="icon-flip" /> Catalogue
          </button>
          <input
            className="legal-editor-name"
            type="text"
            value={name}
            aria-label="Nom du template"
            onChange={(e) => { setName(e.target.value); setDirty(true); }}
          />
          <span className={`badge ${STATUS_TONE[template.status]}`}>{STATUS_LABEL[template.status]}</span>
          {template.version > 0 && <span className="muted">v{template.version}</span>}
          {dirty && <span className="legal-chip is-warn">non enregistré</span>}
        </div>
        <div className="legal-editor-head-actions">
          <button type="button" className="btn" disabled={saving} onClick={() => void save()}>
            Enregistrer le brouillon
          </button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void publish()}>
            <Icon name="check2" /> Publier
          </button>
        </div>
      </header>

      <input
        className="legal-editor-description"
        type="text"
        value={description}
        placeholder="Description courte — à quoi sert ce template ?"
        aria-label="Description du template"
        onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
      />

      {/*
        L'ONBOARDING — deux phrases, pas un manuel.

        Elle est placée entre l'en-tête et les deux colonnes parce que c'est le
        premier endroit où le regard tombe après le titre, et parce qu'elle
        explique justement la relation entre les deux colonnes.
      */}
      <div className="legal-howto">
        <Icon name="journal-text" />
        <div>
          <strong>Comment ça marche ?</strong>
          <p>
            Écrivez le texte commun une seule fois et insérez les données dynamiques de l’entreprise,
            du concepteur ou de l’hébergeur. Lorsqu’un projet utilise ce template, les valeurs sont
            automatiquement injectées. Un bloc dont une donnée manque est retiré — rien n’est jamais
            affiché à sa place.
          </p>
        </div>
      </div>

      <div className="legal-split">
        {/* ── COLONNE GAUCHE : L'ÉDITEUR ─────────────────────────────── */}
        <section className="legal-pane">
          <div className="legal-pane-head">
            <h2>Éditeur</h2>
            <VariablePalette
              variables={registry.variables}
              sources={registry.sources}
              availability={availability}
              onInsert={insert}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="legal-title">Titre du document</label>
            <input
              id="legal-title"
              type="text"
              value={draft.title}
              placeholder="Mentions légales"
              onChange={(e) => patch((c) => ({ ...c, title: e.target.value }))}
            />
          </div>

          {draft.sections.map((section, si) => (
            <SectionEditor
              key={section.sectionId}
              section={section}
              index={si}
              total={draft.sections.length}
              variables={registry.variables}
              focusRef={focused}
              onChange={(next) => patch((c) => ({
                ...c,
                sections: c.sections.map((s, i) => (i === si ? next : s)),
              }))}
              onMove={(delta) => patch((c) => {
                const sections = [...c.sections];
                const to = si + delta;
                if (to < 0 || to >= sections.length) return c;
                [sections[si], sections[to]] = [sections[to], sections[si]];
                return { ...c, sections };
              })}
              onRemove={() => patch((c) => ({
                ...c,
                sections: c.sections.filter((_, i) => i !== si),
              }))}
            />
          ))}

          <button
            type="button"
            className="btn btn-block"
            onClick={() => patch((c) => ({ ...c, sections: [...c.sections, emptySection()] }))}
          >
            <Icon name="plus-lg" /> Ajouter une section
          </button>
        </section>

        {/* ── COLONNE DROITE : L'APERÇU ──────────────────────────────── */}
        <section className="legal-pane legal-pane-preview">
          <div className="legal-pane-head">
            <h2>Aperçu</h2>
            <div className="legal-preview-picker">
              <span className="muted">Avec les données de</span>
              <ThemedSelect
                value={previewProject}
                ariaLabel="Projet utilisé pour l’aperçu"
                placeholder="Choisir un projet…"
                searchable={targets.length > 6}
                options={targets.map((t) => ({
                  value: t.projectId,
                  label: t.projectName,
                  hint: t.hasClientCompany ? undefined : 'aucune entreprise cliente',
                }))}
                onChange={setPreviewProject}
              />
            </div>
          </div>

          <p className="muted legal-pane-hint">
            Choisissez un projet pour visualiser le document avec ses vraies données. C’est
            exactement ce que le site affichera après publication.
          </p>

          <DocumentPreview
            document={preview?.document ?? null}
            completeness={preview?.completeness ?? null}
            projectName={projectName}
            loading={previewing && !preview}
            onFixSource={(source) => {
              if (source === 'CLIENT' && preview?.project.clientCompanyId) {
                navigate(`/clients/${preview.project.clientCompanyId}`);
              } else if (source === 'DEVELOPER') navigate('/company');
              else if (source === 'HOST') navigate('/hebergeur');
            }}
          />
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  UNE SECTION                                                               */
/* -------------------------------------------------------------------------- */

type FocusRef = React.MutableRefObject<{ el: HTMLTextAreaElement | null; apply: (v: string) => void } | null>;

function SectionEditor({
  section, index, total, variables, focusRef, onChange, onMove, onRemove,
}: {
  section: LegalSection;
  index: number;
  total: number;
  variables: LegalVariableRegistry['variables'];
  focusRef: FocusRef;
  onChange: (s: LegalSection) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const setBlock = (bi: number, block: LegalBlock) => onChange({
    ...section,
    blocks: section.blocks.map((b, i) => (i === bi ? block : b)),
  });

  return (
    <div className="legal-section">
      <div className="legal-section-head">
        <span className="legal-section-index">{index + 1}</span>
        <input
          type="text"
          className="legal-section-heading"
          value={section.heading}
          placeholder="Titre de la section — ex. « Éditeur du site »"
          aria-label={`Titre de la section ${index + 1}`}
          onChange={(e) => onChange({ ...section, heading: e.target.value })}
        />
        <div className="legal-section-tools">
          <button type="button" className="btn btn-small btn-ghost" disabled={index === 0} onClick={() => onMove(-1)} title="Monter">
            <Icon name="chevron-down" className="icon-flip-y" />
          </button>
          <button type="button" className="btn btn-small btn-ghost" disabled={index === total - 1} onClick={() => onMove(1)} title="Descendre">
            <Icon name="chevron-down" />
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={onRemove} title="Supprimer la section">
            <Icon name="trash" />
          </button>
        </div>
      </div>

      {section.blocks.map((block, bi) => (
        <BlockEditor
          key={block.blockId}
          block={block}
          variables={variables}
          focusRef={focusRef}
          onChange={(b) => setBlock(bi, b)}
          onRemove={() => onChange({ ...section, blocks: section.blocks.filter((_, i) => i !== bi) })}
        />
      ))}

      <div className="legal-block-add">
        {(['PARAGRAPH', 'LIST', 'FIELDS'] as const).map((type) => (
          <button
            key={type}
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => onChange({ ...section, blocks: [...section.blocks, emptyBlock(type)] })}
          >
            <Icon name="plus-lg" /> {BLOCK_LABEL[type]}
          </button>
        ))}
      </div>
    </div>
  );
}

const BLOCK_LABEL = {
  PARAGRAPH: 'Paragraphe',
  LIST: 'Liste',
  FIELDS: "Bloc d'informations",
} as const;

const BLOCK_HINT = {
  PARAGRAPH: 'Un texte suivi.',
  LIST: 'Des puces.',
  FIELDS: 'Des lignes « libellé : valeur ». Chaque ligne disparaît seule si sa donnée manque.',
} as const;

function BlockEditor({
  block, variables, focusRef, onChange, onRemove,
}: {
  block: LegalBlock;
  variables: LegalVariableRegistry['variables'];
  focusRef: FocusRef;
  onChange: (b: LegalBlock) => void;
  onRemove: () => void;
}) {
  /**
   * LA LIAISON DU FOCUS PASSE PAR L'ÉVÉNEMENT, PAS PAR LA `ref`.
   *
   * Une `ref` est posée au montage, pour tous les champs à la fois : le dernier
   * monté gagnerait, et l'insertion tomberait toujours dans le même bloc. Le
   * focus, lui, désigne exactement celui où le curseur se trouve.
   */
  const onFocusField = (el: HTMLTextAreaElement | null, apply: (v: string) => void) => {
    focusRef.current = { el, apply };
  };

  return (
    <div className="legal-block">
      <div className="legal-block-head">
        <span className="legal-block-type">{BLOCK_LABEL[block.type]}</span>
        <span className="muted legal-block-hint">{BLOCK_HINT[block.type]}</span>
        <button type="button" className="btn btn-small btn-ghost" onClick={onRemove} title="Supprimer le bloc">
          <Icon name="x-lg" />
        </button>
      </div>

      {block.type === 'PARAGRAPH' && (
        <FocusableToken
          value={block.text}
          variables={variables}
          ariaLabel="Texte du paragraphe"
          placeholder="Écrivez le texte, puis insérez les données avec « + Insérer une donnée »."
          onChange={(v) => onChange({ ...block, text: v })}
          onFocusField={onFocusField}
          applyFactory={(next) => onChange({ ...block, text: next })}
        />
      )}

      {block.type === 'LIST' && (
        <div className="legal-list-items">
          {block.items.map((item, i) => (
            <div key={i} className="legal-list-item">
              <span className="legal-list-bullet">•</span>
              <FocusableToken
                value={item}
                variables={variables}
                ariaLabel={`Puce ${i + 1}`}
                placeholder="Élément de liste"
                rows={2}
                onChange={(v) => onChange({ ...block, items: block.items.map((it, k) => (k === i ? v : it)) })}
                onFocusField={onFocusField}
                applyFactory={(next) => onChange({
                  ...block,
                  items: block.items.map((it, k) => (k === i ? next : it)),
                })}
              />
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== i) })}
                title="Retirer la puce"
              >
                <Icon name="x-lg" />
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onChange({ ...block, items: [...block.items, ''] })}>
            <Icon name="plus-lg" /> Ajouter une puce
          </button>
        </div>
      )}

      {block.type === 'FIELDS' && (
        <div className="legal-fields-items">
          {block.fields.map((field, i) => (
            <div key={i} className="legal-fields-row">
              <input
                type="text"
                className="legal-fields-label"
                value={field.label}
                placeholder="Libellé — ex. « SIRET »"
                aria-label={`Libellé ${i + 1}`}
                onChange={(e) => onChange({
                  ...block,
                  fields: block.fields.map((f, k) => (k === i ? { ...f, label: e.target.value } : f)),
                })}
              />
              <FocusableToken
                value={field.value}
                variables={variables}
                singleLine
                ariaLabel={`Valeur ${i + 1}`}
                placeholder="Valeur ou donnée insérée"
                onChange={(v) => onChange({
                  ...block,
                  fields: block.fields.map((f, k) => (k === i ? { ...f, value: v } : f)),
                })}
                onFocusField={onFocusField}
                applyFactory={(next) => onChange({
                  ...block,
                  fields: block.fields.map((f, k) => (k === i ? { ...f, value: next } : f)),
                })}
              />
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => onChange({ ...block, fields: block.fields.filter((_, k) => k !== i) })}
                title="Retirer la ligne"
              >
                <Icon name="x-lg" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => onChange({ ...block, fields: [...block.fields, { label: '', value: '' }] })}
          >
            <Icon name="plus-lg" /> Ajouter une ligne
          </button>
        </div>
      )}
    </div>
  );
}

/** Un `TokenField` qui s'annonce comme cible d'insertion au focus. */
function FocusableToken({
  value, variables, ariaLabel, placeholder, rows, singleLine, onChange, onFocusField, applyFactory,
}: {
  value: string;
  variables: LegalVariableRegistry['variables'];
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  singleLine?: boolean;
  onChange: (v: string) => void;
  onFocusField: (el: HTMLTextAreaElement | null, apply: (v: string) => void) => void;
  applyFactory: (next: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <TokenField
      value={value}
      variables={variables}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      rows={rows}
      singleLine={singleLine}
      onChange={onChange}
      inputRef={(el) => { ref.current = el; }}
      onFocus={() => onFocusField(ref.current, applyFactory)}
    />
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export default LegalDocumentsPage;
