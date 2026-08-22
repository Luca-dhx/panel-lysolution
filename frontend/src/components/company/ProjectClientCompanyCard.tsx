/**
 * L'ENTREPRISE CLIENTE D'UN PROJET — vue et RATTACHÉE depuis la fiche projet.
 *
 * ══ CE QUE CETTE CARTE MONTRAIT, ET POURQUOI C'ÉTAIT INSUFFISANT ════════════
 *
 * Trois lignes en lecture seule, et un seul verdict fusionné : « Paiements et
 * signatures — Possibles / Bloqués ». Deux défauts, et les deux se payaient sur
 * le terrain :
 *
 *   · UN SEUL VERDICT POUR DEUX MÉTIERS. Le backend en calcule deux —
 *     `billing` et `signing` — précisément parce qu'ils sont indépendants : une
 *     entreprise parfaitement facturable dont le gérant vient de partir doit
 *     continuer à régler ses échéances. Les fondre à l'écran affichait
 *     « Bloqués » sur un projet dont les paiements passaient parfaitement, et
 *     envoyait chercher une panne qui n'existait pas.
 *
 *   · AUCUNE ACTION. Le texte disait « Rattachez-le depuis la fiche du
 *     client » — c'est-à-dire : ouvrez une autre page, retrouvez-y le bon
 *     client parmi tous, retrouvez-y le bon projet parmi tous. Le geste se fait
 *     désormais là où la question se pose.
 *
 * ══ CE QUE CETTE CARTE NE FAIT PAS ══════════════════════════════════════════
 *
 * Elle ne recopie pas l'identité juridique — adresse, TVA, documents. Une copie
 * vieillirait, et la fiche cliente est à un clic. Elle ne CALCULE aucune
 * complétude : le verdict vient du backend, qui est la même autorité que celle
 * qui refusera le paiement.
 *
 * Elle n'offre le rattachement qu'aux comptes DEV, parce que la route qui le
 * sert exige `requirePanelDev` : proposer un bouton qui rendrait 403 est une
 * façon de mentir à l'écran.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card } from '@/components/ui';
import { useToast } from '@/components/ToastProvider';
import { useIsDev } from '@/auth/RequireDev';
import { clientCompanies, errorMessage } from '@/lib/api';
import type { ClientCompanyRow } from '@/types.clientCompany';
import type { PublicProject } from '@/types';

/**
 * UN VERDICT, SA COULEUR, ET CE QUI MANQUE.
 *
 * Le détail des champs absents n'est pas un luxe : « Facturation impossible »
 * seul renvoie chercher dans une fiche de trente champs lequel est vide.
 */
function Verdict({
  titre,
  pret,
  manquants,
}: {
  titre: string;
  pret: boolean;
  manquants: string[];
}) {
  return (
    <div>
      <dt>{titre}</dt>
      <dd>
        {pret ? (
          <span className="badge badge-ok">Possibles</span>
        ) : (
          <>
            <span className="badge badge-danger">Bloqués</span>
            {manquants.length > 0 ? (
              <span className="muted"> — il manque : {manquants.join(', ')}.</span>
            ) : null}
          </>
        )}
      </dd>
    </div>
  );
}

