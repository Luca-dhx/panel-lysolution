/**
 * LA COMMUNICATION AVEC UN PROSPECT — ce qu'on a envoyé, ce qu'on compte envoyer.
 *
 * ══ CE QUE CET ONGLET N'EST PAS ═════════════════════════════════════════════
 *
 * Ce n'est pas une messagerie. Rien n'est envoyé d'ici, aucun serveur de mail
 * n'est appelé, aucun accusé n'est reçu. C'est un CARNET : on y écrit ce qu'on
 * a dit, et ce qu'on prévoit de dire. La différence compte, parce qu'un écran
 * qui ressemble à une boîte d'envoi laisse croire que le bouton envoie.
 *
 * ══ DEUX SOUS-ONGLETS, ET NON DEUX LISTES EMPILÉES ═════════════════════════
 *
 * Ce qui reste à envoyer appelle une action ; ce qui est parti est de la
 * mémoire. Ce sont deux intentions, et on n'est jamais dans les deux à la fois :
 * ou l'on prépare la prochaine relance, ou l'on relit ce qu'on a déjà dit.
 *
 * Empilées, les deux listes se poussaient l'une l'autre. Sur un prospect suivi
 * depuis trois mois, relire la dernière accroche envoyée demandait de faire
 * défiler quatre brouillons — dont chacun occupe la hauteur de son texte,
 * puisqu'un message se lit en entier ou ne sert à rien.
 *
 * L'onglet d'arrivée est celui qui a quelque chose à faire : « À envoyer » s'il
 * reste des brouillons, « Envoyés » sinon. Ouvrir sur un onglet vide quand
 * l'autre est plein oblige à un clic pour rien, à chaque visite.
 *
 * ══ LE CANAL EST DU TEXTE LIBRE ════════════════════════════════════════════
 *
 * « e-mail », « LinkedIn », « SMS », « au téléphone », « via son associé ». Une
 * liste fermée aurait forcé « Autre » dans la moitié des cas, et « Autre » ne
 * dit rien à celui qui relit six mois plus tard.
 */
import { useEffect, useState } from 'react';
import { Badge } from '@/components/base/badges/badges';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Input } from '@/components/base/input/input';
import { TextArea } from '@/components/base/textarea/textarea';
import { Icon } from '@/components/Icon';
import { SmoothTabs } from '@/components/ui-kit';
import { formatDateTime } from '@/lib/format';
import type { ProspectMessage } from '@/types.prospection';

const identifiant = () => (
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `msg-${Math.random().toString(36).slice(2)}`
);

const VIDE: ProspectMessage = {
  id: '', channel: '', title: '', body: '', sentAt: null,
};

function MessageCard({
  message, onEdit, onDelete, onToggleSent, pulse, onPulse,
}: {
  message: ProspectMessage;
  onEdit: () => void;
  onDelete: () => void;
  onToggleSent: () => void;
  /** VRAI le temps de l'animation de confirmation. Décidé par le parent. */
  pulse: boolean;
  onPulse: (id: string) => void;
}) {
  const envoye = Boolean(message.sentAt);

  const basculer = () => {
    /* La pulsation ne se joue QUE dans le sens « c'est fait ». Repasser en
       « à envoyer » est une correction, pas un accomplissement : la fêter
       apprendrait à ignorer la fête. */
    if (!envoye) onPulse(message.id);
    onToggleSent();
  };
  return (
    <article className="rounded-xl border border-secondary bg-primary p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-primary">
              {message.title || 'Sans titre'}
            </h4>
            {message.channel ? (
              <Badge size="sm" color="gray" type="pill-color">{message.channel}</Badge>
            ) : null}
            <Badge size="sm" color={envoye ? 'success' : 'orange'} type="pill-color">
              {envoye ? 'Envoyé' : 'À envoyer'}
            </Badge>
          </div>
          {envoye && message.sentAt ? (
            <p className="mt-0.5 text-xs text-tertiary">{formatDateTime(message.sentAt)}</p>
          ) : null}
        </div>
      </header>

      {message.body.trim() ? (
        /*
          LE CONTENU EST RENDU TEL QU'IL A ÉTÉ ÉCRIT.
          C'est un message destiné à être copié-collé ailleurs : ses retours à
          la ligne et ses paragraphes font partie du texte, et les écraser
          obligerait à les refaire à la main après chaque copie.
        */
        <p className="mt-3 text-sm whitespace-pre-wrap text-secondary">{message.body}</p>
      ) : (
        <p className="mt-3 text-sm text-quaternary">Contenu non rédigé.</p>
      )}

      {/*
        ── TROIS BOUTONS, UNE RANGÉE ─────────────────────────────────────────

        Même taille, même rembourrage, même hauteur : c'est ce qui les fait lire
        comme un ensemble de choix, et non comme un bouton suivi de deux liens.
        Chacun porte son icône — on reconnaît une coche, un crayon et une
        corbeille avant d'avoir lu le libellé.

        Les couleurs disent ce qui se passe : vert on avance, orange on revient
        en arrière, rouge on retire, et « Modifier » reste NEUTRE. Trois aplats
        côte à côte se vaudraient visuellement, et l'œil ne saurait plus lequel
        est la décision.

        `flex-wrap` : à 320 px, trois boutons ne tiennent pas sur une ligne, et
        les comprimer rendrait leurs libellés illisibles. Ils passent à la ligne
        en gardant leur alignement à gauche.
      */}
      <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-secondary pt-3">
        <Button
          size="sm"
          className={`${envoye ? 'act-warn' : 'act-ok'}${pulse ? ' act-pulse' : ''}`}
          iconLeading={() => <Icon name={envoye ? 'arrow-clockwise' : 'check2'} />}
          onClick={basculer}
        >
          {envoye ? 'Marquer « à envoyer »' : 'Marquer envoyé'}
        </Button>
        <Button
          size="sm"
          className="act-neutral"
          iconLeading={() => <Icon name="pencil" />}
          onClick={onEdit}
        >
          Modifier
        </Button>
        <Button
          size="sm"
          className="act-danger"
          iconLeading={() => <Icon name="trash" />}
          onClick={onDelete}
        >
          Supprimer
        </Button>
      </footer>
    </article>
  );
}

