/**
 * PROSPECTION — le carnet des affaires qui ne sont pas encore des clients.
 *
 * ══ POURQUOI CET ÉCRAN N'EST PAS « PROJETS CLIENTS » ════════════════════════
 *
 * Un projet est une instance technique appairée : il tourne, il a une adresse,
 * un pont, une version. Un prospect n'a rien de tout cela — souvent pas même
 * une raison sociale vérifiée. Les mélanger aurait obligé à filtrer partout
 * pour ne pas superviser un garage qu'on n'a même pas rencontré.
 *
 * ══ LE PREMIER ÉCRAN DE LA REFONTE PROGRESSIVE ══════════════════════════════
 *
 * Le tableau vient de la librairie (Untitled UI / React Aria). Le reste de la
 * page — filtres, formulaire, boutons — reste sur le style maison. C'est ce que
 * « progressif » veut dire : un écran passe à la librairie quand on le refait,
 * et les couleurs de la librairie sont branchées sur le thème du Panel
 * (`styles/bridge.css`) pour qu'aucun des deux mondes ne détonne.
 *
 * ══ CES DONNÉES NE SORTENT PAS ══════════════════════════════════════════════
 *
 * Aucune route du pont n'expose les prospects et la synchronisation ne les
 * transporte pas. Ce sont nos notes commerciales.
 */
import { useMemo, useState } from 'react';
import { Card } from '@/components/ui';
import { Modale } from '@/components/Modale';
import { SearchField } from '@/components/SearchField';
import { ProspectForm } from '@/components/prospection/ProspectForm';
import { ProspectsTable } from '@/components/prospection/ProspectsTable';
import {
  PROSPECT_STATUS_DEFS,
  PROSPECT_STATUS_ORDER,
} from '@/components/prospection/prospectStatus';
import { api, errorMessage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import { useMeetings } from '@/lib/useEvents';
import { useProspects } from '@/lib/useProspects';
import type { Prospect, ProspectStatus } from '@/types.prospection';

export function ProspectionPage() {
  const toast = useToast();
  const { prospects, summary, isInitialLoading, error, reload } = useProspects();
  /**
   * L'agenda de PROSPECTION uniquement.
   *
   * Sans le `subjectType`, la colonne « prochain rendez-vous » aurait pu
   * afficher, sur un prospect, une réunion prise avec un client — les deux
   * vivent dans la même collection, et rien d'autre ne les distingue.
   */
  const { meetings, reload: rechargerAgenda } = useMeetings('upcoming', undefined, 'PROSPECT');

  const [recherche, setRecherche] = useState('');
  const [filtre, setFiltre] = useState<ProspectStatus | ''>('');
  const [volet, setVolet] = useState(false);
  const [edite, setEdite] = useState<Prospect | null>(null);
  const [aSupprimer, setASupprimer] = useState<Prospect | null>(null);
  const [suppressionEnCours, setSuppressionEnCours] = useState(false);

  const toutRecharger = () => { void reload(); void rechargerAgenda(); };

  /**
   * LA RECHERCHE PORTE SUR CE QU'ON A EN TÊTE.
   *
   * Le nom d'abord, mais aussi le téléphone et l'adresse e-mail : on retrouve
   * souvent une affaire par le numéro qui vient d'appeler. Les notes internes
   * sont incluses — c'est là que vit « recommandé par Untel ».
   */
  const filtres = useMemo(() => {
    const terme = recherche.trim().toLowerCase();
    return prospects.filter((p) => {
      if (filtre && p.status !== filtre) return false;
      if (!terme) return true;
      return [p.name, p.email, p.phone, p.notes]
        .some((champ) => (champ ?? '').toLowerCase().includes(terme));
    });
  }, [prospects, recherche, filtre]);

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

  return (
    <div className="page">
      <header className="page-header">
        <h1>Prospection</h1>
        <p className="page-description">
          Les affaires en cours de démarchage, avant qu’elles ne deviennent des projets.
          Ces fiches restent dans le Panel : aucun projet n’en reçoit copie.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="contract-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={() => { setEdite(null); setVolet(true); }}
        >
          Nouveau prospect
        </button>
      </div>

      {volet || edite ? (
        <ProspectForm
          prospect={edite ?? undefined}
          onSaved={() => { setVolet(false); setEdite(null); toutRecharger(); }}
          onCancel={() => { setVolet(false); setEdite(null); }}
        />
      ) : null}

      {/*
        ── LE PIPELINE EN UNE LIGNE ─────────────────────────────────────────
        Les cinq états sont TOUJOURS affichés, y compris à zéro : une colonne
        qui disparaît quand elle est vide fait croire que l'état n'existe pas.
        Chaque pastille est aussi le filtre — recliquer dessus le retire.
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
        <Card title="Prospects"><p className="muted">Chargement…</p></Card>
      ) : (
        <ProspectsTable
          title={filtre ? PROSPECT_STATUS_DEFS[filtre].label : 'Tous les prospects'}
          description="Le statut se change directement sur sa pastille."
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
