/**
 * IMPORTER UN PROSPECT DEPUIS UN FICHIER JSON.
 *
 * ══ POURQUOI UN APERÇU, ET POURQUOI IL EST OBLIGATOIRE ══════════════════════
 *
 * Un import écrit dans TROIS collections d'un coup : la fiche, l'échéancier et
 * l'agenda. C'est le geste le plus large de tout le carnet commercial, et c'est
 * aussi le seul dont le contenu vient d'ailleurs — un fichier écrit par
 * quelqu'un d'autre, souvent depuis un tableur.
 *
 * Sans aperçu, la seule façon de savoir ce qu'un fichier contient serait de
 * l'importer, puis de relire la fiche. Une colonne mal nommée, une accroche
 * collée dans la mauvaise ligne, un statut « signé » saisi par erreur : on s'en
 * apercevrait après, et il faudrait défaire à la main ce qu'on venait de faire
 * en un clic.
 *
 * L'aperçu est donc calculé par le SERVEUR, contre l'état réel de la fiche, et
 * il montre trois choses par section : ce qui s'AJOUTE, ce qui CHANGE (avec sa
 * valeur d'avant), et ce qui est RETIRÉ.
 *
 * ══ LE PLAN AFFICHÉ N'EST PAS CELUI QUI S'EXÉCUTE ══════════════════════════
 *
 * On ne renvoie jamais le plan au serveur pour qu'il l'applique : il le
 * recalcule. Confirmer n'est pas transporter une écriture, c'est l'autoriser —
 * et entre l'aperçu et le clic, un autre poste a pu toucher la fiche.
 *
 * ══ CE QUE LE PANEL N'A PAS SU LIRE EST MONTRÉ, PAS TU ═════════════════════
 *
 * Une clef inconnue n'est jamais devinée : le carnet se remplirait de `rowId`
 * et de `scrapedAt`. Elle apparaît dans « non repris », avec sa raison, ce qui
 * permet de corriger LA SOURCE plutôt que la fiche — la seule correction qui
 * vaille quand le fichier suivant arrive avec quarante entreprises.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/base/badges/badges';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Icon } from '@/components/Icon';
import { api, errorMessage } from '@/lib/api';
import type {
  Prospect, ProspectImportMode, ProspectImportPlan, ProspectImportSection,
} from '@/types.prospection';

/**
 * EXTRAIRE LES FICHES D'UN FICHIER — une, ou quarante.
 *
 * Le miroir exact de `extraireFiches` côté serveur, et il est ici PARCE QUE
 * c'est ici qu'on choisit : un rapport de tournée couvre plusieurs entreprises,
 * et l'écran doit demander laquelle avant d'envoyer quoi que ce soit. Envoyer
 * le fichier entier pour se faire répondre « il y en a quarante » aurait coûté
 * un aller-retour, et l'un des quarante aurait fini importé par défaut.
 */
export function extraireFiches(document: unknown): Record<string, unknown>[] {
  const estObjet = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(document)) return document.filter(estObjet);
  if (estObjet(document) && Array.isArray(document.prospects)) {
    return (document.prospects as unknown[]).filter(estObjet);
  }
  return estObjet(document) ? [document] : [];
}

/** Le nom lisible d'une fiche, pour la liste de choix. */
function nomDe(fiche: Record<string, unknown>, rang: number): string {
  const candidat = fiche.name ?? fiche.nom
    ?? (fiche.prospect as Record<string, unknown> | undefined)?.name
    ?? (fiche.prospect as Record<string, unknown> | undefined)?.nom;
  const texte = typeof candidat === 'string' ? candidat.trim() : '';
  return texte || `Entrée ${rang + 1} (sans nom)`;
}

/* ── L'APERÇU D'UNE SECTION ─────────────────────────────────────────────────
   Trois couleurs, et elles disent la même chose partout dans le Panel : vert on
   ajoute, orange on modifie, rouge on retire. Un aperçu monochrome aurait
   obligé à lire chaque libellé pour savoir de quel côté il penche. */
