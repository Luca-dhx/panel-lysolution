import { useEffect, useMemo, useRef, useState } from 'react';

import { Card, EmptyState } from '@/components/ui';
import { useToast } from '@/components/ToastProvider';
import { ApiError, api, errorMessage } from '@/lib/api';
import {
  changedFields,
  draftFromTemplate,
  EDITOR_TABS,
  groupErrors,
  insertVariable,
  isSenderMissing,
  isTemplateDirty,
  previewWidth,
  readinessCodeLabel,
  TAB_LABEL,
  validationSummary,
  variableTypeLabel,
  variableUsage,
  versionOriginLabel,
  type EditorTab,
  type PreviewDevice,
} from '@/lib/emailTemplates';
import type {
  EmailTemplateDetail,
  EmailTemplateDraft,
  EmailTemplatePreview,
  EmailTemplateReadiness,
  EmailTemplateScope,
  EmailTemplateScopeRef,
  EmailTemplateSummary,
  EmailTemplateVersionDetail,
  EmailTemplateVersionSummary,
} from '@/types.emailTemplates';

const PREVIEW_DEBOUNCE_MS = 400;

/** La portée par défaut de l'écran — celle de L.Y Solution, jamais un client. */
const PANEL_SCOPE: EmailTemplateScopeRef = { scopeType: 'PANEL' };

/**
 * Clé de RECHARGEMENT d'une portée — pour les dépendances de `useEffect`.
 *
 * Un objet de portée est recréé à chaque rendu ; l'utiliser tel quel en
 * dépendance rechargerait en boucle. Une clé textuelle change exactement quand
 * la portée change, ce qui est la sémantique voulue : changer de projet DOIT
 * relire le modèle, sinon l'écran montrerait le contenu du précédent.
 */
function scopeKeyOf(scope: EmailTemplateScopeRef): string {
  return scope.scopeType === 'PROJECT' ? `PROJECT:${scope.scopeId}` : 'PANEL';
}

/** Le badge de portée — présent partout où un contenu s'affiche. */
function ScopeBadge({ scope, label }: { scope: EmailTemplateScopeRef; label?: string }) {
  const project = scope.scopeType === 'PROJECT';
  return (
    <span className={`template-scope-badge ${project ? 'is-project' : 'is-panel'}`}>
      {project ? (label ?? scope.scopeId) : (label ?? 'Panel — L.Y Solution')}
    </span>
  );
}

function PreviewFrame({ html, device }: { html: string; device: PreviewDevice }) {
  return (
    <div className="template-preview-shell">
      <iframe
        key={device}
        title="Apercu du template"
        srcDoc={html}
        sandbox=""
        referrerPolicy="no-referrer"
        className="template-preview-frame"
        style={{ width: previewWidth(device) }}
      />
    </div>
  );
}

