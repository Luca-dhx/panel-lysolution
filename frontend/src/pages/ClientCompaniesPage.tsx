/**
 * CLIENTS — les ENTREPRISES CLIENTES de L.Y Solution.
 *
 * ══ CE QUE CETTE PAGE N'EST PAS ═════════════════════════════════════════════
 *
 * Ce n'est pas « Projets clients ». Un projet est une INSTANCE technique — un
 * site, une base, un appairage. Une entreprise cliente est une PERSONNE MORALE,
 * et elle possède souvent plusieurs projets :
 *
 *     SARL DUPONT AUTOMOBILES
 *       ├── Demo SB Auto      (recette)
 *       └── sbauto06.fr       (production)
 *
 * Les deux pages existaient déjà en substance, sauf que la seconde n'existait
 * pas : le Panel connaissait des sites, pas des sociétés. C'est pourquoi ses
 * factures portaient « Facturer à : CTR-2026-0002 » — une référence de contrat
 * en guise de raison sociale, faute de mieux.
 *
 * ══ POURQUOI UNE LISTE D'ITEMS, ET NON PLUS UN TABLEAU ══════════════════════
 *
 * Le tableau avait six colonnes pour un parc qui en compte une poignée de
 * lignes. Trois défauts, et ils se voyaient tous les trois :
 *
 *   · SIX COLONNES, AUCUNE HIÉRARCHIE. La raison sociale — la seule chose
 *     qu'on cherche — avait exactement le même poids visuel qu'un compte de
 *     projets. L'œil devait lire la ligne entière pour trouver le nom.
 *
 *   · DES CELLULES COLLÉES. Un `<td>` n'a pas d'espacement propre : SIREN,
 *     e-mail et badges se touchaient, et rien ne disait lesquels allaient
 *     ensemble.
 *
 *   · AUCUNE ACTION EXPLICITE. Le seul chemin vers la fiche était le nom, en
 *     lien — une cible minuscule, et rien à l'écran ne disait qu'il y AVAIT
 *     une fiche derrière.
 *
 * Un tableau sert à COMPARER colonne par colonne des dizaines de lignes. Ce
 * n'est pas ce qu'on fait ici : on cherche un client, on regarde s'il peut
 * facturer, on ouvre sa fiche. D'où un item par entreprise — une identité
 * dominante, ses métadonnées en second, ses verdicts en badges, et un bouton.
 *
 * ══ CE QUE CHAQUE ITEM PORTE, ET POURQUOI ═══════════════════════════════════
 *
 *   IDENTITÉ     la raison sociale — ce qui figure sur la facture. L'enseigne
 *                l'accompagne quand elle diffère, en second.
 *   SIREN        l'identifiant durable de la personne morale, et une mention
 *                obligatoire de la facture électronique au 1er septembre 2026.
 *   E-MAIL       à qui la facture part.
 *   PROJETS      combien de sites cette entreprise possède. C'est ce qui
 *                distingue un client d'un projet.
 *   VERDICTS     pas décoratifs : « bloqués » signifie que ce client NE PEUT
 *                NI PAYER NI SIGNER, et chacun des deux a sa propre réponse.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Checkbox, EmptyState } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { SearchField } from '@/components/SearchField';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/ToastProvider';
import { useIsDev } from '@/auth/RequireDev';
import { clientCompanies, errorMessage } from '@/lib/api';
import { useLiveQuery } from '@/lib/useLiveQuery';
import type { ClientCompanyRow, DuplicateSiren } from '@/types.clientCompany';
import {
  ClientCompanyForm,
  corpsPour,
  formulaireVide,
  type ClientCompanyFormValue,
} from '@/components/company/ClientCompanyForm';

/**
 * ── UN BADGE PAR MÉTIER, PARCE QUE CE SONT DEUX VERDICTS ───────────────────
 *
 * ══ CE QU'UNE COLONNE UNIQUE DISAIT AVANT ════════════════════════════════
 *
 * Un seul mot — « Prête », « Facturation incomplète », « Signataire
 * manquant » — pour DEUX états indépendants. Une entreprise parfaitement
 * facturable dont le gérant vient de partir s'affichait « Signataire
 * manquant », ce qui est vrai, mais faisait croire qu'elle ne pouvait plus
 * rien : ses échéances passaient parfaitement.
 *
 * Et l'inverse, plus grave : une fiche à qui il manquait À LA FOIS l'adresse
 * de facturation ET le signataire n'affichait QUE la première. On corrigeait
 * l'adresse, on revenait, et un second manque apparaissait — découvert
 * seulement après coup.
 *
 * Les deux verdicts viennent du BACKEND, qui est la même autorité que celle
 * qui refusera le paiement ou la demande de signature.
 */
