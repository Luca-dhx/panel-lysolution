/**
 * LA PROSPECTION — les prospects, et les accroches qui servent à les aborder.
 *
 * ══ DEUX ONGLETS, ET LA COUPURE EST CELLE DU GESTE ══════════════════════════
 *
 *   Prospects  « à qui je parle » — le pipeline, les fiches, les rendez-vous.
 *   Modèles    « qu'est-ce que je leur dis » — nos accroches, prêtes à copier.
 *
 * Les seconds n'ont pas de destinataire : les ranger dans la liste des premiers
 * aurait obligé à inventer un prospect « aucun » pour les porter, puis à
 * l'exclure de tous les comptes.
 *
 * ══ UN ARBRE DE DOSSIERS PAR ONGLET, ET ILS NE SE MÉLANGENT PAS ════════════
 *
 * « Restaurants » range des prospects ; « Accroches froides » range des modèles.
 * Un seul arbre partagé aurait obligé à filtrer partout, puis à expliquer un
 * jour pourquoi un modèle est apparu dans le dossier d'un client.
 *
 * ══ LE FILTRE PAR DOSSIER PORTE SUR LA BRANCHE ═════════════════════════════
 *
 * Choisir « Restaurants » montre aussi ce qui est dans « Restaurants/Paris ».
 * L'inverse — le dossier seul — obligerait à cliquer chaque sous-dossier pour
 * voir ce qu'on range sous une même idée, ce qui est précisément ce qu'un
 * dossier sert à éviter.
 *
 * ══ CE QUI SORT D'ICI ══════════════════════════════════════════════════════
 *
 * Rien. Ni les fiches, ni les dossiers, ni les modèles ne passent par le pont.
 */
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Modale } from '@/components/Modale';
import { PageHeader, Panel, SkeletonRows, SmoothTabs } from '@/components/ui-kit';
import { SearchField } from '@/components/SearchField';
import { Icon } from '@/components/Icon';
import { FolderSidebar } from '@/components/prospection/FolderSidebar';
import { buildFolderTree, idsCouverts } from '@/components/prospection/FolderTree';
import { ProspectForm } from '@/components/prospection/ProspectForm';
import { ProspectsTable } from '@/components/prospection/ProspectsTable';
import { TemplatesPanel } from '@/components/prospection/TemplatesPanel';
import {
  PROSPECT_STATUS_DEFS,
  PROSPECT_STATUS_ORDER,
} from '@/components/prospection/prospectStatus';
import { api, errorMessage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import { useMeetings } from '@/lib/useEvents';
import { useProspects } from '@/lib/useProspects';
import { useProspectFolders, useProspectTemplates } from '@/lib/useProspectLibrary';
import type { FolderNode, FolderSelection } from '@/components/prospection/FolderTree';
import type {
  Prospect, ProspectStatus, ProspectSummary, ProspectTemplateInput,
} from '@/types.prospection';

type Onglet = 'prospects' | 'modeles';

/** « 3 conceptions · 2 refontes » — au singulier quand il n'y en a qu'une. */
function repartition(summary: ProspectSummary): string {
  const { CREATION = 0, REDESIGN = 0 } = summary.byType ?? {};
  const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`;
  return `${pluriel(CREATION, 'conception')} · ${pluriel(REDESIGN, 'refonte')}`;
}

/**
 * L'ADRESSE LISIBLE DE CHAQUE DOSSIER — « Accroches froides / Restaurants ».
 *
 * Le nom seul ne suffit pas : deux dossiers « Paris » peuvent vivre sous deux
 * parents différents, et une carte qui n'affiche que « Paris » ne dit pas
 * lequel.
 */
function cheminsDe(noeuds: FolderNode[], prefixe = ''): Map<string, string> {
  const chemins = new Map<string, string>();
  for (const n of noeuds) {
    const chemin = prefixe ? `${prefixe} / ${n.name}` : n.name;
    chemins.set(n.id, chemin);
    for (const [k, v] of cheminsDe(n.children, chemin)) chemins.set(k, v);
  }
  return chemins;
}

export function ProspectionPage() {
  const toast = useToast();

  const [onglet, setOnglet] = useState<Onglet>('prospects');
  const [recherche, setRecherche] = useState('');
  const [filtre, setFiltre] = useState<ProspectStatus | ''>('');
  const [selProspects, setSelProspects] = useState<FolderSelection>('ALL');
  const [selModeles, setSelModeles] = useState<FolderSelection>('ALL');
  const [volet, setVolet] = useState(false);
  const [edite, setEdite] = useState<Prospect | null>(null);
  const [aSupprimer, setASupprimer] = useState<Prospect | null>(null);
  const [suppressionEnCours, setSuppressionEnCours] = useState(false);

  const { prospects, summary, isInitialLoading, error, reload } = useProspects();
  const { meetings, reload: rechargerAgenda } = useMeetings('upcoming');
  const dossiersProspects = useProspectFolders('PROSPECT');
  const dossiersModeles = useProspectFolders('TEMPLATE');
  const { templates, reload: rechargerModeles } = useProspectTemplates();

  const toutRecharger = () => { void reload(); void rechargerAgenda(); };

  /* ── LES DEUX ARBRES ──────────────────────────────────────────────────── */

  const arbreProspects = useMemo(() => {
    const comptes = new Map<string | null, number>();
    for (const p of prospects) {
      const clef = p.folderId ?? null;
      comptes.set(clef, (comptes.get(clef) ?? 0) + 1);
    }
    return buildFolderTree(dossiersProspects.folders, comptes);
  }, [dossiersProspects.folders, prospects]);

  const arbreModeles = useMemo(() => {
    const comptes = new Map<string | null, number>();
    for (const t of templates) {
      const clef = t.folderId ?? null;
      comptes.set(clef, (comptes.get(clef) ?? 0) + 1);
    }
    return buildFolderTree(dossiersModeles.folders, comptes);
  }, [dossiersModeles.folders, templates]);

  const cheminsModeles = useMemo(() => cheminsDe(arbreModeles.racines), [arbreModeles.racines]);

  /* ── LES LISTES FILTRÉES ──────────────────────────────────────────────── */

  /**
   * LA RECHERCHE PORTE SUR CE QU'ON A EN TÊTE.
   *
   * Le nom d'abord, mais aussi le téléphone et l'adresse e-mail : on retrouve
   * souvent une affaire par le numéro qui vient d'appeler. Les notes internes
   * sont incluses — c'est là que vit « recommandé par Untel ».
   */
  const filtres = useMemo(() => {
    const terme = recherche.trim().toLowerCase();
    const couverts = idsCouverts(arbreProspects.racines, selProspects);
    return prospects.filter((p) => {
      if (selProspects === 'NONE' && p.folderId) return false;
      if (selProspects !== 'ALL' && selProspects !== 'NONE'
        && !couverts.includes(p.folderId ?? '')) return false;
      if (filtre && p.status !== filtre) return false;
      if (!terme) return true;
      return [p.name, p.email, p.phone, p.notes]
        .some((champ) => (champ ?? '').toLowerCase().includes(terme));
    });
  }, [prospects, recherche, filtre, selProspects, arbreProspects.racines]);

  const modelesFiltres = useMemo(() => {
    const terme = recherche.trim().toLowerCase();
    const couverts = idsCouverts(arbreModeles.racines, selModeles);
    return templates.filter((t) => {
      if (selModeles === 'NONE' && t.folderId) return false;
      if (selModeles !== 'ALL' && selModeles !== 'NONE'
        && !couverts.includes(t.folderId ?? '')) return false;
      if (!terme) return true;
      return [t.title, t.channel, t.description, t.body]
        .some((champ) => (champ ?? '').toLowerCase().includes(terme));
    });
  }, [templates, recherche, selModeles, arbreModeles.racines]);

  /* ── LES GESTES SUR LES DOSSIERS ──────────────────────────────────────── */

  const gestesDossiers = (kind: 'PROSPECT' | 'TEMPLATE', recharger: () => void) => ({
    onCreer: async (nom: string, parentId: string | null) => {
      await api.createProspectFolder({ name: nom, kind, parentId });
      recharger();
    },
    onRenommer: async (id: string, nom: string) => {
      await api.updateProspectFolder(id, { name: nom });
      recharger();
    },
    onSupprimer: async (id: string) => {
      await api.deleteProspectFolder(id);
      recharger();
      /* Le contenu a REMONTÉ d'un cran : la liste change aussi, pas seulement
         l'arbre. */
      if (kind === 'TEMPLATE') void rechargerModeles();
      else void reload();
    },
  });

  const supprimer = async () => {
    if (!aSupprimer) return;
    setSuppressionEnCours(true);
    try {
      await api.deleteProspect(aSupprimer._id);
      toast.success(`« ${aSupprimer.name} » a été supprimé.`);
      setASupprimer(null);
      toutRecharger();
    } catch (err) {
      toast.error(errorMessage(err, 'Ce prospect n’a pas pu être supprimé.'));
    } finally {
      setSuppressionEnCours(false);
    }
  };

  const enregistrerModele = useCallback(async (body: ProspectTemplateInput) => {
    await api.createProspectTemplate(body);
    void rechargerModeles();
  }, [rechargerModeles]);

  const majModele = useCallback(async (id: string, body: ProspectTemplateInput) => {
    await api.updateProspectTemplate(id, body);
    void rechargerModeles();
  }, [rechargerModeles]);

  const suppModele = useCallback(async (id: string) => {
    await api.deleteProspectTemplate(id);
    void rechargerModeles();
  }, [rechargerModeles]);

  const dossierCourant = (s: FolderSelection) => (s === 'ALL' || s === 'NONE' ? null : s);

  return (
    <div className="page">
      <PageHeader
        title="Prospection"
        description="Les affaires en cours de démarchage, et les accroches qui servent à les aborder. Rien de tout cela ne sort du Panel."
        actions={onglet === 'prospects' ? (
          <Button
            color="primary"
            iconLeading={() => <Icon name="plus-lg" />}
            onClick={() => { setEdite(null); setVolet(true); }}
          >
            Nouveau prospect
          </Button>
        ) : null}
      />

      {error ? <div className="alert alert-error">{error}</div> : null}

      <SmoothTabs
        tabs={[
          { value: 'prospects' as const, label: `Prospects (${prospects.length})` },
          { value: 'modeles' as const, label: `Modèles (${templates.length})` },
        ]}
        value={onglet}
        onChange={(v) => { setOnglet(v); setRecherche(''); }}
        layoutId="prospection-tabs"
      />

      {/*
        L'ARBRE PASSE AU-DESSUS SOUS `lg`, PAS À CÔTÉ.
        La barre latérale du Panel prend déjà 250 px dès 900 px de fenêtre : une
        seconde colonne à cet endroit laisserait moins de trois cents pixels au
        contenu — la largeur d'un nom de prospect tronqué.
      */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {onglet === 'prospects' ? (
          <FolderSidebar
            racines={arbreProspects.racines}
            total={arbreProspects.total}
            sansDossier={arbreProspects.sansDossier}
            selection={selProspects}
            onSelectionChange={setSelProspects}
            labelTout="Tous les prospects"
            {...gestesDossiers('PROSPECT', () => void dossiersProspects.reload())}
          />
        ) : (
          <FolderSidebar
            racines={arbreModeles.racines}
            total={arbreModeles.total}
            sansDossier={arbreModeles.sansDossier}
            selection={selModeles}
            onSelectionChange={setSelModeles}
            labelTout="Tous les modèles"
            {...gestesDossiers('TEMPLATE', () => void dossiersModeles.reload())}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {onglet === 'prospects' ? (
            <>
              {/*
                ── LE PIPELINE EN UNE LIGNE ──────────────────────────────────
                Les cinq états sont TOUJOURS affichés, y compris à zéro : une
                colonne qui disparaît quand elle est vide fait croire que l'état
                n'existe pas. Chaque pastille est aussi le filtre — recliquer
                dessus le retire.
              */}
              <div className="prospect-pipeline" role="group" aria-label="Filtrer par statut">
                <button
                  type="button"
                  className={filtre === '' ? 'prospect-tally prospect-tally-active' : 'prospect-tally'}
                  aria-pressed={filtre === ''}
                  onClick={() => setFiltre('')}
                >
                  <span className="prospect-tally-count">{summary?.total ?? prospects.length}</span>
                  <span className="prospect-tally-label">Tous</span>
                </button>
                {PROSPECT_STATUS_ORDER.map((statut) => (
                  <button
                    key={statut}
                    type="button"
                    className={
                      filtre === statut ? 'prospect-tally prospect-tally-active' : 'prospect-tally'
                    }
                    aria-pressed={filtre === statut}
                    onClick={() => setFiltre(filtre === statut ? '' : statut)}
                  >
                    <span className={`prospect-tally-count prospect-tally-${statut}`}>
                      {summary?.byStatus[statut] ?? 0}
                    </span>
                    <span className="prospect-tally-label">{PROSPECT_STATUS_DEFS[statut].label}</span>
                  </button>
                ))}
              </div>

              {isInitialLoading ? (
                <Panel title="Prospects"><SkeletonRows rows={4} /></Panel>
              ) : (
                <ProspectsTable
                  title={filtre ? PROSPECT_STATUS_DEFS[filtre].label : 'Tous les prospects'}
                  /*
                    La répartition par NATURE se lit ici plutôt que de devenir un
                    sixième bouton : c'est un second axe, et le mêler aux cinq
                    pastilles du pipeline aurait laissé croire qu'une « refonte »
                    est un état d'avancement.
                  */
                  description={
                    summary
                      ? `${repartition(summary)} · statut et nature se changent sur leur pastille.`
                      : 'Le statut et la nature se changent directement sur leur pastille.'
                  }
                  prospects={filtres}
                  upcomingMeetings={meetings}
                  onEdit={(p) => { setVolet(false); setEdite(p); }}
                  onDelete={setASupprimer}
                  onStatusChanged={toutRecharger}
                  contentTrailing={
                    <div className="prospect-search">
                      <SearchField
                        label="Rechercher un prospect"
                        placeholder="Nom, téléphone, e-mail, note…"
                        value={recherche}
                        onChange={setRecherche}
                      />
                    </div>
                  }
                />
              )}
            </>
          ) : (
            <Panel
              title="Modèles d’accroche"
              badge={String(modelesFiltres.length)}
              description="Un titre, un canal, une description — quand s’en servir — et le texte."
              actions={(
                <div className="w-56">
                  <SearchField
                    label="Rechercher un modèle"
                    placeholder="Titre, canal, texte…"
                    value={recherche}
                    onChange={setRecherche}
                  />
                </div>
              )}
            >
              <TemplatesPanel
                templates={modelesFiltres}
                racines={arbreModeles.racines}
                chemins={cheminsModeles}
                dossierCourant={dossierCourant(selModeles)}
                onCreate={enregistrerModele}
                onUpdate={majModele}
                onDelete={suppModele}
              />
            </Panel>
          )}
        </div>
      </div>

      {/*
        LE FORMULAIRE EST UN DIALOGUE, comme sur la fiche : inséré dans la page,
        il repoussait la liste sous la ligne de flottaison au moment précis où
        l'on voulait comparer ce qu'on tape à ce qui existe.
      */}
      <ModalOverlay
        isOpen={volet || edite !== null}
        onOpenChange={(v) => { if (!v) { setVolet(false); setEdite(null); } }}
        isDismissable
      >
        <Modal className="w-full max-w-3xl">
          <Dialog>
            <div className="p-4 sm:p-5">
              <ProspectForm
                prospect={edite ?? undefined}
                dossiers={arbreProspects.racines}
                dossierParDefaut={dossierCourant(selProspects)}
                onSaved={() => { setVolet(false); setEdite(null); toutRecharger(); }}
                onCancel={() => { setVolet(false); setEdite(null); }}
              />
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

      {aSupprimer ? (
        <Modale titre="Supprimer ce prospect ?" onClose={() => setASupprimer(null)}>
          <p>
            <strong>{aSupprimer.name}</strong> sera retiré définitivement, ainsi que
            les rendez-vous et les événements consignés pour lui.
          </p>
          <p className="muted">
            Un prospect n’est pas une pièce comptable : rien n’est archivé.
          </p>
          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-danger btn-small"
              disabled={suppressionEnCours}
              onClick={() => void supprimer()}
            >
              {suppressionEnCours ? 'Suppression…' : 'Supprimer'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setASupprimer(null)}
            >
              Annuler
            </button>
          </div>
        </Modale>
      ) : null}
    </div>
  );
}

export default ProspectionPage;
