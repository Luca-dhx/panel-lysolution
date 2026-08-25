import { Icon } from '@/components/Icon';
import type { LegalCompleteness, ResolvedLegalDocument } from '@/types.legal';

/**
 * L'APERÇU — le document tel que le site l'affichera, avec de vraies données.
 *
 * ══ IL REND LE MÊME OBJET QUE LA VITRINE ══════════════════════════════════
 *
 * `ResolvedLegalDocument` est exactement la charge utile que le pont
 * transporte. L'aperçu n'a donc rien à interpréter, rien à recomposer, et
 * surtout aucune règle à réimplémenter : un bloc absent ici est un bloc que le
 * résolveur a retiré, pour la même raison, avec le même code.
 *
 * C'est ce qui rend la promesse tenable — « ce que vous relisez est ce qui
 * partira ». Un aperçu qui aurait son propre rendu finirait par mentir, et
 * l'on publierait à l'aveugle en croyant l'inverse.
 *
 * ══ LES DONNÉES MANQUANTES SONT ANNONCÉES, PAS DEVINÉES ═══════════════════
 *
 * Un bloc retiré est INVISIBLE : c'est le but, et c'est aussi le piège. Sans
 * le décompte au-dessus, rien ne distinguerait « ce template ne parle pas de
 * TVA » de « le numéro de TVA de ce client n'est pas renseigné ». Le bandeau
 * de complétude est donc affiché AVANT le document, jamais après.
 */

interface DocumentPreviewProps {
  document: ResolvedLegalDocument | null;
  completeness: LegalCompleteness | null;
  projectName?: string | null;
  loading?: boolean;
  /** Ouvre la fiche à corriger — l'avertissement doit mener quelque part. */
  onFixSource?: (source: string) => void;
}

const SOURCE_FIX_LABEL: Record<string, string> = {
  CLIENT: "Compléter l'entreprise cliente",
  DEVELOPER: 'Compléter « Mon entreprise »',
  HOST: "Compléter l'hébergeur",
};

export function DocumentPreview({
  document, completeness, projectName, loading = false, onFixSource,
}: DocumentPreviewProps) {
  if (loading) return <p className="muted">Résolution du document…</p>;

  if (!document) {
    return (
      <div className="legal-preview-empty">
        <Icon name="eye" />
        <p><strong>Choisissez un projet</strong></p>
        <p className="muted">
          Le document s’affichera avec les vraies données de l’entreprise, du concepteur et de
          l’hébergeur.
        </p>
      </div>
    );
  }

  const missing = completeness?.missing ?? [];
  const sources = [...new Set(missing.map((m) => m.source))];

  return (
    <div className="legal-preview">
      {completeness && (
        <div className={`legal-completeness ${missing.length ? 'is-warn' : 'is-ok'}`}>
          <p className="legal-completeness-head">
            <Icon name={missing.length ? 'exclamation-triangle' : 'check-circle'} />
            <strong>Complétude juridique</strong>
            <span>{completeness.available} / {completeness.total} champs disponibles</span>
          </p>
          {missing.length > 0 && (
            <>
              <ul className="legal-completeness-list">
                {missing.map((field) => (
                  <li key={field.key}>
                    {field.label}
                    <span className="muted"> — {sourceName(field.source)}</span>
                    {field.required && <span className="legal-chip is-warn">obligatoire</span>}
                  </li>
                ))}
              </ul>
              <p className="muted legal-completeness-note">
                Les blocs qui utilisent ces données sont retirés du document : rien n’est affiché à
                leur place.
              </p>
              {onFixSource && (
                <div className="legal-completeness-actions">
                  {sources.map((source) => (
                    <button
                      key={source}
                      type="button"
                      className="btn btn-small"
                      onClick={() => onFixSource(source)}
                    >
                      {SOURCE_FIX_LABEL[source] ?? 'Compléter'}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/*
        LE RENDU LUI-MÊME — largeur de lecture confortable, hiérarchie claire.

        Il ne reprend PAS le design d'une vitrine : chaque site a le sien, et
        imiter l'un d'eux ferait croire que le document en dépend. Ce qu'on
        vérifie ici est le CONTENU et les VALEURS, pas la typographie du client.
      */}
      <article className="legal-doc">
        <header className="legal-doc-head">
          <h1>{document.title}</h1>
          {projectName && <p className="muted">Données de « {projectName} »</p>}
        </header>

        {document.sections.length === 0 && (
          <p className="alert alert-warning">
            Aucune section ne peut être rendue : toutes les données utilisées manquent.
          </p>
        )}

        {document.sections.map((section, i) => (
          <section key={`${section.heading}-${i}`} className="legal-doc-section">
            {section.heading && <h2>{section.heading}</h2>}
            {section.blocks.map((block, j) => {
              if (block.type === 'PARAGRAPH') {
                return <p key={j}>{block.text}</p>;
              }
              if (block.type === 'LIST') {
                return (
                  <ul key={j}>
                    {block.items.map((item, k) => <li key={k}>{item}</li>)}
                  </ul>
                );
              }
              return (
                <dl key={j} className="legal-doc-fields">
                  {block.items.map((item, k) => (
                    <div key={k}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              );
            })}
          </section>
        ))}
      </article>
    </div>
  );
}

function sourceName(source: string): string {
  if (source === 'CLIENT') return 'entreprise cliente';
  if (source === 'DEVELOPER') return 'notre entreprise';
  return 'hébergeur';
}

export default DocumentPreview;