export function ProjectClientCompanyCard({
  project,
  onChanged,
}: {
  project: PublicProject;
  /** Rechargement de la FICHE PROJET : le rattachement change son verdict. */
  onChanged: () => void;
}) {
  const isDev = useIsDev();
  const toast = useToast();
  const societe = project.clientCompany ?? null;

  /**
   * LA LISTE DES ENTREPRISES N'EST CHARGÉE QUE POUR CEUX QUI PEUVENT AGIR.
   *
   * Un ADMIN n'a pas de sélecteur à peupler ; lui faire payer la requête
   * ajouterait un appel à chaque ouverture de fiche projet, pour rien.
   */
  const [choix, setChoix] = useState<ClientCompanyRow[]>([]);
  const [selection, setSelection] = useState('');
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    if (!isDev) return undefined;
    let vivant = true;
    clientCompanies
      .listClientCompanies()
      .then(({ clientCompanies: liste }) => { if (vivant) setChoix(liste); })
      /**
       * Un échec de chargement du sélecteur ne doit PAS masquer la carte : le
       * verdict, lui, est déjà là et reste la seule information indispensable.
       */
      .catch(() => { if (vivant) setChoix([]); });
    return () => { vivant = false; };
  }, [isDev]);

  /**
   * On n'offre pas de rattacher à l'entreprise DÉJÀ rattachée — le backend
   * répondrait `unchanged`, ce qui est correct mais donne à l'opérateur
   * l'impression d'avoir agi. Les archivées non plus : elles ne débloquent
   * rien, et les proposer serait proposer un rattachement inutile.
   */
  const rattachables = useMemo(
    () => choix.filter(
      (c) => c.status === 'ACTIVE' && c.clientCompanyId !== societe?.clientCompanyId,
    ),
    [choix, societe?.clientCompanyId],
  );

  const rattacher = async () => {
    if (!selection || enCours) return;
    setEnCours(true);
    try {
      const resultat = await clientCompanies.linkProjectToClientCompany(selection, project.projectId);
      setSelection('');
      onChanged();
      /**
       * LE CONTRAT EN COURS GARDE SON IDENTITÉ DE FACTURATION.
       *
       * Le dire ICI, au moment du geste, plutôt que de le laisser découvrir sur
       * la facture suivante — qui partira au nom de l'ancienne entreprise.
       */
      if (resultat.pendingContract) {
        toast.success(
          `Projet rattaché. Le contrat ${resultat.pendingContract.reference ?? 'en cours'} conserve `
          + 'son identité de facturation : la nouvelle s’appliquera au prochain contrat.',
        );
      } else {
        toast.success('Projet rattaché.');
      }
    } catch (err) {
      toast.error(errorMessage(err, 'Le projet n’a pas pu être rattaché.'));
    } finally {
      setEnCours(false);
    }
  };

  const detacher = async () => {
    if (enCours) return;
    setEnCours(true);
    try {
      await clientCompanies.unlinkProjectFromClientCompany(project.projectId);
      onChanged();
      toast.success('Projet détaché — ses paiements et signatures sont suspendus.');
    } catch (err) {
      toast.error(errorMessage(err, 'Le projet n’a pas pu être détaché.'));
    } finally {
      setEnCours(false);
    }
  };

  /**
   * `undefined` ≠ `null`. La LISTE des projets ne résout pas l'entreprise —
   * une lecture par projet transformerait l'affichage du parc en balayage — et
   * publie donc `undefined`. Afficher « aucune entreprise rattachée » sur cette
   * absence-là accuserait à tort des projets parfaitement rattachés.
   */
  if (project.clientCompany === undefined) return null;

  return (
    <Card title="Client">
      {societe ? (
        <dl className="detail-list">
          <div>
            <dt>Entreprise cliente</dt>
            <dd>
              <Link to={`/clients/${societe.clientCompanyId}`}>{societe.legalName}</Link>
              {societe.tradingName && societe.tradingName !== societe.legalName ? (
                <span className="muted"> ({societe.tradingName})</span>
              ) : null}
              {societe.status === 'ARCHIVED' ? (
                <span className="badge badge-muted">Archivée</span>
              ) : null}
            </dd>
          </div>
          {societe.siren ? (
            <div><dt>SIREN</dt><dd>{societe.siren}</dd></div>
          ) : null}
          {/*
            ── DEUX LIGNES, PARCE QUE CE SONT DEUX MÉTIERS ──────────────────
            `billing` et `signing` sont calculés séparément par le backend et
            gardés séparément par les capacités. Les afficher fondus faisait
            dire « bloqués » à un projet qui encaissait sans difficulté.
          */}
          <Verdict
            titre="Paiements"
            pret={societe.readiness.billing.ready}
            manquants={societe.readiness.billing.missing}
          />
          <Verdict
            titre="Signatures"
            pret={societe.readiness.signing.ready}
            manquants={societe.readiness.signing.missing}
          />
          {/*
            LE SIGNATAIRE EST UNE PERSONNE, PAS UNE CASE.
            `signing.ready` vaut exactement « un signataire nommé et joignable
            est désigné » : c'est la même autorité que celle qui ouvre ou
            refuse une demande de signature.
          */}
          <div>
            <dt>Signataire</dt>
            <dd>
              {societe.readiness.signing.ready ? (
                <span className="badge badge-ok">Désigné</span>
              ) : (
                <span className="badge badge-warn">Aucun signataire désigné</span>
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="muted">
          Aucune entreprise cliente n’est rattachée à ce projet : il ne peut ni
          encaisser un paiement, ni faire signer un contrat.
        </p>
      )}

      {isDev ? (
        <div className="form-actions">
          <select
            className="input"
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            aria-label="Entreprise cliente à rattacher"
          >
            <option value="">
              {societe ? 'Changer d’entreprise cliente…' : 'Rattacher une entreprise cliente…'}
            </option>
            {rattachables.map((c) => (
              <option key={c.clientCompanyId} value={c.clientCompanyId}>
                {c.legalName}
                {c.siren ? ` — ${c.siren}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selection || enCours}
            onClick={rattacher}
          >
            {societe ? 'Changer' : 'Rattacher'}
          </button>
          {societe ? (
            <button type="button" className="btn btn-secondary" disabled={enCours} onClick={detacher}>
              Détacher
            </button>
          ) : null}
        </div>
      ) : (
        !societe ? (
          <p className="muted">
            Le rattachement se fait depuis <Link to="/clients">Clients</Link>.
          </p>
        ) : null
      )}
    </Card>
  );
}

export default ProjectClientCompanyCard;
