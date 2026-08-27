/**
 * LA FICHE D'UN PROSPECT.
 *
 * ══ DEUX ONGLETS, ET LA COUPURE N'EST PAS COSMÉTIQUE ════════════════════════
 *
 * « Fiche » répond à « qui est-ce » : coordonnées, liens, images, notes.
 * « Suivi » répond à « où en est-on » : rendez-vous à venir, confirmations en
 * attente, histoire de ce qui s'est passé.
 *
 * Tout empiler sur une seule page aurait noyé la seule chose qu'on vient
 * vraiment chercher avant un appel — le compte rendu de la dernière fois —
 * sous une galerie de photos de devanture.
 *
 * ══ LE SUIVI EST CELUI DU PANEL, PAS UN SECOND SYSTÈME ══════════════════════
 *
 * Les réunions et les événements affichés ici sont les MÊMES objets que ceux
 * des projets, avec les mêmes formulaires et la même machine à états. Ce qui
 * change est leur sujet (`subjectType: 'PROSPECT'`). Fabriquer un agenda
 * parallèle pour la prospection aurait dupliqué l'ordonnanceur, la conversion
 * à l'échéance et trois écrans — pour finir avec deux agendas qui divergent.
 *
 * ══ TOUTES LES LECTURES SONT BORNÉES À CE PROSPECT ══════════════════════════
 *
 * Afficher, même par accident, un rendez-vous pris avec quelqu'un d'autre
 * serait une fuite : ces notes sont internes, mais elles nomment des tiers.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { Modale } from '@/components/Modale';
import { EventConfirmation } from '@/components/EventConfirmation';
import { EventTimeline } from '@/components/EventTimeline';
import { MeetingRow } from '@/components/EventLists';
import { MeetingForm, PastEventForm } from '@/components/EventForms';
import { LinkRow, lienTelephone, sansProtocole } from '@/components/Links';
import { ProspectForm } from '@/components/prospection/ProspectForm';
import { ProspectStatusSelect } from '@/components/prospection/ProspectStatusSelect';
import { prospectStatusLabel } from '@/components/prospection/prospectStatus';
import { api, errorMessage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import { useProspect } from '@/lib/useProspects';
import { formatDateTime } from '@/lib/format';
import type { Meeting, ProjectEvent } from '@/types.events';

type Onglet = 'fiche' | 'suivi';

export function ProspectDetailPage() {
  const { prospectId } = useParams<{ prospectId: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const { prospect, meetings, events, isInitialLoading, error, reload } = useProspect(prospectId);

  const [onglet, setOnglet] = useState<Onglet>('fiche');
  const [enEdition, setEnEdition] = useState(false);
  const [volet, setVolet] = useState<null | 'reunion' | 'evenement'>(null);
  const [reunionEditee, setReunionEditee] = useState<Meeting | null>(null);
  const [evenementEdite, setEvenementEdite] = useState<ProjectEvent | null>(null);
  const [confirmerSuppression, setConfirmerSuppression] = useState(false);
  const [suppressionEnCours, setSuppressionEnCours] = useState(false);
  const [apercu, setApercu] = useState<string | null>(null);

  if (isInitialLoading) {
    return (
      <div className="page">
        <Card title="Prospect"><p className="muted">Chargement…</p></Card>
      </div>
    );
  }

  if (!prospect) {
    return (
      <div className="page">
        {error ? <div className="alert alert-error">{error}</div> : null}
        <EmptyState
          title="Prospect introuvable"
          hint="Il a peut-être été supprimé depuis un autre poste."
        />
        <div className="contract-actions">
          <Link className="btn btn-secondary btn-small" to="/prospection">
            Retour à la prospection
          </Link>
        </div>
      </div>
    );
  }

  /**
   * RÉUNIONS À VENIR — les autres restent dans l'histoire.
   *
   * Le serveur rend TOUT l'agenda du prospect, passé compris : c'est ce qui
   * permet d'afficher un report ou une annulation sans seconde requête. Le tri
   * en deux listes se fait donc ici, sur des données déjà en main.
   */
  const aVenir = meetings.filter((m) => m.status === 'PLANNED');
  const enAttente = events.filter((e) => e.status === 'PENDING_CONFIRMATION');
  const historique = events.filter((e) => e.status !== 'PENDING_CONFIRMATION');

  const toutRecharger = () => { void reload(); };

  const supprimer = async () => {
    setSuppressionEnCours(true);
    try {
      await api.deleteProspect(prospect._id);
      toast.success(`« ${prospect.name} » a été supprimé.`);
      navigate('/prospection');
    } catch (err) {
      toast.error(errorMessage(err, 'Ce prospect n’a pas pu être supprimé.'));
      setSuppressionEnCours(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <Link className="link-back" to="/prospection">
          <Icon name="chevron-down" size={14} />
          Prospection
        </Link>
        <div className="prospect-title">
          <h1>{prospect.name}</h1>
          <ProspectStatusSelect
            prospectId={prospect._id}
            status={prospect.status}
            onChanged={toutRecharger}
            size="md"
          />
        </div>
        <p className="page-description">
          Fiche interne. Rien de ce qui est écrit ici ne sort du Panel.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="contract-actions">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => setEnEdition(true)}
        >
          Modifier la fiche
        </button>
        <button
          type="button"
          className="btn btn-danger btn-small"
          onClick={() => setConfirmerSuppression(true)}
        >
          Supprimer
        </button>
      </div>

      {enEdition ? (
        <ProspectForm
          prospect={prospect}
          onSaved={() => { setEnEdition(false); toutRecharger(); }}
          onCancel={() => setEnEdition(false)}
        />
      ) : null}

      <div className="tabs" role="group" aria-label="Sections de la fiche">
        <button
          type="button"
          className={onglet === 'fiche' ? 'tab tab-active' : 'tab'}
          aria-pressed={onglet === 'fiche'}
          onClick={() => setOnglet('fiche')}
        >
          Fiche
        </button>
        <button
          type="button"
          className={onglet === 'suivi' ? 'tab tab-active' : 'tab'}
          aria-pressed={onglet === 'suivi'}
          onClick={() => setOnglet('suivi')}
        >
          Suivi{enAttente.length > 0 ? ` (${enAttente.length})` : ''}
        </button>
      </div>

      {onglet === 'fiche' ? (
        <>
          <Card title="Coordonnées">
            {prospect.email || prospect.phone ? (
              <div className="link-list">
                {prospect.email ? (
                  <LinkRow
                    icon="envelope"
                    label="Adresse e-mail"
                    value={prospect.email}
                    href={`mailto:${prospect.email}`}
                  />
                ) : null}
                {prospect.phone ? (
                  <LinkRow
                    icon="telephone"
                    label="Téléphone"
                    value={prospect.phone}
                    href={lienTelephone(prospect.phone)}
                  />
                ) : null}
              </div>
            ) : (
              <p className="muted">
                Aucune coordonnée. « Modifier la fiche » pour en ajouter.
              </p>
            )}
          </Card>

          <Card title={`Liens (${prospect.links.length})`}>
            {prospect.links.length === 0 ? (
              <p className="muted">Aucun lien enregistré.</p>
            ) : (
              <div className="link-list">
                {prospect.links.map((lien) => (
                  <LinkRow
                    key={lien.id}
                    icon="globe"
                    label={lien.label || 'Lien'}
                    value={sansProtocole(lien.url)}
                    href={lien.url}
                    title={lien.url}
                    external
                  />
                ))}
              </div>
            )}
          </Card>

          <Card title={`Images (${prospect.images.length})`}>
            {prospect.images.length === 0 ? (
              <p className="muted">Aucune image.</p>
            ) : (
              <ul className="prospect-gallery">
                {prospect.images.map((image) => (
                  <li key={image.id}>
                    {/*
                      La vignette OUVRE l'image en grand plutôt que de mener au
                      fichier : un lien direct sortait de l'application, et on
                      revenait par le bouton « précédent » du navigateur.
                    */}
                    <button
                      type="button"
                      className="prospect-gallery-item"
                      onClick={() => setApercu(image.url)}
                    >
                      <img src={image.url} alt={image.caption || prospect.name} />
                    </button>
                    {image.caption ? (
                      <span className="prospect-gallery-caption">{image.caption}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Notes internes">
            {prospect.notes.trim() ? (
              <p className="prospect-notes">{prospect.notes}</p>
            ) : (
              <p className="muted">Rien n’a encore été noté.</p>
            )}
          </Card>

          <Card title="Historique du statut">
            {prospect.statusHistory.length === 0 ? (
              <p className="muted">Aucun changement consigné.</p>
            ) : (
              <ul className="prospect-history">
                {[...prospect.statusHistory].reverse().map((ligne, index) => (
                  <li key={`${ligne.at}-${index}`}>
                    <span className="prospect-history-when">{formatDateTime(ligne.at)}</span>
                    <span className="prospect-history-what">
                      {ligne.from
                        ? `${prospectStatusLabel(ligne.from)} → ${prospectStatusLabel(ligne.to)}`
                        : `Créé en « ${prospectStatusLabel(ligne.to)} »`}
                    </span>
                    <span className="muted">{ligne.actorEmail ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : (
        <>
          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => setVolet('reunion')}
            >
              Planifier une réunion
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setVolet('evenement')}
            >
              Ajouter un événement passé
            </button>
          </div>

          {volet === 'reunion' || reunionEditee ? (
            <MeetingForm
              projectId={prospect._id}
              projectName={prospect.name}
              subjectType="PROSPECT"
              meeting={reunionEditee ?? undefined}
              onSaved={() => { setVolet(null); setReunionEditee(null); toutRecharger(); }}
              onCancel={() => { setVolet(null); setReunionEditee(null); }}
            />
          ) : null}
          {volet === 'evenement' || evenementEdite ? (
            <PastEventForm
              projectId={prospect._id}
              projectName={prospect.name}
              subjectType="PROSPECT"
              event={evenementEdite ?? undefined}
              onSaved={() => { setVolet(null); setEvenementEdite(null); toutRecharger(); }}
              onCancel={() => { setVolet(null); setEvenementEdite(null); }}
            />
          ) : null}

          {enAttente.length > 0 ? (
            <Card title={`À confirmer (${enAttente.length})`}>
              {enAttente.map((e) => (
                <EventConfirmation key={e._id} event={e} onResolved={toutRecharger} />
              ))}
            </Card>
          ) : null}

          <Card title="Réunions à venir">
            {aVenir.length === 0 ? (
              <p className="muted">Aucune réunion prévue avec ce prospect.</p>
            ) : (
              <ul className="event-list">
                {aVenir.map((m) => (
                  <MeetingRow
                    key={m._id}
                    meeting={m}
                    showProject={false}
                    onEdit={setReunionEditee}
                    onCancel={(r) => void api.cancelMeeting(r._id).then(toutRecharger)}
                  />
                ))}
              </ul>
            )}
          </Card>

          <Card title="Historique">
            {historique.length === 0 ? (
              <p className="muted">Rien n’a encore été consigné pour ce prospect.</p>
            ) : (
              <EventTimeline events={historique} onEdit={setEvenementEdite} />
            )}
          </Card>
        </>
      )}

      {apercu ? (
        <Modale titre="Image" onClose={() => setApercu(null)}>
          <img className="prospect-preview" src={apercu} alt={prospect.name} />
        </Modale>
      ) : null}

      {confirmerSuppression ? (
        <Modale titre="Supprimer ce prospect ?" onClose={() => setConfirmerSuppression(false)}>
          <p>
            <strong>{prospect.name}</strong> sera retiré définitivement, ainsi que
            les rendez-vous et les événements consignés pour lui.
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
              onClick={() => setConfirmerSuppression(false)}
            >
              Annuler
            </button>
          </div>
        </Modale>
      ) : null}
    </div>
  );
}

export default ProspectDetailPage;