function VerdictBadge({
  archived,
  pret,
  manquants,
  titre,
}: {
  archived: boolean;
  pret: boolean;
  manquants: string[];
  titre: string;
}) {
  if (archived) return <span className="badge badge-muted">{titre} suspendus</span>;
  if (pret) return <span className="badge badge-ok">{titre} possibles</span>;
  /**
   * Le détail des manques passe par `title` : la liste sert à BALAYER un
   * parc, et y déplier sept libellés par ligne la rendrait illisible. La
   * fiche, elle, les écrit en clair.
   */
  return (
    <span className="badge badge-danger" title={`${titre} : il manque ${manquants.join(', ')}.`}>
      {titre} bloqués
    </span>
  );
}

/**
 * ── UNE ENTREPRISE, UN ITEM ────────────────────────────────────────────────
 *
 * ══ POURQUOI L'ITEM ENTIER N'EST PAS CLIQUABLE ═══════════════════════════
 *
 * Parce qu'il contient déjà des cibles : le SIREN se sélectionne, l'e-mail se
 * copie, un badge porte une infobulle. Rendre le bloc cliquable ferait
 * naviguer au moindre glissement de souris pendant une sélection de texte —
 * et il n'existe aucune façon d'annuler une navigation involontaire autrement
 * qu'en revenant en arrière.
 *
 * L'action est donc EXPLICITE et nommée : « Voir ». Une seule cible, à un
 * seul endroit, toujours la même.
 */
function EntrepriseItem({ row }: { row: ClientCompanyRow }) {
  const archivee = row.status === 'ARCHIVED';
  const enseigne = row.tradingName && row.tradingName !== row.legalName ? row.tradingName : null;

  /**
   * LES MÉTADONNÉES SONT ASSEMBLÉES, PAS EMPILÉES.
   *
   * Un « — » pour chaque champ absent produisait une ligne de tirets qui
   * n'apprend rien. Ce qui manque est simplement ABSENT ; ce qui reste est
   * séparé par un point médian, qui se lit sans être une ponctuation.
   */
  const metadonnees = [
    row.siren ? `SIREN ${row.siren}` : null,
    row.billingEmail,
    `${row.projectCount} projet${row.projectCount > 1 ? 's' : ''}`,
  ].filter(Boolean) as string[];

  return (
    <li className={archivee ? 'cc-item cc-item-archived' : 'cc-item'}>
      {/*
        L'ICÔNE EST DÉCORATIVE — elle double une raison sociale déjà lisible.
        Elle est donc masquée aux lecteurs d'écran : l'annoncer ferait entendre
        « image, bâtiment » avant chaque nom d'entreprise, à chaque ligne.
      */}
      <span className="cc-item-avatar" aria-hidden="true">
        <Icon name="building" size={20} />
      </span>

      <div className="cc-item-body">
        <div className="cc-item-identity">
          <span className="cc-item-name">{row.legalName}</span>
          {/*
            L'ENSEIGNE N'EST AFFICHÉE QUE SI ELLE DIFFÈRE.
            La répéter à l'identique donnerait l'impression de deux noms
            distincts à maintenir séparément.
          */}
          {enseigne ? <span className="cc-item-trading">{enseigne}</span> : null}
          {archivee ? <span className="badge badge-muted">Archivée</span> : null}
        </div>

        <p className="cc-item-meta">
          {metadonnees.map((texte, index) => (
            <span key={texte}>
              {index > 0 ? <span className="cc-item-sep" aria-hidden="true"> · </span> : null}
              {texte}
            </span>
          ))}
        </p>

        <div className="cc-item-badges">
          <VerdictBadge
            archived={archivee}
            pret={row.readiness.billing.ready}
            manquants={row.readiness.billing.missing}
            titre="Paiements"
          />
          <VerdictBadge
            archived={archivee}
            pret={row.readiness.signing.ready}
            manquants={row.readiness.signing.missing}
            titre="Signatures"
          />
        </div>
      </div>

      {/*
        UN LIEN, PEINT EN BOUTON — jamais un `<button>` qui navigue.
        Le clic milieu, l'ouverture dans un onglet et le survol qui montre la
        destination sont des comportements du navigateur : un bouton avec un
        `onClick` les perd tous, silencieusement.

        Le nom de l'entreprise est dans le libellé accessible : dans une liste
        de dix boutons « Voir », un lecteur d'écran doit pouvoir dire lequel.
      */}
      <Link
        to={`/clients/${row.clientCompanyId}`}
        className="btn btn-secondary btn-sm cc-item-action"
        aria-label={`Voir la fiche de ${row.legalName}`}
      >
        Voir
        <Icon name="chevron-right" size={12} />
      </Link>
    </li>
  );
}

