import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useFederationAuthorize } from '@/lib/useFederationAuthorize';

/**
 * LA PAGE D'AUTORISATION — le seul écran du Panel qui délivre un accès à un
 * projet (L12.B-UI).
 *
 * ── CE QU'ELLE FAIT, ET DANS QUEL ORDRE ─────────────────────────────────────
 *
 *   1. elle est sous `RequireAuth` : un visiteur non connecté est renvoyé au
 *      login du Panel, qui le ramène ICI — paramètres compris ;
 *   2. elle demande une assertion pour le projet nommé dans l'URL ;
 *   3. le SERVEUR valide l'adresse de retour contre les origines qu'il connaît
 *      pour ce projet, puis signe ;
 *   4. elle repose le navigateur sur cette adresse, avec l'assertion.
 *
 * ── POURQUOI ELLE NE VALIDE RIEN ELLE-MÊME ─────────────────────────────────
 *
 * Ni le projet, ni le droit d'accès, ni l'adresse de retour. Tout est décidé
 * par le serveur, qui seul connaît le registre des projets, les accès du
 * compte, et les origines déclarées. Un écran qui « préviendrait » en amont
 * dupliquerait ces règles — et deux exemplaires d'une règle de sécurité
 * finissent toujours par diverger.
 *
 * ── ET POURQUOI ELLE NE MÉMORISE RIEN NON PLUS ─────────────────────────────
 *
 * Le corollaire est moins évident, et c'est lui qui a coûté un incident : ne
 * pas décider soi-même ne suffit pas, encore faut-il ne pas CONSERVER la
 * décision d'autrui. Un refus affiché plus longtemps que la tentative qui l'a
 * produit est un cache d'autorisation — le serveur a beau avoir changé d'avis,
 * plus personne ne le lui demande.
 *
 * Toute la mécanique de fraîcheur vit dans `useFederationAuthorize`, qui
 * l'explique en détail et que la suite de tests exécute pour de vrai.
 *
 * ── POURQUOI L'ASSERTION VOYAGE DANS LE FRAGMENT ───────────────────────────
 *
 * `#assertion=…` et non `?assertion=…`. Le fragment n'est PAS envoyé au
 * serveur : il ne finit ni dans les journaux d'accès du projet, ni dans ceux
 * d'un reverse proxy, ni dans un `Referer`. Il reste dans le navigateur, qui
 * est précisément le seul destinataire prévu.
 */

/**
 * L'ABONNEMENT AU RETOUR DEPUIS LE CACHE DE NAVIGATION.
 *
 * Défini AU NIVEAU DU MODULE, donc d'identité stable : passé en dépendance
 * d'effet, une fonction recréée à chaque rendu ferait poser et retirer
 * l'écouteur sans fin.
 *
 * `event.persisted` distingue la restauration d'un chargement ordinaire : sans
 * ce filtre, on relancerait une évaluation à chaque première peinture, en
 * doublon de celle que l'effet vient déjà de lancer.
 */
function onRestore(listener: () => void): () => void {
  const handler = (event: PageTransitionEvent) => {
    if (event.persisted) listener();
  };
  window.addEventListener('pageshow', handler);
  return () => window.removeEventListener('pageshow', handler);
}

export function FederationAuthorizePage() {
  const [params] = useSearchParams();
  const { user } = useAuth();

  const projectId = params.get('projectId');
  const state = params.get('state');
  const returnUrl = params.get('returnUrl');

  const [projectLabel, setProjectLabel] = useState<string | null>(null);

  const issue = useCallback(
    (id: string, input: { returnUrl: string; state: string }) =>
      api.issueFederationAssertion(id, input),
    [],
  );
  const redirect = useCallback((url: string) => { window.location.replace(url); }, []);
  const describeError = useCallback(
    (err: unknown) => errorMessage(err, 'Cet accès n’a pas pu être délivré.'),
    [],
  );

  const { status, error, retry, attempt } = useFederationAuthorize(
    { projectId, state, returnUrl },
    { issue, redirect, describeError, onRestore },
  );

  useEffect(() => {
    if (!projectId) return;
    /**
     * PUREMENT COSMÉTIQUE — l'échec est silencieux, et c'est voulu.
     *
     * Le nom du projet rend l'écran lisible (« accès à SB Auto 06 » plutôt
     * qu'à un UUID). Il ne conditionne RIEN : la redirection part sans lui, et
     * un droit de lecture manquant sur la fiche ne doit pas empêcher un accès
     * que le serveur vient d'accorder.
     */
    void api
      .getProject(projectId)
      .then((detail) => setProjectLabel(detail?.project?.projectName ?? null))
      .catch(() => setProjectLabel(null));
  }, [projectId]);

  const compte = user?.displayName ?? user?.email ?? null;

  return (
    <div className="page federation-authorize">
      <header className="page-header">
        <h1>Accès développeur</h1>
        <p className="page-description">
          {projectLabel
            ? `Ouverture d’un accès développeur à « ${projectLabel} ».`
            : 'Ouverture d’un accès développeur à un projet.'}
        </p>
      </header>

      {error ? (
        <div className="alert alert-error">
          <p><strong>Accès refusé.</strong> {error}</p>

          {/*
            LE COMPTE REFUSÉ EST NOMMÉ.

            Un accès se donne À UN COMPTE, et le Panel en héberge plusieurs. Un
            refus anonyme laissait croire à une panne alors que, le plus
            souvent, l'accès venait d'être accordé — au compte d'à côté. Nommer
            le sujet du refus rend cette confusion visible en une ligne.
          */}
          {compte ? (
            <p className="muted">
              Compte concerné : {compte}. L’accès aux projets s’accorde depuis
              « Comptes L.Y Solution », par un autre développeur.
            </p>
          ) : null}

          {/*
            RÉESSAYER REPOSE LA QUESTION AU SERVEUR — aucune page à recharger.

            Ce bouton n'est PAS le mécanisme de fraîcheur : une nouvelle
            tentative depuis le projet, comme un retour depuis le cache de
            navigation, réévalue déjà d'elle-même. Il sert le cas où l'accès
            vient d'être accordé dans un autre onglet.
          */}
          {status === 'DENIED' ? (
            <p>
              <button type="button" className="btn btn-small" onClick={retry}>
                Réessayer
              </button>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted">
          Connecté en tant que {compte ?? '…'}.
          {attempt > 0 ? ' Nouvelle vérification de vos accès…' : ' Redirection vers le projet…'}
        </p>
      )}
    </div>
  );
}

export default FederationAuthorizePage;
