/**
 * ASSISTANT DE CRÉATION D'UN PROJET — une question à la fois.
 *
 * ── CE QUI EXISTAIT ─────────────────────────────────────────────────────────
 * Un bloc technique posé EN PERMANENCE au-dessus de la liste des projets :
 * champ d'adresse, bouton de test, verdict brut de la sonde, champ de nom,
 * bouton de déclaration, puis un code d'appairage surgissant plus bas dans la
 * page. Tout était visible tout le temps, y compris pour qui venait simplement
 * consulter ses clients — et rien ne disait dans quel ordre s'y prendre.
 *
 * ── POURQUOI UNE FENÊTRE, ET PAS UNE PAGE ───────────────────────────────────
 * Le cahier des charges demande qu'au retour de l'assistant la liste ne
 * clignote pas et garde son défilement. Une page dédiée démonterait la liste :
 * `useProjects` repartirait sur un premier chargement, l'écran afficherait
 * « Chargement des projets… », et le défilement retomberait en haut. En restant
 * sur la même route, la liste n'est jamais démontée — elle continue même de se
 * rafraîchir derrière la fenêtre, si bien que le nouveau projet y est déjà
 * quand on referme.
 *
 * La fenêtre réutilise ce que le Panel sait déjà faire : le voile et le
 * verrouillage du défilement du tiroir de navigation, les Cards, les champs,
 * les boutons, les pastilles. Aucune bibliothèque, aucune abstraction nouvelle.
 *
 * ── CE QUE LA SONDE PEUT DIRE, ET CE QU'ELLE NE PEUT PAS ────────────────────
 * Avant l'appairage, une seule route du projet est publique : son ping. Le
 * Panel apprend donc que l'adresse répond, que c'est bien un projet qu'il sait
 * piloter, qu'il est compatible, qu'il est libre ou déjà relié ailleurs, et le
 * nom que le projet se donne. Le logo, le slogan, l'adresse du site et
 * l'environnement ne sont PAS accessibles à ce stade — ils arrivent avec la
 * première synchronisation, après l'appairage. L'assistant le dit plutôt que
 * d'afficher des cases vides ou d'inventer une API.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyField } from '@/components/ui';
import { api, errorMessage, probeProject } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { ProbeResult } from '@/types.company';
import type { PublicProject } from '@/types';

type Etape = 'ADRESSE' | 'INFORMATIONS' | 'CONFIRMATION' | 'APPAIRAGE';

const ETAPES: { cle: Etape | 'VERIFICATION'; label: string }[] = [
  { cle: 'ADRESSE', label: 'Adresse' },
  { cle: 'VERIFICATION', label: 'Vérification' },
  { cle: 'INFORMATIONS', label: 'Informations' },
  { cle: 'CONFIRMATION', label: 'Confirmation' },
];

/**
 * MÊME normalisation que le serveur (`normalizeBackendUrl`) : schéma et hôte en
 * minuscules, port par défaut retiré, barre finale retirée. Elle sert ici à
 * DEUX choses — refuser une adresse invalide avant de partir en réseau, et
 * reconnaître un projet déjà déclaré écrit autrement.
 *
 * Rien n'est complété d'office : une adresse sans schéma n'est pas une URL, et
 * le serveur la refuserait. Mieux vaut le dire tout de suite que deviner.
 */
export function urlNormalisee(saisie: string): string | null {
  const brut = saisie.trim();
  if (!brut) return null;
  let analysee: URL;
  try {
    analysee = new URL(brut);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(analysee.protocol)) return null;
  const portParDefaut = analysee.protocol === 'https:' ? '443' : '80';
  const port = analysee.port && analysee.port !== portParDefaut ? `:${analysee.port}` : '';
  return `${analysee.protocol}//${analysee.hostname.toLowerCase()}${port}${analysee.pathname.replace(/\/+$/, '')}`;
}