function ValidationPanel({
  validation,
}: {
  validation: EmailTemplatePreview['validation'] | EmailTemplateDetail['validation'];
}) {
  if (validation.valid) return <p className="template-ok">Template valide.</p>;

  return (
    <div className="template-validation-list">
      {groupErrors(validation.errors).map((group) => (
        <div key={group.code} className="template-validation-group">
          <p className="template-validation-title">{group.label}</p>
          <ul>
            {group.items.map((item, index) => (
              <li key={`${group.code}-${index}`}>
                {item.line ? `Ligne ${item.line} - ` : ''}
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ReadinessPanel({ readiness }: { readiness: EmailTemplateReadiness | null }) {
  if (!readiness) return <p className="muted">Lecture…</p>;

  return (
    <div className="template-readiness">
      <p className="muted">
        {readiness.context.provider}
        {readiness.context.providerMode ? ` - ${readiness.context.providerMode}` : ''}
      </p>
      {readiness.blockers.map((item) => (
        <div key={item.code} className="alert alert-error">
          <strong>{readinessCodeLabel(item.code)}</strong> - {item.message}
        </div>
      ))}
      {readiness.warnings.map((item) => (
        <div key={item.code} className="alert alert-warning">
          <strong>{readinessCodeLabel(item.code)}</strong> - {item.message}
        </div>
      ))}
      {readiness.ready ? <p className="template-ok">Pret a envoyer.</p> : null}
    </div>
  );
}

function VariablesTab({
  draft,
  template,
  onInsert,
}: {
  draft: EmailTemplateDraft;
  template: EmailTemplateDetail;
  onInsert: (key: string) => void;
}) {
  const usage = variableUsage(draft, template.variables);

  return (
    <div className="template-variable-list">
      {template.variables.map((variable) => {
        const state = usage.find((item) => item.key === variable.key);
        return (
          <div key={variable.key} className="template-variable-card">
            <div>
              <p className="template-code">{`{{${variable.key}}}`}</p>
              <p><strong>{variable.label}</strong></p>
              <p className="muted">{variable.description}</p>
              <p className="muted">
                {variableTypeLabel(variable.type)}
                {variable.required ? ' - obligatoire' : ' - facultative'}
                {state?.missing ? ' - absente du contenu' : state?.used ? ' - utilisee' : ' - non utilisee'}
              </p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => onInsert(variable.key)}>
              Inserer
            </button>
          </div>
        );
      })}
    </div>
  );
}

function GuideTab() {
  return (
    <Card title="Guide du template">
      <ul className="template-guide-list">
        <li>Le sujet et le HTML sont les seuls champs edites. Les identifiants de template viennent du code.</li>
        <li>Le HTML est libre mais controle: balises actives, attributs dangereux et variables inconnues sont refuses.</li>
        <li>Les apercus et tests utilisent uniquement des donnees de demonstration definies dans le registre du Panel.</li>
        <li>Un template desactive ou invalide ne part jamais: l’envoi est refuse explicitement.</li>
      </ul>
    </Card>
  );
}

/**
 * L'ÉDITEUR — TOUJOURS DANS UNE PORTÉE, jamais « en général » (L11.1).
 *
 * `scope` traverse chaque appel : lecture, aperçu, readiness, test, historique,
 * restauration. Un seul appel qui l'oublierait afficherait le contenu du Panel
 * en laissant croire qu'on édite celui d'un client — c'est le défaut exact que
 * ce lot répare, et il se reproduirait par simple distraction.
 */
function TemplateEditor({ templateId, scope, onBack }: {
  templateId: string;
  scope: EmailTemplateScopeRef;
  onBack: () => void;
}) {
  const toast = useToast();
  const htmlRef = useRef<HTMLTextAreaElement | null>(null);
  const scopeKey = scopeKeyOf(scope);

  const [template, setTemplate] = useState<EmailTemplateDetail | null>(null);
  const [draft, setDraft] = useState<EmailTemplateDraft | null>(null);
  const [baseline, setBaseline] = useState<EmailTemplateDraft | null>(null);
  const [preview, setPreview] = useState<EmailTemplatePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [readiness, setReadiness] = useState<EmailTemplateReadiness | null>(null);
  const [versions, setVersions] = useState<EmailTemplateVersionSummary[]>([]);
  const [versionPreview, setVersionPreview] = useState<EmailTemplateVersionDetail | null>(null);
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [tab, setTab] = useState<EditorTab>('editor');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTemplate, nextReadiness] = await Promise.all([
        api.getEmailTemplate(templateId, scope),
        api.getEmailTemplateReadiness(templateId, scope),
      ]);
      const nextDraft = draftFromTemplate(nextTemplate);
      setTemplate(nextTemplate);
      setDraft(nextDraft);
      setBaseline(nextDraft);
      setReadiness(nextReadiness);
    } catch (err) {
      setError(errorMessage(err, 'Lecture du template impossible.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [templateId, scopeKey]);

  useEffect(() => {
    if (!draft) return undefined;
    let cancelled = false;
    setPreviewing(true);
    const timer = window.setTimeout(async () => {
      try {
        const nextPreview = await api.previewEmailTemplate(templateId, {
          subject: draft.subject,
          html: draft.html,
        }, scope);
        if (!cancelled) setPreview(nextPreview);
      } catch {
        // Le dernier apercu exploitable reste affiche.
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [templateId, scopeKey, draft?.subject, draft?.html]);

  useEffect(() => {
    if (!baseline || !draft || !isTemplateDirty(draft, baseline)) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [baseline, draft]);

  const dirty = Boolean(draft && baseline && isTemplateDirty(draft, baseline));
  const validation = preview?.validation ?? template?.validation ?? { valid: true, errors: [] };

  const back = () => {
    if (dirty && !window.confirm('Abandonner les modifications non enregistrees ?')) return;
    onBack();
  };

  const save = async () => {
    if (!draft || !baseline || !template) return;
    const patch = changedFields(draft, baseline);
    if (Object.keys(patch).length === 0) {
      toast.success('Aucune modification a enregistrer.');
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateEmailTemplate(templateId, {
        ...patch,
        expectedVersion: template.version,
      }, scope);
      const nextDraft = draftFromTemplate(updated);
      setTemplate(updated);
      setDraft(nextDraft);
      setBaseline(nextDraft);
      setReadiness(await api.getEmailTemplateReadiness(templateId, scope));
      toast.success('Template enregistre.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error('Conflit de version: rechargez le template avant de reessayer.');
      } else {
        toast.error(errorMessage(err, 'Enregistrement refuse.'));
      }
    } finally {
      setSaving(false);
    }
  };

  const insertAtCursor = (key: string) => {
    if (!draft) return;
    const node = htmlRef.current;
    const start = node?.selectionStart ?? draft.html.length;
    const end = node?.selectionEnd ?? start;
    const next = insertVariable(draft.html, start, end, key);
    setDraft({ ...draft, html: next.text });
    setTab('editor');
    window.requestAnimationFrame(() => {
      if (!htmlRef.current) return;
      htmlRef.current.focus();
      htmlRef.current.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const openVersions = async () => {
    setTab('versions');
    if (versions.length > 0) return;
    setLoadingVersions(true);
    try {
      setVersions(await api.listEmailTemplateVersions(templateId, scope));
    } catch (err) {
      toast.error(errorMessage(err, 'Lecture de l’historique impossible.'));
    } finally {
      setLoadingVersions(false);
    }
  };

  const previewVersion = async (version: number) => {
    try {
      setVersionPreview(await api.getEmailTemplateVersion(templateId, version, scope));
    } catch (err) {
      toast.error(errorMessage(err, 'Lecture de la version impossible.'));
    }
  };

  const restore = async (version: number) => {
    if (!window.confirm(`Restaurer la version ${version} ?`)) return;
    try {
      const restored = await api.restoreEmailTemplateVersion(templateId, version, scope);
      const nextDraft = draftFromTemplate(restored);
      setTemplate(restored);
      setDraft(nextDraft);
      setBaseline(nextDraft);
      setVersions([]);
      setVersionPreview(null);
      setReadiness(await api.getEmailTemplateReadiness(templateId, scope));
      toast.success(`Version ${version} restauree.`);
    } catch (err) {
      toast.error(errorMessage(err, 'Restauration impossible.'));
    }
  };

  const sendTest = async () => {
    if (!testEmail.trim()) {
      toast.error('Indiquez une adresse destinataire.');
      return;
    }
    setSendingTest(true);
    try {
      const result = await api.sendEmailTemplateTest(templateId, testEmail.trim(), scope);
      toast.success(result.message);
    } catch (err) {
      toast.error(errorMessage(err, 'Envoi de test refuse.'));
    } finally {
      setSendingTest(false);
    }
  };

  const usedSampleVariables = useMemo(
    () => Object.entries(preview?.sampleVariables ?? {}),
    [preview],
  );

  if (loading || !template || !draft) return <p className="muted">Chargement du template…</p>;

  return (
    <div className="page">
      <header className="page-header">
        <button type="button" className="btn btn-secondary btn-small" onClick={back}>
          Retour aux templates
        </button>
        <h1>{draft.name}</h1>
        <p className="page-description">
          <ScopeBadge scope={scope} label={template.scope.label} />
          {' '}
          <span className="template-code">{template.templateId}</span> - v{template.version} - {template.variables.length} variable(s)
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {/*
        AUCUNE INSTANCE DANS CETTE PORTÉE — le dire, et dire ce que ça implique.
        Le contenu affiché est un POINT DE DÉPART tiré du registre : tant qu'il
        n'est pas enregistré, un envoi dans cette portée échoue. Le masquer
        derrière un contenu d'apparence normale recréerait exactement l'illusion
        que ce lot supprime — un éditeur qui montre autre chose que ce qui part.
      */}
      {template.declared === false ? (
        <div className="alert alert-muted">
          Ce projet <strong>ne déclare plus</strong> utiliser ce modèle. Son
          contenu est conservé et reste modifiable, mais tout envoi est refusé
          tant qu’un consommateur ne le redéclare pas côté projet.
        </div>
      ) : null}
      {!template.configured && template.declared !== false && scope.scopeType === 'PROJECT' ? (
        <div className="alert alert-warning">
          Ce projet n’a <strong>aucun modèle « {template.templateId} »</strong>. Le contenu ci-dessous
          est un point de départ proposé : tant qu’il n’est pas enregistré, tout envoi de ce modèle
          pour ce projet est <strong>refusé</strong>. Le contenu du Panel n’est jamais servi à sa place.
        </div>
      ) : null}
      {isSenderMissing(readiness) ? (
        <div className="alert alert-error">
          Aucun expediteur global n’est exploitable: le test d’envoi et l’envoi reel resteront refuses.
        </div>
      ) : null}

      <div className="template-topbar">
        <span className={`badge ${validation.valid ? 'badge-ok' : 'badge-warn'}`}>
          {validationSummary(validation)}
        </span>
        <div className="action-buttons">
          <button type="button" className="btn btn-secondary btn-small" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void openVersions()}>
            Historique
          </button>
        </div>
      </div>

      <div className="template-tabs">
        {EDITOR_TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? 'template-tab template-tab-active' : 'template-tab'}
            onClick={() => (item === 'versions' ? void openVersions() : setTab(item))}
          >
            {TAB_LABEL[item]}
          </button>
        ))}
      </div>

      {tab === 'editor' ? (
        <div className="template-grid">
          <div className="template-main">
            <Card title="Sujet">
              <label className="field">
                <span className="field-label">Sujet de l’e-mail</span>
                <input value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} />
              </label>
            </Card>
            <Card title="HTML">
              <label className="field">
                <span className="field-label">Contenu HTML complet</span>
                <textarea
                  ref={htmlRef}
                  className="template-html-input"
                  spellCheck={false}
                  value={draft.html}
                  onChange={(event) => setDraft({ ...draft, html: event.target.value })}
                />
              </label>
            </Card>
          </div>

          <div className="template-side">
            <Card title="Parametres">
              <label className="field">
                <span className="field-label">Nom</span>
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Description</span>
                <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              </label>
              <label className="field-inline">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                <span>Template actif</span>
              </label>
            </Card>
            <Card title="Validation">
              <ValidationPanel validation={validation} />
            </Card>
            <Card title="Readiness">
              <ReadinessPanel readiness={readiness} />
            </Card>
            <Card title="Envoyer un test">
              <label className="field">
                <span className="field-label">Destinataire</span>
                <input type="email" value={testEmail} placeholder="vous@exemple.fr" onChange={(event) => setTestEmail(event.target.value)} />
              </label>
              <div className="action-buttons">
                <button type="button" className="btn btn-small" onClick={sendTest} disabled={sendingTest}>
                  {sendingTest ? 'Envoi…' : 'Envoyer le test'}
                </button>
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'preview' ? (
        <div className="template-preview-panel">
          <div className="template-preview-toolbar">
            <div className="action-buttons">
              <button type="button" className={device === 'desktop' ? 'btn btn-small' : 'btn btn-secondary btn-small'} onClick={() => setDevice('desktop')}>
                Bureau
              </button>
              <button type="button" className={device === 'mobile' ? 'btn btn-small' : 'btn btn-secondary btn-small'} onClick={() => setDevice('mobile')}>
                Mobile
              </button>
            </div>
            <p className="muted">{previewing ? 'Mise a jour…' : `${previewWidth(device)} px`}</p>
          </div>

          {preview?.subject ? (
            <Card title="Sujet rendu">
              <p>{preview.subject}</p>
            </Card>
          ) : null}

          {preview?.html ? (
            <PreviewFrame html={preview.html} device={device} />
          ) : (
            <Card title="Aucun apercu">
              <ValidationPanel validation={validation} />
              {preview?.renderError ? <div className="alert alert-error">{preview.renderError.message}</div> : null}
            </Card>
          )}

          {usedSampleVariables.length > 0 ? (
            <Card title="Variables de demonstration">
              <ul className="template-sample-list">
                {usedSampleVariables.map(([key, value]) => (
                  <li key={key}>
                    <span className="template-code">{key}</span>
                    <span>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'variables' ? (
        <VariablesTab draft={draft} template={template} onInsert={insertAtCursor} />
      ) : null}

      {tab === 'versions' ? (
        <div className="template-grid">
          <Card title="Historique" className="template-main">
            {loadingVersions ? <p className="muted">Lecture de l’historique…</p> : null}
            {!loadingVersions && versions.length === 0 ? <p className="muted">Aucune version enregistree.</p> : null}
            <div className="template-version-list">
              {versions.map((version) => (
                <div key={version.version} className="template-version-card">
                  <div>
                    <p><strong>v{version.version}</strong> - {versionOriginLabel(version.origin)}</p>
                    <p className="muted">
                      {new Date(version.createdAt).toLocaleString('fr-FR')}
                      {version.changedByLabel ? ` - ${version.changedByLabel}` : ''}
                      {version.restoredFromVersion ? ` - depuis v${version.restoredFromVersion}` : ''}
                    </p>
                  </div>
                  <div className="action-buttons">
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => void previewVersion(version.version)}>
                      Apercu
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => void restore(version.version)}>
                      Restaurer
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title={versionPreview ? `Version ${versionPreview.version}` : 'Apercu de version'} className="template-side">
            {versionPreview ? (
              <>
                <p className="muted">{validationSummary(versionPreview.validation)}</p>
                <ValidationPanel validation={versionPreview.validation} />
                <PreviewFrame html={versionPreview.html} device="desktop" />
              </>
            ) : (
              <p className="muted">Choisissez une version a previsualiser.</p>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'guide' ? <GuideTab /> : null}
    </div>
  );
}

export function EmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplateSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * LES PORTÉES VIENNENT DU SERVEUR, PAS DE L'ÉCRAN (L11.1).
   *
   * Un sélecteur peuplé côté client serait un sélecteur dont un utilisateur
   * peut inventer les entrées. Le serveur énumère ce que ce compte administre —
   * le Panel DEV administre tout le parc — et refuse de toute façon toute
   * portée dont le projet n'existe pas au registre.
   */
  const [scopes, setScopes] = useState<EmailTemplateScope[]>([]);
  const [scope, setScope] = useState<EmailTemplateScopeRef>(PANEL_SCOPE);
  const scopeKey = scopeKeyOf(scope);
  const currentScope = scopes.find(
    (item) => scopeKeyOf(
      item.scopeType === 'PROJECT'
        ? { scopeType: 'PROJECT', scopeId: item.scopeId as string }
        : { scopeType: 'PANEL' },
    ) === scopeKey,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listEmailTemplateScopes();
        if (!cancelled) setScopes(result);
      } catch {
        // Le sélecteur reste sur la seule portée sûre : celle du Panel.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.listEmailTemplates(scope);
        if (!cancelled) setTemplates(result);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Lecture des templates impossible.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selected, scopeKey]);

  if (selected) {
    return <TemplateEditor templateId={selected} scope={scope} onBack={() => setSelected(null)} />;
  }

  const onScopeChange = (value: string) => {
    setSelected(null);
    setScope(value === 'PANEL' ? PANEL_SCOPE : { scopeType: 'PROJECT', scopeId: value });
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Templates e-mail</h1>
        <p className="page-description">
          Contenu des e-mails du parc, par PORTÉE. Le Panel possède ses propres modèles ;
          chaque projet possède les siens. Un même code peut exister dans plusieurs portées,
          avec des sujets et des HTML entièrement différents — ce sont des documents distincts.
        </p>
      </header>

      {/*
        LE SÉLECTEUR DE PORTÉE — la surface qui manquait, et dont l'absence
        faisait tout le défaut : le modèle « par projet » existait en base
        depuis toujours, mais aucun écran ne permettait d'en écrire un. Un
        héritage qu'aucune interface ne peut rompre n'est pas un héritage.
      */}
      <Card title="Portée">
        <div className="template-scope-picker">
          <label htmlFor="template-scope">Contenu de</label>
          <select
            id="template-scope"
            value={scope.scopeType === 'PROJECT' ? scope.scopeId : 'PANEL'}
            onChange={(event) => onScopeChange(event.target.value)}
          >
            <option value="PANEL">Panel — L.Y Solution</option>
            {scopes
              .filter((item) => item.scopeType === 'PROJECT')
              .map((item) => (
                <option key={item.scopeId as string} value={item.scopeId as string}>
                  {item.label}
                </option>
              ))}
          </select>
          <ScopeBadge scope={scope} label={currentScope?.label} />
        </div>
        <p className="muted">
          {scope.scopeType === 'PANEL'
            ? 'Modèles appartenant à L.Y Solution : facturation, notifications internes, tests d’expéditeur. Ils survivent à la résiliation de tout projet.'
            : 'Modèles appartenant à ce projet. C’est le PROJET qui déclare ceux qu’il utilise : le Panel s’y conforme, il ne les devine pas.'}
        </p>
        {/*
          CE QUE LE PROJET DÉCLARE — l'information qui manquait à cet écran.
          « jamais déclaré » et « déclare zéro modèle » n'appellent pas la même
          réaction : le premier veut dire que le projet n'a pas encore parlé.
        */}
        {scope.scopeType === 'PROJECT' && currentScope ? (
          currentScope.declaration ? (
            <p className="muted">
              <strong>{currentScope.declaration.count} modèle(s) utilisé(s)</strong>
              {currentScope.declaration.declaredAt
                ? ` — dernière déclaration le ${new Date(currentScope.declaration.declaredAt).toLocaleString('fr-FR')}`
                : null}
              {currentScope.declaration.unknown.length > 0 ? (
                <>
                  {' · '}
                  <span className="badge badge-warn">
                    {currentScope.declaration.unknown.length} demandé(s) mais inconnu(s) de cette version du Panel
                  </span>
                </>
              ) : null}
            </p>
          ) : (
            <p className="muted">
              <span className="badge badge-muted">Aucune déclaration reçue</span>{' '}
              Ce projet n’a pas encore annoncé les modèles qu’il utilise — il n’a
              probablement pas démarré depuis la mise en place de la déclaration.
            </p>
          )
        ) : null}
      </Card>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {loading ? (
        <p className="muted">Chargement des templates…</p>
      ) : templates.length === 0 ? (
        <EmptyState
          title="Aucun template dans cette portée"
          hint="Les modèles du Panel sont posés au démarrage du backend. Les modèles d’un projet sont posés à sa migration."
        />
      ) : (
        <Card title={
          scope.scopeType === 'PROJECT' && templates.some((t) => t.declared === false)
            ? `Modèles utilisés (${templates.filter((t) => t.declared !== false).length})`
            : 'Catalogue des templates'
        }>
          <div className="template-list">
            {/*
              LES MODÈLES QUE LE PROJET N'UTILISE PLUS SONT RANGÉS À PART, pas
              masqués : leur contenu a été écrit par quelqu'un, il reste
              consultable et modifiable. Les mêler aux actifs ferait croire à
              huit modèles en service là où il y en a deux.
            */}
            {templates.filter((t) => t.declared !== false).map((template) => (
              <button
                key={template.templateId}
                type="button"
                className="template-list-item"
                onClick={() => setSelected(template.templateId)}
              >
                <div>
                  <p><strong>{template.name}</strong></p>
                  <p className="muted">{template.description}</p>
                  <p className="template-code">{template.templateId}</p>
                </div>
                <div className="template-list-meta">
                  {/*
                    « Non configuré » passe AVANT « valide » : un modèle
                    syntaxiquement irréprochable qui n'existe pas dans cette
                    portée n'enverra rien. Afficher « Valide » en premier
                    rassurerait à tort.
                  */}
                  {!template.configured ? (
                    <span className="badge badge-warn">Non configuré</span>
                  ) : (
                    <span className={`badge ${template.valid ? 'badge-ok' : 'badge-warn'}`}>
                      {template.valid ? 'Valide' : `${template.errorCount} erreur(s)`}
                    </span>
                  )}
                  {!template.enabled ? <span className="badge badge-muted">Inactif</span> : null}
                  <span className="muted">{template.variableCount} var.</span>
                  <span className="muted">{template.configured ? `v${template.version}` : '—'}</span>
                </div>
              </button>
            ))}
          </div>

          {templates.some((t) => t.declared === false) ? (
            <details className="template-retired">
              <summary>
                Modèles précédemment utilisés ({templates.filter((t) => t.declared === false).length})
              </summary>
              <p className="muted">
                Ce projet ne les déclare plus : leurs instances sont ARCHIVÉES. Leur
                contenu et leur historique sont CONSERVÉS — s’il les réutilise, il les
                retrouvera tels quels, à la version où ils avaient été laissés. Tout
                envoi de ces modèles est refusé tant qu’ils ne sont pas redéclarés, et
                ils ne figurent plus dans ce que le projet consulte.
              </p>
              <div className="template-list">
                {templates.filter((t) => t.declared === false).map((template) => (
                  <button
                    key={template.templateId}
                    type="button"
                    className="template-list-item"
                    onClick={() => setSelected(template.templateId)}
                  >
                    <div>
                      <p><strong>{template.name}</strong></p>
                      <p className="template-code">{template.templateId}</p>
                    </div>
                    <div className="template-list-meta">
                      <span className="badge badge-muted">
                        {template.archived ? 'Archivé' : 'Non utilisé'}
                      </span>
                      <span className="muted">{template.configured ? `v${template.version}` : '—'}</span>
                    </div>
                  </button>
                ))}
              </div>
            </details>
          ) : null}
        </Card>
      )}
    </div>
  );
}

export default EmailTemplatesPage;
