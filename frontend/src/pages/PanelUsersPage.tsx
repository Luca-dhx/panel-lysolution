// LES COMPTES DU PANEL — qui existe, qui gouverne, et chez qui l'on entre.
//
// ── POURQUOI CET ÉCRAN EXISTE ───────────────────────────────────────────────
//
// Un compte Panel se créait par un script. C'était tenable tant que « avoir un
// compte » était la seule chose qu'on pouvait décider à son sujet.
//
// La fédération a changé cela : un compte porte un ACCÈS AUX PROJETS D'AUTRUI.
// Le rôle souverain va au bout : un compte se CRÉE, se MODIFIE et se SUPPRIME
// ici. Un parc dont les identités ne s'administrent qu'en base est un parc dont
// personne ne peut répondre à « qui a accès à quoi ».
//
// ── DEUX LECTURES DU MÊME ÉCRAN ─────────────────────────────────────────────
//
//   DEV          l'annuaire. Il LIT — pour répondre à « qui d'autre a accès à
//                ce projet ? » sans demander à quelqu'un. Aucune action.
//   SUPER_ADMIN  l'administration. Créer, modifier, supprimer, sur n'importe
//                quelle cible — y compris un autre souverain, y compris lui.
//
// La séparation se fait au BOUTON, pas à la porte : la liste ne porte aucun
// secret, et la fermer aux DEV n'ajouterait aucune sécurité. Ce sont les
// écritures qui sont souveraines, et le serveur les refuse de lui-même — cet
// écran ne fait que ne pas les proposer.
//
// ── CE QU'AUCUN FORMULAIRE D'ICI NE DEMANDE ─────────────────────────────────
//
// Un mot de passe. Ni à la création, ni à la modification. Le compte naît avec
// un secret que personne ne connaît, et son titulaire en prend possession par
// le lien d'activation — c'est-à-dire par le parcours de réinitialisation, qui
// existe déjà. Un administrateur ne doit jamais pouvoir se connecter à la place
// de quelqu'un.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Card, EmptyState } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/ToastProvider';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import {
  ROLE_BADGE, ROLE_HINT, ROLE_LABEL, ROLE_ORDER,
  administersPanelUsers, isPanelDeveloper,
} from '@/auth/roles';
import type { AccessibleProject, PanelUserRow, ProjectAccessMode, Role } from '@/types';

const MODE_LABEL: Record<ProjectAccessMode, string> = {
  NONE: 'Aucun accès',
  EXPLICIT: 'Projets sélectionnés',
  ALL_PAIRED: 'Tous les projets appairés',
};

/**
 * LA SÉMANTIQUE DE CHAQUE MODE, ÉCRITE À L'ÉCRAN.
 *
 * `ALL_PAIRED` est DYNAMIQUE : il couvre les projets appairés d'aujourd'hui
 * ET ceux de demain. Ne pas l'écrire ferait croire à un instantané, et
 * quelqu'un finirait par « rafraîchir la liste » d'un mode qui n'en a pas.
 */
const MODE_HINT: Record<ProjectAccessMode, string> = {
  NONE: 'Ce compte ne peut se connecter à aucun projet. C’est le réglage par défaut.',
  EXPLICIT: 'Ce compte ne peut se connecter qu’aux projets cochés ci-dessous.',
  ALL_PAIRED:
    'Ce compte peut se connecter à tous les projets actuellement appairés, '
    + 'et à ceux qui le seront plus tard. Ce n’est pas une liste figée.',
};

/** Résumé d'accès, lisible d'un coup d'œil. */
function resumeAcces(user: PanelUserRow, projets: AccessibleProject[]): string {
  const mode = user.projectAccess?.mode ?? 'NONE';
  if (mode === 'ALL_PAIRED') return 'Tous les projets appairés';
  if (mode === 'NONE') return 'Aucun accès projet';

  const ids = user.projectAccess?.projectIds ?? [];
  if (ids.length === 0) return 'Aucun accès projet';
  return ids.map((id) => projets.find((p) => p.projectId === id)?.projectName ?? id).join(', ');
}

