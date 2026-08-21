// EXPÉDITEUR E-MAIL — l'écran unique du parc (R10.4).
//
// ── POURQUOI IL Y EN A UN SEUL ──────────────────────────────────────────────
//
// Parce qu'il y a une seule adresse. Un écran par projet suggérerait qu'on peut
// en avoir plusieurs, et la première question d'un utilisateur devant deux
// champs identiques dans deux écrans est « lequel gagne ? ». La réponse « il
// n'y en a qu'un » ne tient que si l'interface le montre.
//
// ── CE QUE L'ÉCRAN N'INVENTE PAS ────────────────────────────────────────────
//
// Ni le rapport de test (assemblé par le backend), ni le journal, ni l'état de
// livraison. Il AFFICHE. Recomposer le rapport ici ferait diverger ce qu'on
// colle dans un ticket de ce qu'on relit en base — et c'est précisément quand
// les deux divergent qu'on a besoin de les comparer.
import { useCallback, useEffect, useState } from 'react';

import { Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { isPanelDeveloper } from '@/auth/roles';
import type {
  EmailSenderScreen,
  EmailSenderTestReport,
  EmailSenderTestStatus,
} from '@/types.emailSender';

/** Ce que chaque issue veut dire, en une phrase, pour qui n'a pas lu le code. */
const STATUS_LABEL: Record<EmailSenderTestStatus, string> = {
  REQUESTED: 'Demandé — rien n’est encore parti',
  ACCEPTED: 'Accepté par le fournisseur — pas encore confirmé livré',
  REFUSED: 'Refusé — rien n’est parti',
  UNKNOWN: 'Issue indéterminée — le message est peut-être parti',
  DELIVERED: 'Livré — confirmé par le fournisseur',
  BOUNCED: 'Non remis — le fournisseur l’a signalé',
};

const STATUS_BADGE: Record<EmailSenderTestStatus, string> = {
  REQUESTED: 'warn',
  ACCEPTED: 'warn',
  REFUSED: 'error',
  UNKNOWN: 'error',
  DELIVERED: 'ok',
  BOUNCED: 'error',
};

const JOURNAL_BADGE: Record<string, string> = { PASS: 'ok', FAIL: 'error', PENDING: 'warn' };

export function EmailSenderPage() {
  const { user } = useAuth();
  const canEdit = isPanelDeveloper(user?.role);

  const [screen, setScreen] = useState<EmailSenderScreen | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [senderEmail, setSenderEmail] = useState('');
  const [senderName, setSenderName] = useState('');
  const [contactPublic, setContactPublic] = useState('');
  const [destinataire, setDestinataire] = useState('');
  const [rapport, setRapport] = useState<EmailSenderTestReport | null>(null);
  const [copie, setCopie] = useState(false);

  const charger = useCallback(async () => {
    try {
      const vue = await api.getEmailSender();
      setScreen(vue);
      setSenderEmail(vue.configuration.senderEmail ?? '');
      setSenderName(vue.configuration.senderName ?? '');
      setContactPublic(vue.publicContact?.email ?? '');
      setRapport((actuel) => actuel ?? vue.lastTest);
    } catch (err) {
      setErreur(errorMessage(err, 'Configuration d’expédition indisponible.'));
    }
  }, []);

  useEffect(() => { void charger(); }, [charger]);

  const enregistrer = async () => {
    setBusy(true); setErreur(null); setNotice(null);
    try {
      const vue = await api.saveEmailSender({ senderEmail, senderName });
      setScreen(vue);
      setNotice(
        'Expéditeur enregistré. Tous les projets et le Panel écrivent désormais sous cette adresse.',
      );
    } catch (err) {
      setErreur(errorMessage(err, 'Enregistrement refusé.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * ENREGISTRER LE CONTACT PUBLIC — écriture séparée, et volontairement.
   *
   * Un seul bouton pour les deux adresses laisserait croire qu'elles voyagent
   * ensemble. Elles ne vont pas au même endroit : l'expéditeur est une
   * configuration de plateforme, le contact public est une donnée d'identité
   * publiée aux projets. Deux gestes, deux effets, deux messages.
   */
  const enregistrerContact = async () => {
    setBusy(true);
    setErreur(null);
    setNotice(null);
    try {
      const vue = await api.savePublicContactEmail(contactPublic.trim());
      setScreen(vue);
      setContactPublic(vue.publicContact?.email ?? '');
      setNotice(
        vue.publicContact?.email
          ? 'Contact public enregistré et publié. Tous les projets appairés l’utilisent immédiatement.'
          : 'Contact public effacé. Les e-mails clients qui l’exigent seront refusés tant qu’il reste vide.',
      );
    } catch (err) {
      setErreur(errorMessage(err, 'Enregistrement impossible.'));
    } finally {
      setBusy(false);
    }
  };


  const envoyer = async () => {
    setBusy(true); setErreur(null); setNotice(null);
    try {
      setRapport(await api.sendEmailSenderTest(destinataire));
    } catch (err) {
      setErreur(errorMessage(err, 'Envoi de test refusé.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * ACTUALISER — une RELECTURE, jamais un second envoi.
   *
   * C'est la distinction que l'écran doit rendre évidente : le webhook arrive
   * après coup, et l'attendre ne doit pas écrire une deuxième fois à une
   * personne réelle. Le bouton porte donc « Actualiser », pas « Réessayer ».
   */
  const actualiser = async () => {
    if (!rapport) return;
    setBusy(true); setErreur(null);
    try {
      setRapport(await api.readEmailSenderTest(rapport.testId));
    } catch (err) {
      setErreur(errorMessage(err, 'Relecture impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const copier = async () => {
    if (!rapport) return;
    try {
      await navigator.clipboard.writeText(rapport.plainText);
      setCopie(true);
      window.setTimeout(() => setCopie(false), 2000);
    } catch {
      // Le presse-papiers peut être refusé (contexte non sécurisé). Le rapport
      // reste sélectionnable à la main dans le <pre> ci-dessous : on ne fait
      // donc rien de plus qu'échouer en silence sur le confort.
    }
  };

  if (!screen) {
    return (
      <Card title="Expéditeur e-mail">
        {erreur ? <div className="alert alert-error">{erreur}</div> : <p className="muted">Lecture…</p>}
      </Card>
    );
  }

  const { configuration } = screen;

  return (
    <>
      <Card title="Expéditeur e-mail">
        {erreur ? <div className="alert alert-error">{erreur}</div> : null}
        {notice ? <div className="alert alert-success">{notice}</div> : null}

        <p className="muted read-only-note">
          Cette adresse et ce nom sont utilisés par <strong>tous les projets</strong> et par
          le Panel lui-même. Aucun Manager ne configure d’expéditeur : un projet ne
          choisit que son adresse de réponse, à laquelle les réponses de ses clients
          arrivent.
        </p>

        <dl className="detail-list">
          <div>
            <dt>Environnement servi</dt>
            <dd><strong>{screen.environment}</strong></dd>
          </div>
          <div>
            <dt>État</dt>
            <dd>
              <span className={`badge badge-${configuration.configured ? 'ok' : 'warn'}`}>
                {configuration.configured ? 'Configuré' : 'Non configuré'}
              </span>
              {configuration.problems.length > 0 ? (
                <span className="muted"> — {configuration.problems.join(' ')}</span>
              ) : null}
            </dd>
          </div>
          {configuration.updatedAt ? (
            <div>
              <dt>Dernière modification</dt>
              <dd>{new Date(configuration.updatedAt).toLocaleString('fr-FR')}</dd>
            </div>
          ) : null}
        </dl>

        {canEdit ? (
          <div className="parameter-form">
            <label className="field">
              <span className="field-label">Adresse d’expédition (From / support)</span>
              <input type="email" value={senderEmail} maxLength={200}
                placeholder="support@exemple.fr"
                onChange={(e) => setSenderEmail(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Nom d’expéditeur (From name)</span>
              <input type="text" value={senderName} maxLength={120}
                placeholder="L.Y Solution"
                onChange={(e) => setSenderName(e.target.value)} />
            </label>
            <div className="action-buttons">
              <button type="button" className="btn" disabled={busy} onClick={() => void enregistrer()}>
                Enregistrer
              </button>
            </div>
          </div>
        ) : (
          <dl className="detail-list">
            <div>
              <dt>Adresse</dt>
              <dd>{configuration.senderEmail ?? '— non configurée —'}</dd>
            </div>
            <div>
              <dt>Nom</dt>
              <dd>{configuration.senderName ?? '— non configuré —'}</dd>
            </div>
          </dl>
        )}
      </Card>

      {/*
        ── L'ADRESSE À LAQUELLE LES CLIENTS ÉCRIVENT ─────────────────────────

        Elle est ici, sous l'expéditeur, parce que c'est ici qu'on les confond.
        « Adresse d'expédition (From / support) » se lit comme l'adresse de
        contact ; ce n'est pas la même chose, et l'une des deux peut très bien
        n'être relevée par personne.
      */}
      <Card title="E-mail de contact public">
        <p className="muted read-only-note">
          L'adresse que le pied de chaque e-mail client invite à écrire. Elle est
          <strong> distincte de l'expéditeur </strong> ci-dessus : celui-là est l'en-tête
          technique sous lequel le parc écrit, et peut être une boîte que personne ne
          relève. Celle-ci doit aboutir à un humain.
        </p>

        <dl className="detail-list">
          <div>
            <dt>Publiée pour</dt>
            <dd>{screen.publicContact?.companyName ?? '— aucune entreprise active —'}</dd>
          </div>
          <div>
            <dt>État</dt>
            <dd>
              <span className={`badge badge-${screen.publicContact?.configured ? 'ok' : 'warn'}`}>
                {screen.publicContact?.configured ? 'Configurée' : 'À renseigner'}
              </span>
              {screen.publicContact?.consequence ? (
                <span className="muted"> — {screen.publicContact.consequence}</span>
              ) : null}
            </dd>
          </div>
        </dl>

        {canEdit ? (
          <div className="parameter-form">
            <label className="field">
              <span className="field-label">E-mail de contact public</span>
              <input type="email" value={contactPublic} maxLength={200}
                placeholder="contact@exemple.fr"
                onChange={(e) => setContactPublic(e.target.value)} />
              <span className="field-hint">
                Enregistrée sur l'identité du prestataire et publiée aux projets
                appairés dans la foulée — sans redéploiement ni réappairage.
              </span>
            </label>
            <div className="action-buttons">
              <button type="button" className="btn" disabled={busy} onClick={() => void enregistrerContact()}>
                Enregistrer
              </button>
            </div>
          </div>
        ) : (
          <dl className="detail-list">
            <div>
              <dt>Adresse</dt>
              <dd>{screen.publicContact?.email ?? '— non renseignée —'}</dd>
            </div>
          </dl>
        )}
      </Card>

      <Card title="Envoyer un e-mail de test">
        <p className="muted read-only-note">
          Le test emprunte <strong>exactement</strong> la chaîne réelle : modèle du Panel,
          capacité <code>email.send_template</code>, coffre d’identifiants, fournisseur,
          puis webhook de livraison. Aucun appel de diagnostic ne le raccourcit — c’est
          ce qui lui donne sa valeur.
        </p>

        {canEdit ? (
          <div className="parameter-form">
            <label className="field">
              <span className="field-label">Destinataire</span>
              <input type="email" value={destinataire} maxLength={200}
                placeholder="vous@exemple.fr"
                onChange={(e) => setDestinataire(e.target.value)} />
            </label>
            <div className="action-buttons">
              <button type="button" className="btn" disabled={busy || !configuration.configured}
                title={configuration.configured ? undefined : 'Renseignez d’abord l’expéditeur.'}
                onClick={() => void envoyer()}>
                Envoyer un e-mail de test
              </button>
            </div>
          </div>
        ) : (
          <p className="muted read-only-note">Seul un compte DEV peut déclencher un envoi réel.</p>
        )}

        {rapport ? (
          <>
            <dl className="detail-list">
              <div>
                <dt>Issue</dt>
                <dd>
                  <span className={`badge badge-${STATUS_BADGE[rapport.status]}`}>{rapport.status}</span>{' '}
                  <span className="muted">{STATUS_LABEL[rapport.status]}</span>
                </dd>
              </div>
              <div>
                <dt>Webhook</dt>
                <dd>
                  {rapport.webhookStatus === 'RECEIVED' ? 'Reçu'
                    : rapport.webhookStatus === 'PENDING'
                      ? 'Attendu — actualisez pour vérifier'
                      : 'Sans objet'}
                </dd>
              </div>
            </dl>

            <ul className="credential-list">
              {rapport.journal.map((etape) => (
                <li key={etape.label}>
                  <span className="credential-name">{etape.label}</span>
                  <span className={`badge badge-${JOURNAL_BADGE[etape.state]}`}>{etape.state}</span>
                  {etape.detail ? <span className="muted">{etape.detail}</span> : null}
                </li>
              ))}
            </ul>

            <div className="action-buttons">
              <button type="button" className="btn btn-small" disabled={busy}
                onClick={() => void actualiser()}>
                Actualiser (n’envoie rien)
              </button>
              <button type="button" className="btn btn-small" onClick={() => void copier()}>
                {copie ? 'Copié' : 'Copier le rapport'}
              </button>
            </div>

            {/*
              Le rapport BRUT reste visible même quand le presse-papiers est
              refusé : un opérateur doit toujours pouvoir le sélectionner à la
              main pour le coller dans un ticket.
            */}
            <pre className="report-block">{rapport.plainText}</pre>
          </>
        ) : null}
      </Card>
    </>
  );
}

export default EmailSenderPage;
