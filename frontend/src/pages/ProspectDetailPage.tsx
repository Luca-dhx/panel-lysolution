/**
 * LA FICHE D'UN PROSPECT.
 *
 * ══ QUATRE ONGLETS, ET CHACUN RÉPOND À UNE QUESTION ═════════════════════════
 *
 *   Fiche          « qui est-ce » — coordonnées, informations libres, liens,
 *                  images, notes.
 *   Communication  « qu'est-ce qu'on lui a dit » — les messages envoyés, et
 *                  ceux qu'on compte envoyer.
 *   Tâches         « qu'est-ce qu'il reste à faire » — chronologie, avec un
 *                  raccourci de création déjà rattaché à ce prospect.
 *   Suivi          « où en est-on » — rendez-vous, confirmations, histoire.
 *
 * Tout empiler sur une page aurait noyé la seule chose qu'on vient vraiment
 * chercher avant un appel — le compte rendu de la dernière fois — sous une
 * galerie de photos de devanture.
 *
 * ══ LA REFONTE : DEUX ANCIENS BLOCS ONT DISPARU ════════════════════════════
 *
 * L'en-tête maison (`page-header` + `prospect-title`) et la barre d'onglets
 * `aria-pressed` sont remplacés par le gabarit commun aux écrans refondus :
 * `PageHeader` et `SmoothTabs`. Ce n'est pas cosmétique — les onglets passent
 * de quatre boutons à un vrai `tablist`, avec un seul arrêt de tabulation pour
 * le groupe et la navigation aux flèches.
 *
 * Le formulaire d'édition passe en DIALOGUE. Il s'insérait auparavant entre la
 * barre d'actions et les onglets, poussant tout le contenu vers le bas : on
 * cliquait « Modifier », et la fiche qu'on voulait comparer disparaissait sous
 * la ligne de flottaison.
 *
 * ══ LE SUIVI EST CELUI DU PANEL, PAS UN SECOND SYSTÈME ══════════════════════
 *
 * Les réunions et les événements affichés ici sont les MÊMES objets que ceux
 * des projets, avec les mêmes formulaires et la même machine à états. Ce qui
 * change est leur sujet (`subjectType: 'PROSPECT'`).
 *
 * ══ TOUTES LES LECTURES SONT BORNÉES À CE PROSPECT ══════════════════════════
 *
 * Afficher, même par accident, un rendez-vous pris avec quelqu'un d'autre
 * serait une fuite : ces notes sont internes, mais elles nomment des tiers.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { EmptyPanel, PageHeader, Panel, SkeletonRows, SmoothTabs } from '@/components/ui-kit';
import { Modale } from '@/components/Modale';
import { EventConfirmation } from '@/components/EventConfirmation';
import { EventTimeline } from '@/components/EventTimeline';
import { MeetingRow } from '@/components/EventLists';
import { MeetingForm, PastEventForm } from '@/components/EventForms';
import { LinkRow, lienTelephone, sansProtocole } from '@/components/Links';
import { ProspectForm } from '@/components/prospection/ProspectForm';
import { ProspectInfoFieldsView } from '@/components/prospection/ProspectInfoFields';
import { ProspectMessages } from '@/components/prospection/ProspectMessages';
import { ProspectStatusSelect } from '@/components/prospection/ProspectStatusSelect';
import { ProspectTypeSelect } from '@/components/prospection/ProspectTypeSelect';
import { prospectStatusLabel } from '@/components/prospection/prospectStatus';
import { LinkedTasksPanel } from '@/components/tasks/LinkedTasksPanel';
import { api, errorMessage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import { useProspect } from '@/lib/useProspects';
import { formatDateTime } from '@/lib/format';
import type { Meeting, ProjectEvent } from '@/types.events';
import type { ProspectMessage } from '@/types.prospection';

type Onglet = 'fiche' | 'communication' | 'taches' | 'suivi';

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
  const [enregistrementMessages, setEnregistrementMessages] = useState(false);
  const [apercu, setApercu] = useState<string | null>(null);

  if (isInitialLoading) {
    return (
      <div className="page">
        <Panel title="Prospect"><SkeletonRows rows={4} /></Panel>
      </div>
    );
  }

  if (!prospect) {
    return (
      <div className="page">
        {error ? <div className="alert alert-error">{error}</div> : null}
        <PageHeader
          title="Prospect introuvable"
          backTo={{ to: '/prospection', label: 'Prospection' }}
          description="Il a peut-être été supprimé depuis un autre poste."
        />
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

  /**
   * LES MESSAGES S'ÉCRIVENT PAR UNE MISE À JOUR DE LA FICHE.
   *
   * Pas de route dédiée : ils vivent DANS le prospect, comme les liens et les
   * images. Une sous-ressource aurait ajouté quatre routes et un contrôleur
   * pour un tableau qu'on remplace en entier à chaque geste.
   */
  const enregistrerMessages = async (messages: ProspectMessage[]) => {
    setEnregistrementMessages(true);
    try {
      await api.updateProspect(prospect._id, { messages });
      toutRecharger();
    } catch (err) {
      toast.error(errorMessage(err, 'Ce message n’a pas pu être enregistré.'));
    } finally {
      setEnregistrementMessages(false);
    }
  };

  const messages = prospect.messages ?? [];
  const infoFields = prospect.infoFields ?? [];
  const aEnvoyer = messages.filter((m) => !m.sentAt).length;

  return (
    <div className="page">
      <PageHeader
        title={prospect.name}
        backTo={{ to: '/prospection', label: 'Prospection' }}
        description="Fiche interne. Rien de ce qui est écrit ici ne sort du Panel."
        badges={(
          /*
            LES DEUX AXES CÔTE À CÔTE, ET MANIPULABLES ICI : « où en est-on »
            et « que fait-on ». C'est la première chose qu'on vient lire avant
            un appel, et la seule qu'on vient parfois corriger.
          */
          <>
            <ProspectStatusSelect
              prospectId={prospect._id}
              status={prospect.status}
              onChanged={toutRecharger}
              size="md"
            />
            <ProspectTypeSelect
              prospectId={prospect._id}
              type={prospect.type}
              onChanged={toutRecharger}
              size="md"
            />
          </>
        )}
        actions={(
          <>
            <Button size="md" color="secondary" onClick={() => setConfirmerSuppression(true)}>
              Supprimer
            </Button>
            <Button size="md" color="primary" onClick={() => setEnEdition(true)}>
              Modifier la fiche
            </Button>
          </>
        )}
      />

      {error ? <div className="alert alert-error">{error}</div> : null}

      <SmoothTabs
        tabs={[
          { value: 'fiche' as const, label: 'Fiche' },
          {
            value: 'communication' as const,
            label: aEnvoyer > 0 ? `Communication (${aEnvoyer})` : 'Communication',
          },
          { value: 'taches' as const, label: 'Tâches' },
          {
            value: 'suivi' as const,
            label: enAttente.length > 0 ? `Suivi (${enAttente.length})` : 'Suivi',
          },
        ]}
        value={onglet}
        onChange={setOnglet}
        layoutId="prospect-detail-tabs"
      />

      {onglet === 'fiche' ? (
        <div className="flex flex-col gap-4">
          <Panel title="Coordonnées">
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
              <p className="text-sm text-tertiary">
                Aucune coordonnée. « Modifier la fiche » pour en ajouter.
              </p>
            )}
          </Panel>

          {/*
            LES INFORMATIONS LIBRES JUSTE APRÈS LES COORDONNÉES.

            C'est là qu'on note ce qui décide d'une affaire — budget annoncé,
            hébergeur actuel, qui signe. Les reléguer sous la galerie d'images
            les aurait rendues invisibles au moment où l'on décroche le
            téléphone.
          */}
          <Panel
            title="Informations"
            badge={infoFields.length ? String(infoFields.length) : undefined}
            description="Des champs libres : un nom, un contenu, autant qu’il en faut."
          >
            <ProspectInfoFieldsView fields={infoFields} />
          </Panel>

          <Panel title="Liens" badge={prospect.links.length ? String(prospect.links.length) : undefined}>
            {prospect.links.length === 0 ? (
              <p className="text-sm text-tertiary">Aucun lien enregistré.</p>
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
          </Panel>

          <Panel title="Images" badge={prospect.images.length ? String(prospect.images.length) : undefined}>
            {prospect.images.length === 0 ? (
              <p className="text-sm text-tertiary">Aucune image.</p>
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
          </Panel>

          <Panel title="Notes internes">
            {prospect.notes.trim() ? (
              <p className="text-sm whitespace-pre-wrap text-secondary">{prospect.notes}</p>
            ) : (
              <p className="text-sm text-tertiary">Rien n’a encore été noté.</p>
            )}
          </Panel>

          <Panel title="Historique du statut">
            {prospect.statusHistory.length === 0 ? (
              <p className="text-sm text-tertiary">Aucun changement consigné.</p>
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
          </Panel>
        </div>
      ) : null}

      {onglet === 'communication' ? (
        <Panel
          title="Messages"
          badge={messages.length ? String(messages.length) : undefined}
          description="Ce qu’on a envoyé, et ce qu’on compte envoyer."
        >
          <ProspectMessages
            messages={messages}
            onChange={enregistrerMessages}
            enregistrement={enregistrementMessages}
          />
        </Panel>
      ) : null}

      {onglet === 'taches' ? (
        <LinkedTasksPanel
          filtre={{ prospectId: prospect._id }}
          liensInitiaux={{ prospectIds: [prospect._id] }}
          titre={`Tâches — ${prospect.name}`}
        />
      ) : null}

      {onglet === 'suivi' ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" color="primary" onClick={() => setVolet('reunion')}>
              Planifier une réunion
            </Button>
            <Button size="sm" color="secondary" onClick={() => setVolet('evenement')}>
              Ajouter un événement passé
            </Button>
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
            <Panel title="À confirmer" badge={String(enAttente.length)}>
              {enAttente.map((e) => (
                <EventConfirmation key={e._id} event={e} onResolved={toutRecharger} />
              ))}
            </Panel>
          ) : null}

          <Panel title="Réunions à venir">
            {aVenir.length === 0 ? (
              <EmptyPanel
                title="Aucune réunion prévue"
                hint="« Planifier une réunion » en pose une, avec ce prospect pour sujet."
              />
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
          </Panel>

          <Panel title="Historique">
            {historique.length === 0 ? (
              <p className="text-sm text-tertiary">
                Rien n’a encore été consigné pour ce prospect.
              </p>
            ) : (
              <EventTimeline events={historique} onEdit={setEvenementEdite} />
            )}
          </Panel>
        </div>
      ) : null}

      {/*
        LE FORMULAIRE EST UN DIALOGUE, PAS UN BLOC INSÉRÉ DANS LA PAGE.
        Inséré, il poussait la fiche entière sous la ligne de flottaison au
        moment précis où l'on voulait comparer ce qu'on tape à ce qui existe.
      */}
      <ModalOverlay isOpen={enEdition} onOpenChange={(v) => { if (!v) setEnEdition(false); }} isDismissable>
        <Modal className="w-full max-w-3xl">
          <Dialog>
            <div className="p-4 sm:p-5">
              <ProspectForm
                prospect={prospect}
                onSaved={() => { setEnEdition(false); toutRecharger(); }}
                onCancel={() => setEnEdition(false)}
              />
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>

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