export function ProspectMessages({
  messages, onChange, enregistrement,
}: {
  messages: ProspectMessage[];
  onChange: (messages: ProspectMessage[]) => Promise<void> | void;
  enregistrement?: boolean;
}) {
  const [edite, setEdite] = useState<ProspectMessage | null>(null);
  const [ouvert, setOuvert] = useState(false);
  /*
    L'ONGLET N'EST CHOISI QU'UNE FOIS, à l'ouverture de la fiche. Le recalculer
    à chaque rendu ferait sauter l'écran sous les doigts : marquer le dernier
    brouillon comme envoyé viderait « À envoyer », et l'on se retrouverait
    projeté dans « Envoyés » à l'instant même du clic.
  */
  const [groupe, setGroupe] = useState<'a-envoyer' | 'envoyes'>(
    () => (messages.some((m) => !m.sentAt) ? 'a-envoyer' : 'envoyes'),
  );

  /**
   * LA PULSATION EST TENUE PAR LE PARENT, ET C'EST UNE CORRECTION.
   *
   * Une première version la gardait dans la carte. Elle ne se jouait jamais :
   * marquer un message envoyé le fait passer du groupe « à envoyer » au groupe
   * « envoyés » — il change donc de position dans l'arbre React, qui démonte la
   * carte et la remonte ailleurs. L'état partait avec.
   *
   * Constaté sur l'instance déployée : `act-pulse` absent 120 ms après le clic,
   * aucune animation, aucune erreur.
   *
   * Le parent, lui, survit au déplacement. Il retient l'IDENTIFIANT du message
   * qui vient d'être envoyé, et la carte — où qu'elle soit — se reconnaît.
   *
   * Le minuteur est annulé au démontage : sans cela, changer d'onglet pendant
   * la demi-seconde d'animation ferait écrire dans un composant disparu.
   */
  const [pulse, setPulse] = useState<string | null>(null);
  useEffect(() => {
    if (!pulse) return undefined;
    const t = setTimeout(() => setPulse(null), 600);
    return () => clearTimeout(t);
  }, [pulse]);

  const prevus = messages.filter((m) => !m.sentAt);
  /*
    LES ENVOYÉS SE LISENT DU PLUS RÉCENT AU PLUS ANCIEN.
    C'est l'ordre dans lequel on les cherche : « qu'est-ce que je lui ai dit la
    dernière fois ? » se pose avant « par quoi avais-je commencé ? ». Les
    brouillons, eux, gardent leur ordre de saisie — c'est celui dans lequel on
    prévoit de les envoyer.
  */
  const envoyes = messages
    .filter((m) => m.sentAt)
    .slice()
    .sort((a, b) => new Date(b.sentAt ?? 0).getTime() - new Date(a.sentAt ?? 0).getTime());

  const ouvrir = (message: ProspectMessage | null) => {
    setEdite(message ?? { ...VIDE, id: identifiant() });
    setOuvert(true);
  };

  const enregistrer = async () => {
    if (!edite) return;
    const existe = messages.some((m) => m.id === edite.id);
    await onChange(existe
      ? messages.map((m) => (m.id === edite.id ? edite : m))
      : [...messages, edite]);
    setOuvert(false);
    setEdite(null);
  };

  return (
    <div className="uui flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-tertiary">
          Un carnet, pas une messagerie : rien n’est envoyé d’ici.
        </p>
        <Button
          size="sm"
          color="primary"
          iconLeading={() => <Icon name="plus-lg" />}
          onClick={() => ouvrir(null)}
          isDisabled={enregistrement}
        >
          Nouveau message
        </Button>
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-tertiary">
          Aucun message. Notez ici ce que vous avez envoyé, ou ce que vous
          comptez envoyer — le canal, un titre pour vous y retrouver, et le
          texte.
        </p>
      ) : (
        <>
          {/*
            LE COMPTE EST DANS L'ONGLET, pas au-dessus de la liste : c'est ce
            qui permet de savoir qu'il reste trois brouillons SANS y aller.
            Un onglet vide reste affiché — le masquer ferait croire que la
            notion n'existe pas, et le ferait réapparaître sans prévenir.
          */}
          <SmoothTabs
            tabs={[
              { value: 'a-envoyer' as const, label: 'À envoyer', badge: String(prevus.length) },
              {
                value: 'envoyes' as const,
                label: envoyes.length > 1 ? 'Envoyés' : 'Envoyé',
                badge: String(envoyes.length),
              },
            ]}
            value={groupe}
            onChange={setGroupe}
            /* Cet écran porte déjà les onglets de la FICHE. Deux indicateurs
               partageant un identifiant se voleraient l'un l'autre. */
            layoutId="prospect-messages-tabs"
          />

          {groupe === 'a-envoyer' ? (
            prevus.length === 0 ? (
              <p className="text-sm text-tertiary">
                Rien en attente. Tout ce qui est écrit est parti.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {prevus.map((m) => (
                  <MessageCard
                    key={m.id}
                    message={m}
                    onEdit={() => ouvrir(m)}
                    onDelete={() => onChange(messages.filter((x) => x.id !== m.id))}
                    onToggleSent={() => onChange(messages.map((x) => (
                      x.id === m.id ? { ...x, sentAt: new Date().toISOString() } : x
                    )))}
                    pulse={pulse === m.id}
                    onPulse={setPulse}
                  />
                ))}
              </div>
            )
          ) : (
            envoyes.length === 0 ? (
              <p className="text-sm text-tertiary">
                Rien n’a encore été envoyé à ce prospect.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {envoyes.map((m) => (
                  <MessageCard
                    key={m.id}
                    message={m}
                    onEdit={() => ouvrir(m)}
                    onDelete={() => onChange(messages.filter((x) => x.id !== m.id))}
                    onToggleSent={() => onChange(messages.map((x) => (
                      x.id === m.id ? { ...x, sentAt: null } : x
                    )))}
                    pulse={pulse === m.id}
                    onPulse={setPulse}
                  />
                ))}
              </div>
            )
          )}
        </>
      )}

      <ModalOverlay isOpen={ouvert} onOpenChange={(v) => { if (!v) { setOuvert(false); setEdite(null); } }} isDismissable>
        <Modal className="w-full max-w-xl">
          <Dialog>
            <div className="uui flex flex-col gap-4 p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-primary">
                {messages.some((m) => m.id === edite?.id) ? 'Modifier le message' : 'Nouveau message'}
              </h2>

              <Input
                label="Canal"
                placeholder="E-mail, LinkedIn, au téléphone…"
                value={edite?.channel ?? ''}
                onChange={(v) => setEdite((m) => (m ? { ...m, channel: v } : m))}
              />
              <Input
                label="Titre"
                hint="Interne, jamais envoyé — « premier contact », « relance 1 »."
                placeholder="Premier contact"
                value={edite?.title ?? ''}
                onChange={(v) => setEdite((m) => (m ? { ...m, title: v } : m))}
              />
              <TextArea
                label="Contenu"
                rows={8}
                placeholder="Le texte du message."
                value={edite?.body ?? ''}
                onChange={(v) => setEdite((m) => (m ? { ...m, body: v } : m))}
              />

              <label className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={Boolean(edite?.sentAt)}
                  onChange={(e) => setEdite((m) => (m ? {
                    ...m,
                    /* Cocher pose l'instant du geste ; décocher l'efface. Un
                       seul champ porte l'état, donc rien à réconcilier. */
                    sentAt: e.target.checked ? (m.sentAt ?? new Date().toISOString()) : null,
                  } : m))}
                />
                Déjà envoyé
              </label>

              <footer className="flex flex-wrap justify-end gap-2 border-t border-secondary pt-4">
                <Button color="secondary" onClick={() => { setOuvert(false); setEdite(null); }}>
                  Annuler
                </Button>
                <Button color="primary" onClick={enregistrer} isLoading={enregistrement}>
                  Enregistrer
                </Button>
              </footer>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

export default ProspectMessages;
