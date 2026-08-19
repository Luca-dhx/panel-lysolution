import { useCallback, useEffect, useState } from 'react';

import { Card } from '@/components/ui';
import { useToast } from '@/components/ToastProvider';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import type { OwnProfile } from '@/types';

/**
 * MON PROFIL — la SEULE surface d'édition personnelle (L12.C).
 *
 * ══ POURQUOI UN COMPOSANT, ET NON DEUX ÉCRANS ═══════════════════════════════
 *
 * Deux entrées y mènent : le bouton « Mon profil » de la barre latérale, et le
 * bouton « Modifier » de sa propre ligne dans `/panel-users`. Deux formulaires
 * distincts auraient divergé — l'un finirait par autoriser un champ que l'autre
 * refuse, et personne ne saurait lequel fait foi.
 *
 * Il n'y en a donc qu'un, et les deux entrées mènent à la même route.
 *
 * ══ CE QUE CET ÉCRAN NE PEUT PAS FAIRE, MÊME EN LE VOULANT ══════════════════
 *
 * Il n'envoie qu'un champ : `displayName`. Le serveur refuse tout le reste
 * (`PANEL_USER_SELF_FORBIDDEN_FIELD`) — rôle, état du compte, accès aux
 * projets. L'écran ne les affiche donc pas en lecture seule par politesse : il
 * les affiche parce que ce SONT des lectures, et rien d'autre.
 */
export function PanelUserProfileEditor() {
  const toast = useToast();
  const { refresh } = useAuth();

  const [profil, setProfil] = useState<OwnProfile | null>(null);
  const [nom, setNom] = useState('');
  const [chargement, setChargement] = useState(true);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [lienEnvoye, setLienEnvoye] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur(null);
    try {
      const donnees = await api.getOwnProfile();
      setProfil(donnees);
      setNom(donnees.displayName);
    } catch (err) {
      setErreur(errorMessage(err, 'Lecture du profil impossible.'));
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  const enregistrer = async () => {
    setEnCours(true);
    try {
      const maj = await api.updateOwnProfile({ displayName: nom });
      setProfil((avant) => (avant ? { ...avant, displayName: maj.displayName } : avant));
      /**
       * LA BARRE LATÉRALE AFFICHE CE NOM. Sans ce rafraîchissement, on
       * enregistrerait son nom et continuerait de lire l'ancien à l'écran —
       * l'utilisateur conclurait que rien n'a été pris en compte.
       */
      await refresh();
      toast.success('Profil enregistré.');
    } catch (err) {
      toast.error(errorMessage(err, 'Enregistrement refusé.'));
    } finally {
      setEnCours(false);
    }
  };

  /**
   * LE MOT DE PASSE PASSE PAR LE PARCOURS EXISTANT.
   *
   * Le Panel n'a pas de changement de mot de passe AUTHENTIFIÉ (avec saisie du
   * mot de passe actuel) — il n'a que la réinitialisation par e-mail. Plutôt
   * que d'inventer une mutation qui ne demanderait rien, on emprunte le
   * parcours éprouvé : un lien à durée limitée, à usage unique, envoyé à
   * l'adresse du compte.
   *
   * C'est un cran moins direct, et c'est le bon arbitrage : une session volée
   * ne doit pas suffire à changer un mot de passe.
   */
  const demanderLien = async () => {
    if (!profil) return;
    setEnCours(true);
    try {
      await api.forgotPassword(profil.email);
      setLienEnvoye(true);
      toast.success('Un lien de réinitialisation vient de vous être envoyé.');
    } catch (err) {
      toast.error(errorMessage(err, 'Demande impossible.'));
    } finally {
      setEnCours(false);
    }
  };

  if (chargement) return <p className="muted">Chargement du profil…</p>;
  if (erreur) return <div className="alert alert-error">{erreur}</div>;
  if (!profil) return null;

  const modifie = nom.trim() !== profil.displayName;

  return (
    <div className="profile-editor">
      <Card title="Mes informations">
        <div className="field">
          <label htmlFor="profil-nom">Nom affiché</label>
          <input
            id="profil-nom"
            type="text"
            value={nom}
            maxLength={120}
            onChange={(event) => setNom(event.target.value)}
          />
          <p className="muted">C’est ce nom qui apparaît dans le Panel et dans les journaux.</p>
        </div>

        {/*
          L'ADRESSE EST L'IDENTIFIANT DE CONNEXION.
          La changer sans procédure de vérification ferait perdre son compte à
          qui se trompe de frappe — et aucune telle procédure n'existe. Elle est
          donc en lecture, et l'écran dit à qui s'adresser.
        */}
        <div className="field">
          <label htmlFor="profil-email">Adresse e-mail</label>
          <input id="profil-email" type="email" value={profil.email} readOnly disabled />
          <p className="muted">
            L’adresse sert à se connecter : sa modification passe par un autre développeur.
          </p>
        </div>

        <div className="profile-actions">
          <button type="button" className="btn" disabled={!modifie || enCours} onClick={() => void enregistrer()}>
            Enregistrer
          </button>
          {modifie ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={enCours}
              onClick={() => setNom(profil.displayName)}
            >
              Annuler
            </button>
          ) : null}
        </div>
      </Card>

      <Card title="Mot de passe">
        <p className="muted">
          Le changement se fait par un lien envoyé à votre adresse : il est à durée limitée
          et à usage unique. Une session ouverte ne suffit pas à changer un mot de passe.
        </p>
        <div className="profile-actions">
          <button type="button" className="btn btn-secondary" disabled={enCours} onClick={() => void demanderLien()}>
            Recevoir un lien de réinitialisation
          </button>
        </div>
        {lienEnvoye ? (
          <p className="muted">Si un compte existe pour cette adresse, un message vient de partir.</p>
        ) : null}
      </Card>

      {/*
        ══ CE QUI NE S'ÉDITE PAS ICI, ET POURQUOI ON LE MONTRE QUAND MÊME ══════

        Rôle, état du compte et accès aux projets sont des PRIVILÈGES. Les
        masquer laisserait un développeur ignorer pourquoi il n'entre pas chez
        un client ; les rendre éditables lui permettrait de s'ouvrir la porte
        tout seul. On les affiche donc, en lecture, avec la marche à suivre.
      */}
      <Card title="Privilèges">
        <dl className="detail-list">
          <div>
            <dt>Rôle</dt>
            <dd><span className="badge badge-neutral">{profil.role}</span></dd>
          </div>
          <div>
            <dt>État du compte</dt>
            <dd>
              <span className={`badge ${profil.enabled ? 'badge-ok' : 'badge-warn'}`}>
                {profil.enabled ? 'Actif' : 'Désactivé'}
              </span>
            </dd>
          </div>
          <div>
            <dt>Accès aux projets</dt>
            <dd>
              {profil.projectAccess.mode === 'ALL_PAIRED'
                ? 'Tous les projets appairés'
                : profil.projectAccess.mode === 'NONE'
                  ? 'Aucun accès projet'
                  : (profil.projectAccess.projects ?? []).map((p) => p.projectName).join(', ')
                    || 'Aucun accès projet'}
            </dd>
          </div>
        </dl>
        <p className="muted">
          Ces réglages ne se modifient pas depuis votre profil. Le rôle et les accès
          aux projets s’administrent depuis « Comptes L.Y Solution », par un compte
          Super Admin.
        </p>
      </Card>
    </div>
  );
}

export default PanelUserProfileEditor;