/** Brouillon d'édition — jamais appliqué avant enregistrement. */
interface Brouillon {
  displayName: string;
  role: Role;
  enabled: boolean;
  mode: ProjectAccessMode;
  selection: string[];
}

function brouillonDe(user: PanelUserRow): Brouillon {
  return {
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled,
    mode: user.projectAccess?.mode ?? 'NONE',
    selection: user.projectAccess?.projectIds ?? [],
  };
}

export function PanelUsersPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user: moi, logout, refresh } = useAuth();

  const souverain = administersPanelUsers(moi?.role);

  const [users, setUsers] = useState<PanelUserRow[]>([]);
  const [projets, setProjets] = useState<AccessibleProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  /** Les trois surfaces modales. Une seule ouverte à la fois, par construction. */
  const [edition, setEdition] = useState<PanelUserRow | null>(null);
  const [suppression, setSuppression] = useState<PanelUserRow | null>(null);
  const [creation, setCreation] = useState(false);

  const [brouillon, setBrouillon] = useState<Brouillon | null>(null);
  const [nouveau, setNouveau] = useState({ email: '', displayName: '', role: 'DEV' as Role });

  const charger = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, availableProjects] = await Promise.all([
        api.listPanelUsers(),
        api.listAccessibleProjects(),
      ]);
      setUsers(rows);
      setProjets(availableProjects);
    } catch (err) {
      setError(errorMessage(err, 'Lecture des comptes impossible.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void charger(); }, [charger]);

  const selectionnables = useMemo(() => projets.filter((p) => p.selectable), [projets]);

  const ouvrirEdition = (user: PanelUserRow) => {
    setBrouillon(brouillonDe(user));
    setEdition(user);
  };

  const enregistrer = async () => {
    if (!edition || !brouillon) return;
    setEnCours(true);
    try {
      /**
       * ON N'ENVOIE QUE CE QUI A CHANGÉ.
       *
       * Renvoyer l'objet entier écrirait `grantedAt`/`grantedBy` à chaque
       * enregistrement, même quand l'accès n'a pas bougé — et la trace « qui a
       * ouvert ce client, et quand » désignerait la dernière correction de nom
       * plutôt que la décision d'accès. Le serveur ne journalise, lui aussi,
       * que les champs réellement modifiés.
       */
      const patch: Parameters<typeof api.updatePanelUser>[1] = {};
      if (brouillon.displayName.trim() !== edition.displayName) {
        patch.displayName = brouillon.displayName.trim();
      }
      if (brouillon.role !== edition.role) patch.role = brouillon.role;
      if (brouillon.enabled !== edition.enabled) patch.enabled = brouillon.enabled;

      const modeAvant = edition.projectAccess?.mode ?? 'NONE';
      const idsAvant = [...(edition.projectAccess?.projectIds ?? [])].sort().join(',');
      const idsApres = [...brouillon.selection].sort().join(',');
      if (brouillon.mode !== modeAvant || (brouillon.mode === 'EXPLICIT' && idsAvant !== idsApres)) {
        patch.projectAccess = {
          mode: brouillon.mode,
          ...(brouillon.mode === 'EXPLICIT' ? { projectIds: brouillon.selection } : {}),
        };
      }

      if (Object.keys(patch).length === 0) {
        setEdition(null);
        return;
      }

      await api.updatePanelUser(edition.userId, patch);
      toast.success('Compte enregistré.');
      setEdition(null);
      await charger();

      /**
       * SE MODIFIER SOI-MÊME CHANGE LA SESSION EN COURS.
       *
       * Un souverain qui se rétrograde perd l'écran sous ses pieds — c'est la
       * doctrine, et elle est assumée. Encore faut-il que l'interface le
       * REFLÈTE : sans cette relecture, la barre latérale continuerait
       * d'afficher les entrées techniques alors que l'API les refuse déjà, et
       * chaque clic répondrait par une erreur inexplicable.
       */
      if (edition.userId === moi?.userId) await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Enregistrement refusé.'));
    } finally {
      setEnCours(false);
    }
  };

  const creer = async () => {
    setEnCours(true);
    try {
      const cree = await api.createPanelUser({
        email: nouveau.email.trim(),
        displayName: nouveau.displayName.trim(),
        role: nouveau.role,
      });
      toast.success(
        cree.invitation?.sent
          ? `Compte créé. Un lien d’activation a été envoyé à ${cree.email}.`
          : `Compte créé, mais l’e-mail d’activation n’est pas parti (${cree.invitation?.code}). `
            + 'Utilisez « Renvoyer le lien » depuis la fiche.',
      );
      setCreation(false);
      setNouveau({ email: '', displayName: '', role: 'DEV' });
      await charger();
    } catch (err) {
      toast.error(errorMessage(err, 'Création refusée.'));
    } finally {
      setEnCours(false);
    }
  };

  const renvoyerLien = async (user: PanelUserRow) => {
    try {
      const r = await api.sendPanelUserInvitation(user.userId);
      if (r.invitation?.sent) toast.success(`Lien envoyé à ${user.email}.`);
      else toast.error(`L’e-mail n’est pas parti (${r.invitation?.code}).`);
    } catch (err) {
      toast.error(errorMessage(err, 'Envoi impossible.'));
    }
  };

  const supprimer = async () => {
    if (!suppression) return;
    setEnCours(true);
    try {
      const r = await api.deletePanelUser(suppression.userId);
      setSuppression(null);

      /**
       * SUPPRIMER SON PROPRE COMPTE FERME SA PROPRE SESSION.
       *
       * Le serveur a déjà tranché : la requête suivante recevra un 401, parce
       * que `requirePanelUser` ne trouvera plus le compte. L'écran ne fait donc
       * pas une décision de sécurité — il évite une expérience absurde, où
       * l'application resterait affichée et répondrait par des erreurs jusqu'au
       * prochain rechargement.
       */
      if (r.selfDeletion) {
        logout();
        navigate('/login', { replace: true });
        return;
      }
      toast.success('Compte supprimé.');
      await charger();
    } catch (err) {
      toast.error(errorMessage(err, 'Suppression refusée.'));
    } finally {
      setEnCours(false);
    }
  };

  if (loading) return <p className="muted">Chargement des comptes…</p>;

  const restantsSouverains = users.filter((u) => u.role === 'SUPER_ADMIN').length;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Comptes L.Y Solution</h1>
        <p className="page-description">
          Les identités de l’équipe, leur rôle, et les projets dans lesquels elles
          peuvent entrer. Un compte actif n’a, par défaut, accès à aucun projet :
          l’accès est un acte.
        </p>
        {souverain ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreation(true)}>
            Créer un utilisateur
          </button>
        ) : (
          <p className="muted">
            Lecture seule. La création, les rôles et les accès aux projets
            s’administrent depuis un compte Super Admin.
          </p>
        )}
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {users.length === 0 ? (
        <EmptyState title="Aucun compte" hint="Le compte d’amorçage est créé au démarrage du backend." />
      ) : (
        <Card title="Comptes">
          <div className="panel-users">
            {users.map((user) => {
              const estMoi = user.userId === moi?.userId;
              const federable = isPanelDeveloper(user.role);
              return (
                <div key={user.userId} className="panel-user">
                  <div className="panel-user-head">
                    <div>
                      <p>
                        <strong>{user.displayName}</strong>
                        {estMoi ? <span className="muted"> — vous</span> : null}
                      </p>
                      <p className="muted">{user.email}</p>
                    </div>
                    <div className="panel-user-badges">
                      {/*
                        LE RÔLE SOUVERAIN SE DISTINGUE, SANS CHANGER DE LANGAGE.
                        `badge-warn` et non une classe inventée : trois familles
                        de badge existent déjà dans ce Panel, en ajouter une
                        quatrième pour un seul écran ferait diverger la charte.
                      */}
                      <span className={ROLE_BADGE[user.role]}>{ROLE_LABEL[user.role]}</span>
                      <span className={`badge ${user.enabled ? 'badge-ok' : 'badge-warn'}`}>
                        {user.enabled ? 'Compte actif' : 'Compte désactivé'}
                      </span>
                      {user.activated === false ? (
                        <span className="badge badge-muted" title="Le titulaire n’a pas encore choisi son mot de passe.">
                          Activation en attente
                        </span>
                      ) : null}

                      {souverain ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary btn-small"
                            onClick={() => ouvrirEdition(user)}
                          >
                            Modifier
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-small"
                            onClick={() => setSuppression(user)}
                          >
                            Supprimer
                          </button>
                        </>
                      ) : estMoi ? (
                        <Link to="/mon-profil" className="btn btn-small">Modifier mon profil</Link>
                      ) : null}
                    </div>
                  </div>

                  <div className="panel-user-access">
                    <div className="panel-user-access-head">
                      <span className="muted">Accès aux projets</span>
                      <strong>{resumeAcces(user, projets)}</strong>
                      {/*
                        UN ACCÈS PROJET SUR UN COMPTE QUI NE PEUT PAS FÉDÉRER
                        N'OUVRE RIEN. Le rôle est vérifié AVANT l'accès à
                        l'émission : un ADMIN porteur d'un `projectAccess`
                        hérité reste dehors. Le dire ici évite de croire à une
                        panne le jour où quelqu'un le constate.
                      */}
                      {!federable && (user.projectAccess?.mode ?? 'NONE') !== 'NONE' ? (
                        <span className="muted">
                          — sans effet : le rôle {ROLE_LABEL[user.role]} n’ouvre aucun projet.
                        </span>
                      ) : null}
                    </div>
                    {user.grantedAt ? (
                      <p className="muted panel-user-trace">
                        Accordé le {new Date(user.grantedAt).toLocaleString('fr-FR')}
                        {user.grantedBy ? ` par ${user.grantedBy}` : ''}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ══ CRÉATION ══════════════════════════════════════════════════════ */}
      {creation ? (
        <Modal
          title="Créer un utilisateur"
          hint="Aucun mot de passe n’est défini ici : le titulaire recevra un lien d’activation et choisira le sien."
          onClose={() => setCreation(false)}
        >
          <label className="field">
            <span className="field-label">Nom affiché</span>
            <input
              value={nouveau.displayName}
              onChange={(e) => setNouveau((n) => ({ ...n, displayName: e.target.value }))}
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">Adresse e-mail</span>
            <input
              type="email"
              value={nouveau.email}
              onChange={(e) => setNouveau((n) => ({ ...n, email: e.target.value }))}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <ChoixRole valeur={nouveau.role} onChange={(role) => setNouveau((n) => ({ ...n, role }))} />
          <div className="panel-user-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={enCours || nouveau.email.trim().length < 3 || nouveau.displayName.trim().length < 2}
              onClick={() => void creer()}
            >
              Créer et envoyer l’invitation
            </button>
            <button type="button" className="btn btn-secondary" disabled={enCours} onClick={() => setCreation(false)}>
              Annuler
            </button>
          </div>
        </Modal>
      ) : null}

      {/* ══ ÉDITION ═══════════════════════════════════════════════════════ */}
      {edition && brouillon ? (
        <Modal
          title={`Modifier ${edition.displayName}`}
          hint={edition.userId === moi?.userId
            ? 'Ceci est votre compte. Un changement de rôle ou une désactivation prend effet immédiatement.'
            : undefined}
          onClose={() => setEdition(null)}
        >
          <label className="field">
            <span className="field-label">Nom affiché</span>
            <input
              value={brouillon.displayName}
              onChange={(e) => setBrouillon((b) => (b ? { ...b, displayName: e.target.value } : b))}
            />
          </label>

          {/*
            L'ADRESSE EST EN LECTURE SEULE, ET L'ÉCRAN DIT POURQUOI.
            C'est l'identifiant de connexion. La changer sans procédure de
            vérification ferait perdre son compte à qui se trompe de frappe, et
            aucune telle procédure n'existe. Un champ grisé sans explication
            passerait pour un oubli.
          */}
          <label className="field">
            <span className="field-label">Adresse e-mail</span>
            <input value={edition.email} readOnly disabled />
            <span className="muted">
              L’adresse est l’identifiant de connexion : elle ne se modifie pas tant
              qu’aucun parcours de vérification n’existe.
            </span>
          </label>

          <ChoixRole
            valeur={brouillon.role}
            onChange={(role) => setBrouillon((b) => (b ? { ...b, role } : b))}
          />

          <label className="panel-user-mode">
            <input
              type="checkbox"
              checked={brouillon.enabled}
              onChange={(e) => setBrouillon((b) => (b ? { ...b, enabled: e.target.checked } : b))}
            />
            <span>
              Compte actif
              <span className="muted">
                {' '}— désactiver ferme immédiatement ses sessions, ici et dans les projets.
              </span>
            </span>
          </label>

          <div className="panel-user-editor">
            <p className="field-label">Accès aux projets</p>
            {ROLE_ORDER.includes(brouillon.role) && !isPanelDeveloper(brouillon.role) ? (
              <p className="muted">
                Le rôle {ROLE_LABEL[brouillon.role]} n’ouvre aucun projet client :
                ce réglage sera enregistré, mais restera sans effet.
              </p>
            ) : null}
            {(['NONE', 'EXPLICIT', 'ALL_PAIRED'] as ProjectAccessMode[]).map((valeur) => (
              <label key={valeur} className="panel-user-mode">
                <input
                  type="radio"
                  name={`mode-${edition.userId}`}
                  checked={brouillon.mode === valeur}
                  onChange={() => setBrouillon((b) => (b ? { ...b, mode: valeur } : b))}
                />
                <span>{MODE_LABEL[valeur]}</span>
              </label>
            ))}
            <p className="muted">{MODE_HINT[brouillon.mode]}</p>

            {brouillon.mode === 'EXPLICIT' ? (
              <div className="panel-user-projects">
                {selectionnables.length === 0 ? (
                  <p className="muted">Aucun projet appairé : il n’y a rien à accorder pour l’instant.</p>
                ) : (
                  selectionnables.map((projet) => (
                    <label key={projet.projectId} className="panel-user-project">
                      <input
                        type="checkbox"
                        checked={brouillon.selection.includes(projet.projectId)}
                        onChange={(event) => setBrouillon((b) => (b ? {
                          ...b,
                          selection: event.target.checked
                            ? [...b.selection, projet.projectId]
                            : b.selection.filter((id) => id !== projet.projectId),
                        } : b))}
                      />
                      <span>
                        {projet.projectName}
                        <span className="muted"> · {projet.projectId}</span>
                        {projet.environment ? <span className="muted"> · {projet.environment}</span> : null}
                      </span>
                    </label>
                  ))
                )}
                {/*
                  LES PROJETS NON APPAIRÉS SONT MONTRÉS, MAIS PAS COCHABLES.
                  Les masquer ferait croire qu'ils n'existent pas ; les rendre
                  cochables ferait accorder un accès que le serveur refusera.
                */}
                {projets.filter((p) => !p.selectable).map((projet) => (
                  <p key={projet.projectId} className="muted panel-user-project-off">
                    {projet.projectName} — appairage {projet.pairingStatus ?? 'inconnu'}, aucun accès possible
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="panel-user-actions">
            <button type="button" className="btn" disabled={enCours} onClick={() => void enregistrer()}>
              Enregistrer
            </button>
            <button type="button" className="btn btn-secondary" disabled={enCours} onClick={() => setEdition(null)}>
              Annuler
            </button>
            {/*
              LE MOT DE PASSE NE S'ÉDITE PAS ICI — jamais. On peut seulement
              renvoyer au titulaire le moyen de le choisir lui-même.
            */}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={enCours}
              onClick={() => void renvoyerLien(edition)}
            >
              {edition.activated === false ? 'Renvoyer le lien d’activation' : 'Envoyer un lien de réinitialisation'}
            </button>
          </div>
        </Modal>
      ) : null}

      {/* ══ SUPPRESSION ═══════════════════════════════════════════════════ */}
      {suppression ? (
        <Modal
          danger
          title="Supprimer définitivement cet utilisateur ?"
          onClose={() => setSuppression(null)}
        >
          <p>
            <strong>{suppression.displayName}</strong><br />
            <span className="muted">{suppression.email}</span><br />
            <span className="muted">{ROLE_LABEL[suppression.role]}</span>
          </p>

          {/*
            ══ LA CONFIRMATION EST LA SEULE PROTECTION, ET C'EST VOULU ═══════

            Aucun refus serveur ne défend ce geste : ni « on ne supprime pas un
            Super Admin », ni « il doit en rester un ». Ces gardes protègent
            d'une maladresse et empêchent une décision légitime — céder la
            souveraineté, fermer un compte de transition — tout en donnant une
            fausse assurance, puisqu'elles ne couvrent aucune des autres façons
            de perdre l'accès.
            Ce qui reste, alors, doit NOMMER la conséquence. Pas une double
            saisie, pas un mot à recopier : une phrase exacte.
          */}
          {suppression.role === 'SUPER_ADMIN' ? (
            <div className="alert alert-error">
              Ce compte est Super Admin. Sa suppression révoquera immédiatement son
              accès au Panel et aux projets fédérés.
              {restantsSouverains <= 1
                ? ' Cette action peut retirer le dernier Super Admin : plus aucun écran ne permettrait d’en désigner un nouveau.'
                : ''}
            </div>
          ) : null}
          {suppression.userId === moi?.userId ? (
            <div className="alert alert-error">
              C’est VOTRE compte. Vous serez déconnecté immédiatement et ne pourrez
              plus vous reconnecter.
            </div>
          ) : null}

          <p className="muted">
            Ses sessions Panel sont invalidées, ses sessions projet fédérées se
            ferment à leur prochaine revalidation, et aucune nouvelle fédération
            n’est possible. Les comptes locaux des projets ne sont pas touchés, et
            le journal d’audit conserve ses actes.
          </p>

          <div className="panel-user-actions">
            <button type="button" className="btn btn-danger" disabled={enCours} onClick={() => void supprimer()}>
              Supprimer l’utilisateur
            </button>
            <button type="button" className="btn btn-secondary" disabled={enCours} onClick={() => setSuppression(null)}>
              Annuler
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * LE CHOIX DU RÔLE — un seul composant pour la création et l'édition.
 *
 * Deux listes déroulantes écrites séparément finiraient par proposer des rôles
 * différents : c'est le même vocabulaire, et il n'a qu'une définition
 * (`@/auth/roles`). La phrase sous le choix dit ce que le rôle DONNE, parce
 * qu'« Admin » et « Super Admin » ne se distinguent pas par leur nom.
 */
function ChoixRole({ valeur, onChange }: { valeur: Role; onChange: (role: Role) => void }) {
  return (
    <div className="field">
      <span className="field-label">Rôle</span>
      {ROLE_ORDER.map((role) => (
        <label key={role} className="panel-user-mode">
          <input
            type="radio"
            name="panel-user-role"
            checked={valeur === role}
            onChange={() => onChange(role)}
          />
          <span>{ROLE_LABEL[role]}</span>
        </label>
      ))}
      <p className="muted">{ROLE_HINT[valeur]}</p>
    </div>
  );
}

export default PanelUsersPage;