function LigneItem({
  ton, label, detail, from, to,
}: {
  ton: 'added' | 'changed' | 'removed';
  label: string;
  detail?: string;
  from?: string;
  to?: string;
}) {
  const marque = {
    added: { signe: '+', classe: 'text-success-primary' },
    changed: { signe: '~', classe: 'text-warning-primary' },
    removed: { signe: '−', classe: 'text-error-primary' },
  }[ton];

  return (
    <li className="flex gap-2 py-1 text-sm">
      <span className={`shrink-0 font-mono font-semibold ${marque.classe}`} aria-hidden="true">
        {marque.signe}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-primary">{label}</span>
        {detail ? <span className="text-tertiary"> — {detail}</span> : null}
        {from !== undefined && to !== undefined ? (
          <span className="mt-0.5 block text-xs text-tertiary">
            {/* L'AVANT EST BARRÉ, ET IL RESTE LISIBLE. Le retirer aurait
                empêché de vérifier qu'on remplace bien ce qu'on croit. */}
            <s className="text-quaternary">{from || '(vide)'}</s>
            {' → '}
            <span className="text-secondary">{to || '(vide)'}</span>
          </span>
        ) : null}
      </span>
    </li>
  );
}

function SectionApercu({ section }: { section: ProspectImportSection }) {
  const total = section.added.length + section.changed.length + section.removed.length;
  return (
    <section className="rounded-lg border border-secondary p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-primary">{section.label}</h4>
        {section.added.length ? (
          <Badge size="sm" color="success" type="pill-color">{section.added.length} ajout{section.added.length > 1 ? 's' : ''}</Badge>
        ) : null}
        {section.changed.length ? (
          <Badge size="sm" color="warning" type="pill-color">{section.changed.length} modifié{section.changed.length > 1 ? 's' : ''}</Badge>
        ) : null}
        {section.removed.length ? (
          <Badge size="sm" color="error" type="pill-color">{section.removed.length} retiré{section.removed.length > 1 ? 's' : ''}</Badge>
        ) : null}
        {/* CE QUI NE BOUGE PAS EST COMPTÉ, JAMAIS LISTÉ : sur une fiche suivie
            depuis trois mois, la liste de l'inchangé noierait les trois lignes
            qui comptent. */}
        {section.kept ? (
          <span className="text-xs text-quaternary">{section.kept} inchangé{section.kept > 1 ? 's' : ''}</span>
        ) : null}
      </header>
      {total === 0 ? (
        <p className="mt-1 text-sm text-quaternary">Rien à changer dans cette section.</p>
      ) : (
        <ul className="mt-2">
          {section.added.map((i, r) => (
            <LigneItem key={`a${r}`} ton="added" {...i} />
          ))}
          {section.changed.map((i, r) => (
            <LigneItem key={`c${r}`} ton="changed" {...i} />
          ))}
          {section.removed.map((i, r) => (
            <LigneItem key={`s${r}`} ton="removed" {...i} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProspectImportDialog({
  open,
  onClose,
  onImported,
  prospect,
  nomPropose,
}: {
  open: boolean;
  onClose: () => void;
  /** La fiche telle qu'elle est APRÈS l'import — le formulaire s'y recale. */
  onImported: (prospect: Prospect, plan: ProspectImportPlan) => void;
  /** Présente = on complète cette fiche ; absente = l'import CRÉE la fiche. */
  prospect?: Prospect;
  /** Le nom déjà tapé dans le formulaire, quand le document n'en porte pas. */
  nomPropose?: string;
}) {
  const [fichier, setFichier] = useState<string | null>(null);
  const [fiches, setFiches] = useState<Record<string, unknown>[]>([]);
  const [choisie, setChoisie] = useState(0);
  const [mode, setMode] = useState<ProspectImportMode>('MERGE');
  const [plan, setPlan] = useState<ProspectImportPlan | null>(null);
  const [analyse, setAnalyse] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setFichier(null); setFiches([]); setChoisie(0); setMode('MERGE');
    setPlan(null); setErreur(null); setAnalyse(false); setEnCours(false);
  }, [open]);

  /**
   * LE DOCUMENT ENVOYÉ AU SERVEUR.
   *
   * Le nom déjà tapé dans le formulaire est POSÉ EN DESSOUS de ce que dit le
   * fichier : celui qui a commencé à saisir « Boulangerie Martin » puis importe
   * un document sans nom ne doit pas se voir refuser l'import pour ça. Si le
   * document porte un nom, c'est lui qui gagne — c'est la source.
   */
  const document = useMemo(() => {
    const fiche = fiches[choisie];
    if (!fiche) return null;
    if (!prospect && nomPropose?.trim() && !fiche.name && !fiche.nom) {
      return { ...fiche, name: nomPropose.trim() };
    }
    return fiche;
  }, [fiches, choisie, prospect, nomPropose]);

  /* L'APERÇU SE REFAIT À CHAQUE CHANGEMENT DE MODE OU DE FICHE.
     Le mode décide de ce qui est RETIRÉ : un aperçu périmé montrerait une
     suppression qui n'aura pas lieu, ou tairait celle qui aura lieu. */
  useEffect(() => {
    if (!open || !document) { setPlan(null); return; }
    let vivant = true;
    setAnalyse(true);
    setErreur(null);
    api.previewProspectImport({ document, prospectId: prospect?._id ?? null, mode })
      .then((r) => { if (vivant) setPlan(r.plan); })
      .catch((e) => {
        if (!vivant) return;
        setPlan(null);
        setErreur(errorMessage(e, 'Ce document n’a pas pu être analysé.'));
      })
      .finally(() => { if (vivant) setAnalyse(false); });
    return () => { vivant = false; };
  }, [open, document, mode, prospect?._id]);

  const lire = async (liste: FileList | null) => {
    const brut = liste?.[0];
    if (!brut) return;
    setErreur(null);
    setPlan(null);
    try {
      const texte = await brut.text();
      const objet: unknown = JSON.parse(texte);
      const extraites = extraireFiches(objet);
      if (extraites.length === 0) {
        setErreur('Ce fichier ne contient aucune fiche exploitable.');
        setFiches([]);
        return;
      }
      setFichier(brut.name);
      setFiches(extraites);
      setChoisie(0);
    } catch {
      /* UNE ERREUR DE SYNTAXE SE DIT ICI, PAS AU SERVEUR. Le fichier n'est
         même pas du JSON : l'envoyer aurait produit un 400 générique, alors
         que le navigateur sait déjà exactement ce qui ne va pas. */
      setErreur('Ce fichier n’est pas un JSON valide.');
      setFiches([]);
      setFichier(null);
    }
  };

  const importer = async () => {
    if (!document) return;
    setEnCours(true);
    setErreur(null);
    try {
      const r = await api.applyProspectImport({
        document, prospectId: prospect?._id ?? null, mode,
      });
      onImported(r.prospect, r.plan);
    } catch (e) {
      setErreur(errorMessage(e, 'L’import n’a pas pu être appliqué.'));
    } finally {
      setEnCours(false);
    }
  };

  const rienAFaire = plan !== null
    && plan.counts.added === 0 && plan.counts.changed === 0 && plan.counts.removed === 0
    && plan.target.action === 'UPDATE';

  return (
    <ModalOverlay isOpen={open} onOpenChange={(v) => { if (!v) onClose(); }} isDismissable>
      <Modal className="w-full max-w-3xl">
        <Dialog>
          <div className="uui flex max-h-[85vh] flex-col p-5 sm:p-6">
            <header className="shrink-0">
              <h2 className="text-lg font-semibold text-primary">Importer un JSON</h2>
              <p className="mt-1 text-sm text-tertiary">
                {prospect
                  ? `Le document complète la fiche « ${prospect.name} ». Rien n’est écrit avant votre validation.`
                  : 'Le document crée la fiche, ses messages, ses tâches et ses rendez-vous. Rien n’est écrit avant votre validation.'}
              </p>
            </header>

            <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
              {/* ── LE FICHIER ─────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-3">
                <label>
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={(e) => void lire(e.target.files)}
                  />
                  <span className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-secondary px-3 py-2 text-sm font-medium text-secondary hover:bg-secondary">
                    <Icon name="download" size={14} />
                    {fichier ? 'Changer de fichier' : 'Choisir un fichier .json'}
                  </span>
                </label>
                {fichier ? (
                  <span className="text-sm text-tertiary">
                    {fichier}
                    {fiches.length > 1 ? ` — ${fiches.length} fiches` : null}
                  </span>
                ) : null}
              </div>

              {/* ── QUELLE ENTREPRISE ──────────────────────────────────────
                  Un rapport de tournée couvre plusieurs entreprises. On en
                  importe UNE : la fiche ouverte est celle-là, et créer les
                  trente-neuf autres sans les avoir vues serait un import de
                  masse déguisé en correction de fiche. */}
              {fiches.length > 1 ? (
                <div className="field">
                  <span className="field-label">Entreprise à importer</span>
                  <select
                    className="input"
                    aria-label="Entreprise à importer"
                    value={choisie}
                    onChange={(e) => setChoisie(Number(e.target.value))}
                  >
                    {fiches.map((f, r) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <option key={r} value={r}>{nomDe(f, r)}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-quaternary">
                    Ce fichier en contient {fiches.length}. Les autres restent à importer une par une.
                  </p>
                </div>
              ) : null}

              {/* ── COMPLÉTER OU REMPLACER ──────────────────────────────── */}
              {fiches.length > 0 && prospect ? (
                <div className="field">
                  <span className="field-label">Ce que fait l’import</span>
                  <div className="flex flex-wrap gap-2">
                    {([
                      ['MERGE', 'Compléter', 'Ajoute et corrige. Ce que le document ne mentionne pas reste.'],
                      ['REPLACE', 'Remplacer', 'Chaque section citée par le document devient exactement ce qu’il dit.'],
                    ] as const).map(([valeur, titre, aide]) => (
                      <button
                        key={valeur}
                        type="button"
                        aria-pressed={mode === valeur}
                        onClick={() => setMode(valeur)}
                        className={[
                          'flex-1 rounded-lg border p-3 text-left transition-colors',
                          mode === valeur
                            ? 'border-brand bg-secondary'
                            : 'border-secondary hover:bg-secondary',
                        ].join(' ')}
                      >
                        <span className="block text-sm font-medium text-primary">{titre}</span>
                        <span className="mt-0.5 block text-xs text-tertiary">{aide}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-quaternary">
                    Dans les deux cas, aucune tâche ni aucun rendez-vous existant n’est supprimé.
                  </p>
                </div>
              ) : null}

              {erreur ? <p role="alert" className="alert alert-error">{erreur}</p> : null}

              {analyse ? (
                <p className="text-sm text-tertiary">Analyse du document…</p>
              ) : null}

              {/* ── L'APERÇU ───────────────────────────────────────────── */}
              {plan ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-secondary bg-secondary p-3">
                    <p className="text-sm text-primary">
                      {plan.target.action === 'CREATE'
                        ? <>La fiche <strong>{plan.target.name}</strong> sera <strong>créée</strong>.</>
                        : <>La fiche <strong>{plan.target.name}</strong> sera <strong>modifiée</strong>.</>}
                    </p>
                    <p className="mt-1 text-xs text-tertiary">
                      {plan.counts.added} ajout(s), {plan.counts.changed} modification(s),
                      {' '}{plan.counts.removed} retrait(s).
                    </p>
                  </div>

                  {plan.sections.length === 0 ? (
                    <p className="text-sm text-quaternary">
                      Ce document n’apporte rien que la fiche ne porte déjà.
                    </p>
                  ) : (
                    plan.sections.map((s) => <SectionApercu key={s.key} section={s} />)
                  )}

                  {/* ── CE QUI N'EST PAS REPRIS ──────────────────────────
                      Listé, avec sa raison. C'est ce qui permet de corriger le
                      FICHIER plutôt que la fiche — la seule correction qui
                      tienne quand le suivant arrive avec quarante entreprises. */}
                  {plan.ignored.length ? (
                    <section className="rounded-lg border border-secondary p-3">
                      <h4 className="text-sm font-semibold text-primary">
                        Non repris ({plan.ignored.length})
                      </h4>
                      <ul className="mt-2 space-y-1">
                        {plan.ignored.map((i, r) => (
                          // eslint-disable-next-line react/no-array-index-key
                          <li key={r} className="text-sm text-tertiary">
                            <code className="text-xs text-secondary">{i.path}</code> — {i.reason}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              ) : null}

              {!fichier && !erreur ? (
                <p className="text-sm text-quaternary">
                  Le format attendu est décrit dans
                  {' '}<code className="text-xs">docs/architecture/26_PROSPECT_IMPORT.md</code>.
                  Coordonnées, liens, informations, notes, communication, tâches
                  planifiées et rendez-vous entrent d’un seul fichier.
                </p>
              ) : null}
            </div>

            <footer className="mt-4 flex shrink-0 flex-wrap justify-end gap-2 border-t border-secondary pt-4">
              <Button color="secondary" onClick={onClose} isDisabled={enCours}>Annuler</Button>
              <Button
                color="primary"
                isDisabled={!plan || analyse || rienAFaire}
                isLoading={enCours}
                onClick={() => void importer()}
              >
                {plan?.target.action === 'CREATE' ? 'Créer la fiche' : 'Appliquer l’import'}
              </Button>
            </footer>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export default ProspectImportDialog;