/**
 * Le verdict de la sonde, dit en français d'utilisateur.
 *
 * La phrase brute du serveur nomme le pont, la version de contrat et la
 * majeure : c'est une information d'atelier, elle reste dans le repli des
 * détails techniques. Ici on dit ce qui bloque et ce qu'il faut faire.
 */
function verdict(probe: ProbeResult): { ok: boolean; titre: string; explication: string } {
  if (!probe.reachable) {
    return {
      ok: false,
      titre: 'Cette adresse ne répond pas',
      explication: 'Vérifiez l’adresse saisie, et que le projet est bien en ligne.',
    };
  }
  if (!probe.isProjectBridge) {
    return {
      ok: false,
      titre: 'Quelque chose répond, mais ce n’est pas un projet du parc',
      explication: 'L’adresse pointe vers un autre service. Demandez au projet son adresse technique.',
    };
  }
  if (!probe.compatible) {
    return {
      ok: false,
      titre: 'Ce projet n’est pas compatible avec cette version du Panel',
      explication: 'Le projet doit être mis à jour avant de pouvoir être relié.',
    };
  }
  if (probe.alreadyPaired === true) {
    return {
      ok: false,
      titre: 'Ce projet est déjà relié à un Panel',
      explication: 'Il doit d’abord être détaché de son Panel actuel avant d’être repris ici.',
    };
  }
  return {
    ok: true,
    titre: 'Projet joignable et reconnu',
    explication: 'La connexion peut être établie.',
  };
}

/** Ce que le projet dit de lui-même, à défaut son adresse — l'ordre du Panel. */
function nomAnnonce(probe: ProbeResult | null, url: string): string {
  const annonce = probe?.bridgeIdentity?.projectName?.trim();
  if (annonce) return annonce;
  const normalisee = urlNormalisee(url);
  return normalisee ? new URL(normalisee).hostname : '';
}

