/**
 * ACTIONS D'UNE FICHE — générer un code, révoquer son appairage.
 *
 * ══ POURQUOI CE COMPOSANT EXISTE ════════════════════════════════════════════
 *
 * La refonte de la page Appairages a retiré la table qui portait ces deux
 * boutons. Les points d'API, eux, n'ont jamais bougé : les actions étaient
 * devenues INJOIGNABLES depuis l'interface, ce qui est pire que mal rangé.
 * Elles reviennent ici, à leur place — sur la fiche qu'elles concernent.
 *
 * ══ UNE FICHE, UN APPAIRAGE ═════════════════════════════════════════════════
 *
 * Ces actions ne prennent plus d'environnement en paramètre : elles portent
 * sur LA fiche. L'environnement, quand il est connu, ne sert plus qu'à
 * calibrer la gravité de la confirmation — révoquer une production n'est pas
 * révoquer une recette.
 *
 * ══ POURQUOI UNE MODALE ET PAS `window.confirm` ═════════════════════════════
 *
 * Parce que `confirm()` ne peut pas énumérer les conséquences ni exiger une
 * confirmation renforcée en production. Il pose la question de la même façon
 * dans les deux cas, alors que ce sont deux gestes de gravité très différente.
 */
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { CopyField } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import type { PairingRow } from '@/lib/projectConnections';

/** La phrase à recopier pour révoquer une PRODUCTION. Jamais pour une recette. */
const PHRASE_PROD = 'RÉVOQUER LA PRODUCTION';

/**
 * MODALE — une seule, réutilisée par les deux actions.
 *
 * `Escape` ferme, le focus entre dedans à l'ouverture et revient d'où il
 * venait à la fermeture. Le fond ne défile pas derrière.
 */
function Modale({
  titre,
  children,
  onClose,
}: {
  titre: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const boite = useRef<HTMLDivElement>(null);
  const rendreLeFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    rendreLeFocus.current = document.activeElement as HTMLElement | null;
    boite.current?.focus();
    document.body.classList.add('no-scroll');
    const auClavier = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', auClavier);
    return () => {
      window.removeEventListener('keydown', auClavier);
      document.body.classList.remove('no-scroll');
      rendreLeFocus.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-titre"
        tabIndex={-1}
        ref={boite}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title" id="modal-titre">{titre}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConnectionActions({
  row,
  onDone,
}: {
  row: PairingRow;
  onDone: () => Promise<void> | void;
}) {
  const { project, environment, name: projectName } = row;
  const [menuOuvert, setMenuOuvert] = useState(false);
  const [dialogue, setDialogue] = useState<'REVOKE' | 'CODE' | null>(null);
  const [phrase, setPhrase] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [code, setCode] = useState<{ value: string; expiresAt: string } | null>(null);

  const estProd = environment === 'PROD';
  const appaire = project.pairing.status === 'PAIRED';
  const peutGenerer = project.pairing.status !== 'PAIRED';

  const fermer = () => {
    setDialogue(null);
    setPhrase('');
    setErreur(null);
    setCode(null);
  };

  const generer = async () => {
    setOccupe(true);
    setErreur(null);
    try {
      const res = await api.generatePairingCode(project.projectId);
      setCode({ value: res.pairingCode, expiresAt: res.pairingCodeExpiresAt });
      await onDone();
    } catch (err) {
      setErreur(errorMessage(err, 'Impossible de générer un code d’appairage.'));
    } finally {
      setOccupe(false);
    }
  };

  const revoquer = async () => {
    setOccupe(true);
    setErreur(null);
    try {
      await api.revokePairing(project.projectId);
      await onDone();
      fermer();
    } catch (err) {
      setErreur(errorMessage(err, 'Impossible de révoquer l’appairage.'));
    } finally {
      setOccupe(false);
    }
  };

  const revocationAutorisee = !estProd || phrase.trim().toUpperCase() === PHRASE_PROD;

  return (
    <>
      <div className="conn-menu">
        <button
          type="button"
          className="btn btn-secondary btn-small conn-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOuvert}
          aria-label={`Autres actions pour ${projectName}`}
          onClick={() => setMenuOuvert((o) => !o)}
        >
          •••
        </button>

        {menuOuvert ? (
          <>
            {/* Un clic hors du menu le referme, sans piéger le focus. */}
            <div className="conn-menu-veil" onClick={() => setMenuOuvert(false)} role="presentation" />
            <div className="conn-menu-list" role="menu">
              <button
                type="button"
                role="menuitem"
                className="conn-menu-item"
                disabled={!peutGenerer}
                title={
                  peutGenerer
                    ? undefined
                    : 'Cette instance est appairée : révoquez d’abord son appairage.'
                }
                onClick={() => { setMenuOuvert(false); setDialogue('CODE'); void generer(); }}
              >
                Générer un nouveau code
              </button>
              <button
                type="button"
                role="menuitem"
                className="conn-menu-item conn-menu-item-danger"
                disabled={!appaire}
                title={appaire ? undefined : 'Aucun appairage actif à révoquer.'}
                onClick={() => { setMenuOuvert(false); setDialogue('REVOKE'); }}
              >
                Révoquer l’appairage
              </button>
            </div>
          </>
        ) : null}
      </div>

      {dialogue === 'CODE' ? (
        <Modale titre="Code d’appairage" onClose={fermer}>
          <p className="modal-text">
            Ce code relie <strong>{projectName}</strong> au Panel. Il n’est affiché
            qu’une fois.
          </p>
          {erreur ? <div className="alert alert-error">{erreur}</div> : null}
          {occupe ? <p className="muted">Génération…</p> : null}
          {code ? (
            <>
              <CopyField value={code.value} label="Code" />
              <p className="muted">Expire le {formatDateTime(code.expiresAt)}.</p>
            </>
          ) : null}
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={fermer}>
              J’ai noté le code
            </button>
          </div>
        </Modale>
      ) : null}

      {dialogue === 'REVOKE' ? (
        <Modale titre="Révoquer l’appairage" onClose={fermer}>
          <p className="modal-text">
            <strong>{projectName}</strong>
            {environment ? <> (<strong>{environment}</strong>)</> : null} passera en mode
            autonome : le projet continuera de fonctionner, sans plus dialoguer avec le Panel.
          </p>
          {/*
            CE QUE LA RÉVOCATION NE FAIT PAS — dit explicitement.
            Un opérateur qui hésite à révoquer une production hésite sur les
            effets de bord. Les énumérer vaut mieux que de le laisser deviner.
          */}
          <ul className="modal-list">
            <li>Les autres fiches du parc ne sont pas touchées.</li>
            <li>La destination n’est pas supprimée.</li>
            <li>La fiche et son historique restent dans le Panel.</li>
            <li>Aucune donnée du site n’est modifiée.</li>
          </ul>

          {estProd ? (
            <label className="field">
              <span className="field-label">
                Confirmez en recopiant : <code className="inline-code">{PHRASE_PROD}</code>
              </span>
              <input
                type="text"
                value={phrase}
                autoFocus
                onChange={(e) => setPhrase(e.target.value)}
                aria-label={`Confirmer la révocation de la production de ${projectName}`}
              />
            </label>
          ) : null}

          {erreur ? <div className="alert alert-error">{erreur}</div> : null}

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={occupe} onClick={fermer}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={occupe || !revocationAutorisee}
              onClick={() => void revoquer()}
            >
              {occupe ? 'Révocation…' : 'Révoquer l’appairage'}
            </button>
          </div>
        </Modale>
      ) : null}
    </>
  );
}

export default ConnectionActions;