export function ClientCompaniesPage() {
  const isDev = useIsDev();
  const toast = useToast();
  const [recherche, setRecherche] = useState('');
  const [avecArchivees, setAvecArchivees] = useState(false);
  const [creation, setCreation] = useState<ClientCompanyFormValue | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  /**
   * LE DOUBLON DE SIREN RESTE À L'ÉCRAN, il ne passe pas en notification.
   *
   * Une notification disparaît en quatre secondes ; ceci est une information
   * sur laquelle l'opérateur doit AGIR — vérifier l'autre fiche, décider de
   * fusionner ou de corriger. Elle reste donc affichée jusqu'à ce qu'il la
   * ferme.
   */
  const [doublon, setDoublon] = useState<DuplicateSiren | null>(null);

  /**
   * LA RECHERCHE EST FAITE PAR LE SERVEUR, pas par le navigateur.
   *
   * Un filtrage local exigerait de charger toutes les fiches — ce qui va bien
   * jusqu'à la centième, et cesse d'aller après. Le serveur cherche déjà sur le
   * nom ET le SIREN, avec l'échappement qui va avec.
   *
   * `key` porte les critères : quand ils changent, c'est une AUTRE liste, et
   * le premier chargement est légitime plutôt qu'un rafraîchissement muet.
   */
  const { data, isInitialLoading, error, reload } = useLiveQuery(
    () => clientCompanies.listClientCompanies({
      search: recherche.trim(),
      status: avecArchivees ? undefined : 'ACTIVE',
    }),
    {
      /**
       * Une entreprise cliente ne change pas toute seule : aucune écriture
       * automatique ne la touche. Le sondage est donc LENT — il rattrape la
       * modification faite par un collègue, pas un flux d'événements.
       */
      intervalMs: 60_000,
      fallbackError: 'Les entreprises clientes n’ont pas pu être chargées.',
      key: `${recherche.trim()}|${avecArchivees}`,
    },
  );

  const lignes = data?.clientCompanies ?? [];

  const creer = async () => {
    if (!creation) return;
    setEnregistrement(true);
    try {
      const resultat = await clientCompanies.createClientCompany(corpsPour(creation));
      /**
       * LE DOUBLON DE SIREN EST SIGNALÉ, JAMAIS BLOQUANT.
       *
       * Une reprise de fiche, une fusion en cours, une correction en deux temps
       * produisent légitimement deux fiches d'un même SIREN. Refuser obligerait
       * à supprimer une fiche RÉFÉRENCÉE par des factures pour pouvoir en
       * corriger une autre — un remède pire que le mal.
       */
      setDoublon(resultat.duplicateSiren);
      toast.success('Entreprise cliente créée.');
      setCreation(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err, 'La fiche n’a pas pu être créée.'));
    } finally {
      setEnregistrement(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Clients</h1>
        <p className="page-description">
          Les entreprises clientes de L.Y Solution. Leur identité légale fait autorité sur les
          factures et les contrats de leurs projets.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      {doublon ? (
        <div className="alert alert-warn">
          Le SIREN saisi est déjà porté par «{' '}
          <Link to={`/clients/${doublon.clientCompanyId}`}>{doublon.legalName}</Link> ». La fiche a
          bien été créée — vérifiez qu’il ne s’agit pas d’un doublon.{' '}
          <button type="button" className="btn btn-link" onClick={() => setDoublon(null)}>
            J’ai vérifié
          </button>
        </div>
      ) : null}

      {/*
        ── L'ACTION D'ABORD, LE FILTRE ENSUITE, LA RECHERCHE À PART ─────────

        La barre était rangée dans l'ordre inverse : recherche, case à cocher,
        puis le bouton de création tout à droite — c'est-à-dire le geste le
        plus structurant à l'endroit où l'œil arrive en dernier.

        « Nouvelle entreprise » ouvre en tête, la case le suit immédiatement
        parce qu'elle gouverne CE QUE LA LISTE MONTRE, et la recherche occupe
        sa propre ligne : elle n'est pas une action, c'est un filtre continu.
      */}
      <div className="cc-toolbar">
        <div className="cc-toolbar-actions">
          {/*
            LA CRÉATION EST RÉSERVÉE AUX COMPTES DEV.
            Ce qui est saisi ici finit sur une facture et sur un contrat signé :
            la garde n'est pas hiérarchique, elle est proportionnée à ce qu'une
            erreur de saisie produit chez un tiers. Le backend applique la même
            règle, et c'est LUI la barrière — ce bouton ne fait que la refléter.
          */}
          {isDev ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreation(formulaireVide())}>
              <Icon name="plus-lg" size={13} />
              Nouvelle entreprise
            </button>
          ) : null}

          <Checkbox
            checked={avecArchivees}
            onChange={setAvecArchivees}
            label="Afficher les archivées"
          />
        </div>

        <SearchField
          value={recherche}
          onChange={setRecherche}
          label="Rechercher une entreprise"
          placeholder="Raison sociale ou SIREN…"
        />
      </div>

      {isInitialLoading ? (
        <p className="muted">Chargement des entreprises clientes…</p>
      ) : lignes.length === 0 ? (
        <EmptyState
          title={recherche ? 'Aucune entreprise ne correspond' : 'Aucune entreprise cliente'}
          hint={
            recherche
              ? 'Essayez une autre raison sociale, ou un SIREN.'
              : 'Créez la fiche d’un client pour pouvoir lui facturer un projet.'
          }
        />
      ) : (
        <ul className="cc-list">
          {lignes.map((row) => (
            <EntrepriseItem key={row.clientCompanyId} row={row} />
          ))}
        </ul>
      )}

      {creation ? (
        <Modal
          title="Nouvelle entreprise cliente"
          hint="Seule la raison sociale est obligatoire. Les autres champs peuvent être complétés plus tard — mais la facturation restera bloquée tant que l’identité légale est incomplète."
          onClose={() => setCreation(null)}
        >
          <ClientCompanyForm value={creation} onChange={setCreation} />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setCreation(null)}>
              Annuler
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={enregistrement || creation.legalName.trim().length < 2}
              onClick={creer}
            >
              {enregistrement ? 'Création…' : 'Créer'}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export default ClientCompaniesPage;