function Etapes({ courante }: { courante: number }) {
  return (
    <ol className="wizard-steps">
      {ETAPES.map((etape, index) => (
        <li
          key={etape.cle}
          className={
            index === courante ? 'wizard-step wizard-step-active'
              : index < courante ? 'wizard-step wizard-step-done'
                : 'wizard-step'
          }
          aria-current={index === courante ? 'step' : undefined}
        >
          <span className="wizard-step-rank">{index + 1}</span>
          <span className="wizard-step-label">{etape.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function ProjectWizard({
  projects,
  onCreated,
  onClose,
}: {
  projects: PublicProject[];
  /** Rafraîchit la liste EN PLACE : elle n'est jamais démontée. */
  onCreated: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [etape, setEtape] = useState<Etape>('ADRESSE');
  const [url, setUrl] = useState('');
  const [nom, setNom] = useState('');

  const [verification, setVerification] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [erreurSonde, setErreurSonde] = useState<string | null>(null);

  const [creation, setCreation] = useState(false);
  const [erreurCreation, setErreurCreation] = useState<string | null>(null);
  const [cree, setCree] = useState<{ projectId: string; code: string; expireLe: string } | null>(null);

  const [regeneration, setRegeneration] = useState(false);
  const [confirmeRegeneration, setConfirmeRegeneration] = useState(false);
  const [confirmeFermeture, setConfirmeFermeture] = useState(false);

  // Une opération en vol ne se laisse pas interrompre par une touche : la
  // requête partirait quand même, et l'écran ne saurait plus où il en est.
  const enVol = verification || creation || regeneration;
  // Garde de DOUBLE CLIC : `creation` passe par un rendu, pas la référence.
  // Deux clics rapprochés partaient donc tous les deux.
  const creationRef = useRef(false);
  const boite = useRef<HTMLDivElement | null>(null);

  const normalisee = urlNormalisee(url);
  const dejaDeclare = normalisee
    ? projects.find((p) => p.runtime.publicBackendUrl === normalisee) ?? null
    : null;
  const projetCree = cree ? projects.find((p) => p.projectId === cree.projectId) ?? null : null;
  const expire = cree ? new Date(cree.expireLe).getTime() < Date.now() : false;

  const rangEtape = etape === 'ADRESSE' ? (verification ? 1 : 0)
    : etape === 'INFORMATIONS' ? 2 : 3;

  /* ── Fermeture ──────────────────────────────────────────────────────────── */
  // Avant création : rien n'est en base, on ferme sans rien demander. Après :
  // le code ne sera plus jamais affiché, on prévient.
  const demanderFermeture = () => {
    if (enVol) return;
    if (etape === 'APPAIRAGE' && !confirmeFermeture) {
      setConfirmeFermeture(true);
      return;
    }
    onClose();
  };

  useEffect(() => {
    document.body.classList.add('no-scroll');
    boite.current?.focus();
    return () => document.body.classList.remove('no-scroll');
  }, []);

  useEffect(() => {
    const auClavier = (e: KeyboardEvent) => {
      if (e.key === 'Escape') demanderFermeture();
      if (e.key !== 'Tab' || !boite.current) return;
      // Piège à focus : la tabulation reste dans la fenêtre, sinon elle part
      // dans la liste qui continue de vivre derrière.
      const cibles = boite.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, a[href], summary, [tabindex]:not([tabindex="-1"])',
      );
      if (cibles.length === 0) return;
      const premier = cibles[0];
      const dernier = cibles[cibles.length - 1];
      if (!e.shiftKey && document.activeElement === dernier) {
        e.preventDefault();
        premier.focus();
      } else if (e.shiftKey && document.activeElement === premier) {
        e.preventDefault();
        dernier.focus();
      }
    };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  });

  /* ── Étape 2 — le test de connexion ─────────────────────────────────────── */
  const tester = async () => {
    if (!normalisee || verification) return;
    setErreurSonde(null);
    setProbe(null);
    setVerification(true);
    try {
      const resultat = await probeProject(normalisee);
      setProbe(resultat);
      if (verdict(resultat).ok) {
        setNom((actuel) => actuel.trim() || nomAnnonce(resultat, normalisee));
        setEtape('INFORMATIONS');
      }
    } catch (err) {
      setErreurSonde(errorMessage(err, 'La vérification n’a pas abouti.'));
    } finally {
      setVerification(false);
    }
  };

  /* ── Étape 5 — la création ──────────────────────────────────────────────── */
  const creer = async () => {
    if (creationRef.current || !normalisee) return;
    creationRef.current = true;
    setErreurCreation(null);
    setCreation(true);
    try {
      const res = await api.createProject({
        url: normalisee,
        ...(nom.trim() ? { projectName: nom.trim() } : {}),
      });
      setCree({
        projectId: res.project.projectId,
        code: res.pairingCode,
        expireLe: res.pairingCodeExpiresAt,
      });
      setEtape('APPAIRAGE');
      // La liste se met à jour SOUS la fenêtre, sans être démontée.
      await onCreated();
    } catch (err) {
      // On reste dans l'assistant : la saisie est intacte, l'utilisateur voit
      // ce qui bloque et peut corriger.
      setErreurCreation(errorMessage(err, 'Le projet n’a pas pu être créé.'));
    } finally {
      setCreation(false);
      creationRef.current = false;
    }
  };

  const regenerer = async () => {
    if (!cree || regeneration) return;
    setRegeneration(true);
    try {
      const res = await api.generatePairingCode(cree.projectId);
      setCree({ ...cree, code: res.pairingCode, expireLe: res.pairingCodeExpiresAt });
      setConfirmeRegeneration(false);
    } catch (err) {
      setErreurCreation(errorMessage(err, 'Le code n’a pas pu être regénéré.'));
    } finally {
      setRegeneration(false);
    }
  };

  const etatAppairage = projetCree?.pairing.status === 'PAIRED'
    ? { label: 'Appairé', tone: 'ok' }
    : expire
      ? { label: 'Code expiré', tone: 'danger' }
      : { label: 'En attente du projet', tone: 'warn' };

  return (
    <div className="wizard-scrim" role="presentation" onClick={demanderFermeture}>
      <div
        className="wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-titre"
        tabIndex={-1}
        ref={boite}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wizard-head">
          <h2 id="wizard-titre">Créer un projet</h2>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={enVol}
            onClick={demanderFermeture}
          >
            Fermer
          </button>
        </header>

        {etape === 'APPAIRAGE' ? null : <Etapes courante={rangEtape} />}

        <div className="wizard-body">
          {/* ── 1. ADRESSE ─────────────────────────────────────────────── */}
          {etape === 'ADRESSE' ? (
            <>
              <label className="field">
                <span className="field-label">Adresse du projet</span>
                <input
                  type="url"
                  value={url}
                  autoFocus
                  onChange={(e) => { setUrl(e.target.value); setProbe(null); setErreurSonde(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void tester(); }}
                  placeholder="https://api.mon-projet.exemple.com"
                />
                <span className="muted">
                  Saisissez l’adresse publique du backend communiquée par le projet.
                </span>
              </label>

              {url.trim() && !normalisee ? (
                <p className="muted">
                  Cette adresse n’est pas exploitable : elle doit commencer par le protocole,
                  comme dans l’exemple.
                </p>
              ) : null}

              {dejaDeclare ? (
                <div className="alert alert-warning">
                  Ce projet est déjà déclaré dans le Panel.{' '}
                  <Link to={`/projects/${dejaDeclare.projectId}`}>Ouvrir sa fiche</Link>
                </div>
              ) : null}

              {verification ? (
                <p className="muted wizard-attente">
                  Nous vérifions que le projet peut communiquer avec le Panel.
                </p>
              ) : null}

              {erreurSonde ? <div className="alert alert-error">{erreurSonde}</div> : null}

              {probe && !verdict(probe).ok ? (
                <div className="alert alert-error">
                  <strong>{verdict(probe).titre}</strong>
                  <p>{verdict(probe).explication}</p>
                  {/* Le brut du serveur : utile en atelier, replié par défaut. */}
                  <details className="wizard-details">
                    <summary>Détails techniques</summary>
                    <p className="muted">{probe.reason}</p>
                  </details>
                </div>
              ) : null}
            </>
          ) : null}

          {/* ── 3. INFORMATIONS ────────────────────────────────────────── */}
          {etape === 'INFORMATIONS' && probe ? (
            <>
              <div className="alert alert-success">{verdict(probe).titre}</div>

              <dl className="detail-list">
                <div>
                  <dt>Nom annoncé par le projet</dt>
                  <dd>{nomAnnonce(probe, url) || 'Non communiqué'}</dd>
                </div>
                <div>
                  <dt>Adresse</dt>
                  <dd>{normalisee}</dd>
                </div>
                <div>
                  <dt>Connexion</dt>
                  <dd>Compatible</dd>
                </div>
                <div>
                  <dt>État</dt>
                  <dd>{dejaDeclare ? 'Déjà déclaré' : 'Nouveau projet'}</dd>
                </div>
              </dl>

              <label className="field">
                <span className="field-label">
                  Nom affiché <span className="muted">(modifiable)</span>
                </span>
                <input type="text" value={nom} onChange={(e) => setNom(e.target.value)} />
              </label>

              <p className="muted">
                Le logo, le slogan, l’adresse du site et l’environnement seront récupérés
                automatiquement dès que le projet sera relié : il ne les publie pas avant.
              </p>
            </>
          ) : null}

          {/* ── 4. CONFIRMATION ────────────────────────────────────────── */}
          {etape === 'CONFIRMATION' ? (
            <>
              <dl className="detail-list">
                <div>
                  <dt>Nom</dt>
                  <dd>{nom.trim() || nomAnnonce(probe, url)}</dd>
                </div>
                <div>
                  <dt>Adresse</dt>
                  <dd>{normalisee}</dd>
                </div>
                <div>
                  <dt>Connexion</dt>
                  <dd>Vérifiée</dd>
                </div>
              </dl>
              <p>Le projet sera ajouté au Panel. L’appairage sera réalisé à l’étape suivante.</p>
              {erreurCreation ? <div className="alert alert-error">{erreurCreation}</div> : null}
            </>
          ) : null}

          {/* ── 6. APPAIRAGE ───────────────────────────────────────────── */}
          {etape === 'APPAIRAGE' && cree ? (
            <>
              <div className="wizard-pairing-head">
                <strong>{nom.trim() || nomAnnonce(probe, url)} est créé.</strong>
                <span className={`badge badge-${etatAppairage.tone}`}>{etatAppairage.label}</span>
              </div>

              {projetCree?.pairing.status === 'PAIRED' ? (
                <p>Le projet est relié au Panel. Il n’y a plus rien à faire.</p>
              ) : (
                <>
                  <CopyField value={cree.code} label="Code" />
                  <p>
                    Ouvrez le Manager du projet, puis allez dans Configuration → Panel
                    et saisissez ce code.
                  </p>
                  <p className="muted">
                    {expire
                      ? 'Ce code a expiré : générez-en un nouveau.'
                      : `Valable jusqu’au ${formatDateTime(cree.expireLe)}. Il ne sera plus affiché ensuite.`}
                  </p>

                  {confirmeRegeneration && !expire ? (
                    <div className="alert alert-warning">
                      Le code actuel sera invalidé.
                      <div className="contract-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-small"
                          disabled={regeneration}
                          onClick={() => void regenerer()}
                        >
                          {regeneration ? 'Génération…' : 'Confirmer'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          onClick={() => setConfirmeRegeneration(false)}
                        >
                          Annuler
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}

              {confirmeFermeture ? (
                <div className="alert alert-warning">
                  Ce code ne sera plus affiché. Fermer quand même ?
                  <div className="contract-actions">
                    <button type="button" className="btn btn-primary btn-small" onClick={onClose}>
                      Fermer
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => setConfirmeFermeture(false)}
                    >
                      Rester ici
                    </button>
                  </div>
                </div>
              ) : null}

              {erreurCreation ? <div className="alert alert-error">{erreurCreation}</div> : null}
            </>
          ) : null}
        </div>

        {/* ── Actions : toujours au même endroit, pleine largeur sur mobile ── */}
        <footer className="wizard-foot">
          {etape === 'ADRESSE' ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!normalisee || verification || Boolean(dejaDeclare)}
              onClick={() => void tester()}
            >
              {verification ? 'Vérification…' : 'Tester la connexion'}
            </button>
          ) : null}

          {etape === 'INFORMATIONS' ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={Boolean(dejaDeclare)}
                onClick={() => setEtape('CONFIRMATION')}
              >
                Continuer
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setEtape('ADRESSE')}>
                Retour
              </button>
            </>
          ) : null}

          {etape === 'CONFIRMATION' ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={creation}
                onClick={() => void creer()}
              >
                {creation ? 'Création…' : 'Créer le projet'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={creation}
                onClick={() => setEtape('INFORMATIONS')}
              >
                Retour
              </button>
            </>
          ) : null}

          {etape === 'APPAIRAGE' && cree ? (
            <>
              <Link className="btn btn-primary" to={`/projects/${cree.projectId}`}>
                Ouvrir la fiche projet
              </Link>
              <button type="button" className="btn btn-secondary" onClick={demanderFermeture}>
                Terminer plus tard
              </button>
              {projetCree?.pairing.status === 'PAIRED' ? null : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={regeneration}
                  onClick={() => (expire ? void regenerer() : setConfirmeRegeneration(true))}
                >
                  {regeneration ? 'Génération…' : 'Générer un nouveau code'}
                </button>
              )}
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

export default ProjectWizard;
