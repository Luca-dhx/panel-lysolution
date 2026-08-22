/**
 * FICHE D'UNE ENTREPRISE CLIENTE — l'autorité de son identité juridique.
 *
 * ══ SIX SECTIONS, ET PAS UNE DE PLUS ════════════════════════════════════════
 *
 *   IDENTITÉ     raison sociale, forme, SIREN/SIRET, TVA
 *   COORDONNÉES  adresses, téléphone, contact administratif
 *   FACTURATION  à qui la facture part, et à quelle adresse
 *   SIGNATAIRE   qui engage l'entreprise
 *   PROJETS      quels sites lui appartiennent
 *   DOCUMENTS    Kbis, attestation, mandat, RIB…
 *
 * Un écran par section aurait été plus « propre » et aurait obligé à naviguer
 * six fois pour répondre à la seule question qu'on se pose vraiment devant une
 * fiche client : « est-ce que je peux lui facturer quelque chose ? ».
 *
 * ══ CE QUE LA BANNIÈRE DIT EN PREMIER ═══════════════════════════════════════
 *
 * Précisément cette question. Une fiche incomplète ne bloque pas seulement un
 * champ : elle BLOQUE LES PAIEMENTS et LES SIGNATURES de tous les projets
 * rattachés. C'est la conséquence, pas le champ manquant, qui doit se lire en
 * premier.
 *
 * ══ POURQUOI « MODIFIER » N'OUVRE PLUS DE FENÊTRE ═══════════════════════════
 *
 * L'édition passait par une modale portant le formulaire ENTIER — une trentaine
 * de champs empilés, par-dessus la fiche qu'ils décrivent. Trois défauts, et
 * les trois se payaient à chaque correction :
 *
 *   · LE CONTEXTE DISPARAÎT. On ouvre la modale pour corriger un SIREN, et la
 *     fiche — dont la bannière dit précisément CE QUI manque — passe derrière
 *     un voile. On corrige de mémoire.
 *
 *   · LA FORME CHANGE DE MAIN. La fiche est une lecture par sections ; la
 *     modale était une grille de formulaire. Rien ne se trouvait au même
 *     endroit, et l'on cherchait le champ qu'on venait de regarder.
 *
 *   · TOUT EST OUVERT POUR CORRIGER UN CHAMP. Trente champs modifiables pour
 *     changer une ville, c'est trente occasions de modifier autre chose sans
 *     s'en apercevoir.
 *
 * Désormais la fiche BASCULE : les mêmes lignes, aux mêmes endroits, dont les
 * valeurs deviennent des champs. Rien ne bouge, rien ne se superpose, et l'on
 * corrige en voyant ce qu'on corrige.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Card, Checkbox, EmptyState } from '@/components/ui';
import { Icon, type IconName } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { ThemedSelect, type ThemedOption } from '@/components/ThemedSelect';
import { useToast } from '@/components/ToastProvider';
import { useIsDev } from '@/auth/RequireDev';
import { ApiError, clientCompanies, errorMessage } from '@/lib/api';
import { useProjects } from '@/lib/useProjects';
import { formatDateTime } from '@/lib/format';
import type { ClientAddress, ClientCompanyDetail } from '@/types.clientCompany';
import {
  corpsPour,
  formulaireDepuis,
  type ClientCompanyFormValue,
} from '@/components/company/ClientCompanyForm';

/** Une adresse sur une ligne. Les morceaux absents sont ÉCARTÉS, pas remplacés. */
function adresseLisible(adresse: ClientAddress | null): string | null {
  if (!adresse) return null;
  const rue = [adresse.line1, adresse.line2].map((v) => String(v ?? '').trim()).filter(Boolean);
  const ville = [adresse.postalCode, adresse.city].map((v) => String(v ?? '').trim()).filter(Boolean);
  const pays = String(adresse.country ?? '').trim();
  const morceaux = [...rue, ville.join(' '), pays && pays !== 'FR' ? pays : ''].filter(Boolean);
  return morceaux.length > 0 ? morceaux.join(', ') : null;
}

type Adresse = ClientCompanyFormValue['registeredOffice'];

/**
 * ── LES ERREURS DU SERVEUR, RANGÉES PAR CHAMP ──────────────────────────────
 *
 * Le backend refuse en nommant le chemin de chaque champ fautif (`siren`,
 * `registeredOffice.city`…). On les indexe une fois, et chaque ligne va y
 * chercher la sienne.
 *
 * Découper la PHRASE d'erreur pour en deviner le champ aurait marché — jusqu'au
 * premier message reformulé. C'est le chemin qui fait foi, jamais le texte.
 */
function erreursParChamp(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const details = err.details as { issues?: { path?: string; message?: string }[] } | null | undefined;
  const table: Record<string, string> = {};
  for (const issue of details?.issues ?? []) {
    const chemin = String(issue?.path ?? '').trim();
    const message = String(issue?.message ?? '').trim();
    // Le premier message d'un champ gagne : afficher les deux sous un même
    // champ ferait lire une correction et en appliquer une autre.
    if (chemin && message && !table[chemin]) table[chemin] = message;
  }
  return table;
}

/**
 * ── UNE LIGNE, DEUX ÉTATS, UNE SEULE PLACE ─────────────────────────────────
 *
 * Le libellé ne bouge JAMAIS. Seule la valeur change de nature : un texte en
 * lecture, un champ en édition. C'est ce qui fait qu'une fiche ne « saute » pas
 * quand on passe en modification — et qu'on retrouve immédiatement la ligne
 * qu'on regardait.
 *
 * `edition` absent ⇒ la ligne n'est pas modifiable du tout (une donnée calculée,
 * par exemple). Ce n'est pas la même chose que « mode lecture ».
 */
function Ligne({
  label,
  value,
  edition,
}: {
  label: string;
  value: string | null | undefined;
  edition?: {
    value: string;
    onChange: (v: string) => void;
    erreur?: string;
    hint?: string;
    placeholder?: string;
    type?: string;
  };
}) {
  const texte = String(value ?? '').trim();

  if (!edition) {
    return (
      <div className="cc-field">
        <span className="cc-field-label">{label}</span>
        <span className="cc-field-value">{texte || <span className="muted">—</span>}</span>
      </div>
    );
  }

  return (
    <label className={edition.erreur ? 'cc-field cc-field-editing cc-field-invalid' : 'cc-field cc-field-editing'}>
      <span className="cc-field-label">{label}</span>
      <input
        className="input cc-field-input"
        type={edition.type ?? 'text'}
        value={edition.value}
        placeholder={edition.placeholder}
        onChange={(e) => edition.onChange(e.target.value)}
        aria-invalid={edition.erreur ? true : undefined}
      />
      {/*
        L'ERREUR EST SOUS SON CHAMP, jamais seulement en notification.
        Une notification annonce qu'il y a un problème ; elle ne dit pas OÙ, et
        elle disparaît avant qu'on ait fini de chercher.
      */}
      {edition.erreur ? <span className="cc-field-error">{edition.erreur}</span> : null}
      {!edition.erreur && edition.hint ? <span className="cc-field-hint">{edition.hint}</span> : null}
    </label>
  );
}

/**
 * UNE ADRESSE — une ligne assemblée en lecture, quatre champs en édition.
 *
 * C'est la seule entorse assumée au « rien ne bouge » : une adresse ne se
 * corrige pas dans un champ unique, et la recomposer à partir d'une chaîne
 * libre reviendrait à deviner où finit la voie et où commence la ville.
 */
function BlocAdresse({
  titre,
  lecture,
  edition,
}: {
  titre: string;
  lecture: string | null;
  edition?: {
    value: Adresse;
    onChange: (v: Adresse) => void;
    prefixe: string;
    erreurs: Record<string, string>;
  };
}) {
  if (!edition) return <Ligne label={titre} value={lecture} />;

  const set = (cle: keyof Adresse) => (v: string) => edition.onChange({ ...edition.value, [cle]: v });
  const err = (cle: string) => edition.erreurs[`${edition.prefixe}.${cle}`];

  return (
    <fieldset className="cc-address">
      <legend className="cc-field-label">{titre}</legend>
      <Ligne label="Voie" value={null} edition={{ value: edition.value.line1, onChange: set('line1'), erreur: err('line1'), placeholder: '12 avenue des Lilas' }} />
      <Ligne label="Complément" value={null} edition={{ value: edition.value.line2, onChange: set('line2'), erreur: err('line2'), placeholder: 'Bâtiment B' }} />
      <Ligne label="Code postal" value={null} edition={{ value: edition.value.postalCode, onChange: set('postalCode'), erreur: err('postalCode'), placeholder: '06000' }} />
      <Ligne label="Ville" value={null} edition={{ value: edition.value.city, onChange: set('city'), erreur: err('city'), placeholder: 'Nice' }} />
      <Ligne
        label="Pays"
        value={null}
        edition={{
          value: edition.value.country,
          onChange: set('country'),
          erreur: err('country'),
          placeholder: 'FR',
          hint: 'Code ISO à deux lettres — c’est ce que le fournisseur de paiement exige.',
        }}
      />
    </fieldset>
  );
}

/**
 * UNE SECTION ILLUSTRÉE.
 *
 * L'icône n'est pas décorative au sens où elle serait gratuite : sur une fiche
 * de six sections, c'est elle qui permet de retrouver « Signataire » sans lire
 * les six titres. Elle est en revanche masquée aux lecteurs d'écran — le titre
 * dit déjà tout, et l'entendre deux fois n'aide personne.
 */
function Section({
  icon,
  titre,
  action,
  children,
}: {
  icon: IconName;
  titre: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="cc-section">
      <div className="cc-section-head">
        <span className="cc-section-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>
        <h2 className="cc-section-title">{titre}</h2>
        {action ? <div className="cc-section-action">{action}</div> : null}
      </div>
      <div className="cc-section-body">{children}</div>
    </Card>
  );
}

export function ClientCompanyDetailPage() {
  const { clientCompanyId = '' } = useParams();
  const isDev = useIsDev();
  const toast = useToast();
  const { projects } = useProjects();

  const [fiche, setFiche] = useState<ClientCompanyDetail | null>(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [edition, setEdition] = useState<ClientCompanyFormValue | null>(null);
  const [erreursChamps, setErreursChamps] = useState<Record<string, string>>({});
  const [enregistrement, setEnregistrement] = useState(false);
  const [rattachement, setRattachement] = useState<string>('');
  const [aRetirer, setARetirer] = useState<{ projectId: string; projectName: string } | null>(null);
  const [depot, setDepot] = useState<{ file: File | null; label: string; type: string; date: string } | null>(null);

  const charger = async () => {
    try {
      const { clientCompany } = await clientCompanies.getClientCompany(clientCompanyId);
      setFiche(clientCompany);
      setErreur(null);
    } catch (err) {
      setErreur(errorMessage(err, 'Cette entreprise cliente n’a pas pu être chargée.'));
    } finally {
      setChargement(false);
    }
  };

  useEffect(() => {
    void charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientCompanyId]);

  /**
   * ── LES PROJETS ENCORE RATTACHABLES ────────────────────────────────────────
   *
   * ══ CE QUE CE FILTRE NE FAISAIT PAS, ET CE QUE ÇA COÛTAIT ════════════════
   *
   * Il n'écartait que les projets déjà rattachés à CETTE fiche. Un projet
   * appartenant à une AUTRE entreprise restait proposé — et le choisir le lui
   * PRENAIT, silencieusement. Un changement de client légal, avec toutes ses
   * conséquences de facturation, présenté comme un simple ajout.
   *
   * Un projet n'a qu'une entreprise cliente. Le changement d'appartenance est
   * un geste à part entière : il se fait depuis la FICHE DU PROJET, où l'on
   * voit ce qu'on abandonne autant que ce qu'on choisit.
   */
  const rattachables = useMemo<ThemedOption[]>(
    () => projects
      .filter((p) => !p.clientCompanyId)
      .map((p) => ({
        value: p.projectId,
        label: p.projectName,
        hint: [p.environment ?? 'Environnement inconnu', p.projectKey].filter(Boolean).join(' · '),
      })),
    [projects],
  );

  if (chargement) return <p className="muted">Chargement de la fiche…</p>;
  if (erreur || !fiche) {
    return (
      <div className="page">
        <EmptyState title="Entreprise introuvable" hint={erreur ?? undefined} />
      </div>
    );
  }

  const ouvrirEdition = () => {
    setErreursChamps({});
    setEdition(formulaireDepuis(fiche));
  };

  /**
   * ANNULER REND EXACTEMENT LES VALEURS D'ORIGINE.
   *
   * Rien n'a été écrit : le brouillon vit dans `edition`, la vérité dans
   * `fiche`. Abandonner, c'est jeter le brouillon — il n'y a rien à défaire.
   */
  const annulerEdition = () => {
    setEdition(null);
    setErreursChamps({});
  };

  const enregistrer = async () => {
    if (!edition) return;
    setEnregistrement(true);
    try {
      const resultat = await clientCompanies.updateClientCompany(clientCompanyId, corpsPour(edition));
      setFiche(resultat.clientCompany);
      setEdition(null);
      setErreursChamps({});
      toast.success(
        resultat.duplicateSiren
          ? `Fiche enregistrée. Attention : ce SIREN est aussi porté par « ${resultat.duplicateSiren.legalName} ».`
          : 'Entreprise mise à jour.',
      );
    } catch (err) {
      /**
       * ON RESTE EN ÉDITION. Repasser en lecture après un refus jetterait la
       * saisie que l'opérateur doit précisément corriger — et il devrait tout
       * ressaisir pour découvrir la même erreur.
       */
      const parChamp = erreursParChamp(err);
      setErreursChamps(parChamp);
      toast.error(
        Object.keys(parChamp).length > 0
          ? 'Certains champs sont invalides — voyez les messages sous les champs concernés.'
          : errorMessage(err, 'La fiche n’a pas pu être enregistrée.'),
      );
    } finally {
      setEnregistrement(false);
    }
  };

  const rattacher = async (projectId: string) => {
    if (!projectId) return;
    try {
      const resultat = await clientCompanies.linkProjectToClientCompany(clientCompanyId, projectId);
      setRattachement('');
      await charger();
      /**
       * L'AVERTISSEMENT SUR LE CONTRAT EN COURS.
       *
       * Le client Stripe est lié au CONTRAT, pas au projet. Un contrat déjà
       * ouvert garde donc son identité de facturation : le nouveau
       * rattachement ne vaut que pour les opérations à venir. Le dire ici évite
       * de le découvrir sur la facture suivante.
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
    }
  };

  const detacher = async () => {
    if (!aRetirer) return;
    try {
      await clientCompanies.unlinkProjectFromClientCompany(aRetirer.projectId);
      setARetirer(null);
      await charger();
      toast.success('Projet retiré — ses paiements et signatures sont suspendus.');
    } catch (err) {
      toast.error(errorMessage(err, 'Le projet n’a pas pu être retiré.'));
    }
  };

  const basculerArchive = async () => {
    try {
      if (fiche.status === 'ARCHIVED') {
        const { clientCompany } = await clientCompanies.restoreClientCompany(clientCompanyId);
        setFiche(clientCompany);
        toast.success('Entreprise réactivée.');
      } else {
        const { clientCompany } = await clientCompanies.archiveClientCompany(clientCompanyId);
        setFiche(clientCompany);
        toast.success('Entreprise archivée — paiements et signatures suspendus.');
      }
    } catch (err) {
      toast.error(errorMessage(err, 'L’état de la fiche n’a pas pu être changé.'));
    }
  };

  const deposer = async () => {
    if (!depot?.file || !depot.label.trim()) return;
    try {
      const maj = await clientCompanies.uploadClientDocument(clientCompanyId, depot.file, {
        label: depot.label.trim(),
        type: depot.type.trim() || null,
        documentDate: depot.date || null,
      });
      setFiche(maj);
      setDepot(null);
      toast.success('Document déposé.');
    } catch (err) {
      toast.error(errorMessage(err, 'Le document n’a pas pu être déposé.'));
    }
  };

  const telecharger = async (documentId: string, label: string) => {
    try {
      await clientCompanies.downloadClientDocument(clientCompanyId, documentId, label);
    } catch (err) {
      toast.error(errorMessage(err, 'Le document n’a pas pu être récupéré.'));
    }
  };

  const retirerDocument = async (documentId: string) => {
    try {
      const { clientCompany } = await clientCompanies.removeClientDocument(clientCompanyId, documentId);
      setFiche(clientCompany);
      toast.success('Document retiré.');
    } catch (err) {
      toast.error(errorMessage(err, 'Le document n’a pas pu être retiré.'));
    }
  };

  const siege = adresseLisible(fiche.registeredOffice);
  const facturation = adresseLisible(fiche.billingAddressEffective);
  const signataire = fiche.contractualSigner;
  const nomSignataire = [signataire?.firstName, signataire?.lastName]
    .map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');

  /** Raccourci de lecture : `champ('siren')` en édition, ou `undefined`. */
  const champ = (
    cle: keyof ClientCompanyFormValue,
    options: { hint?: string; placeholder?: string; type?: string } = {},
  ) => (edition
    ? {
      value: String(edition[cle] ?? ''),
      onChange: (v: string) => setEdition({ ...edition, [cle]: v }),
      erreur: erreursChamps[cle],
      ...options,
    }
    : undefined);

  /** Idem pour un champ imbriqué — signataire, contact administratif. */
  const sousChamp = <B extends 'contractualSigner' | 'administrativeContact'>(
    bloc: B,
    cle: keyof ClientCompanyFormValue[B],
    options: { hint?: string; placeholder?: string; type?: string } = {},
  ) => (edition
    ? {
      value: String((edition[bloc] as Record<string, string>)[cle as string] ?? ''),
      onChange: (v: string) => setEdition({
        ...edition,
        [bloc]: { ...(edition[bloc] as Record<string, string>), [cle as string]: v },
      }),
      erreur: erreursChamps[`${bloc}.${String(cle)}`],
      ...options,
    }
    : undefined);

  return (
    <div className="page cc-detail">
      <p className="page-eyebrow"><Link to="/clients">← Clients</Link></p>

      {/*
        ── L'EN-TÊTE RÉPOND À LA QUESTION QU'ON SE POSE EN ARRIVANT ─────────
        Qui est-ce, et que peut-il faire ? L'identité à gauche, les verdicts
        juste dessous, les actions à droite — jamais mêlées au reste.
      */}
      <header className="cc-hero">
        <span className="cc-hero-avatar" aria-hidden="true"><Icon name="building" size={28} /></span>

        <div className="cc-hero-identity">
          <h1 className="cc-hero-name">{fiche.legalName}</h1>
          <p className="cc-hero-meta">
            {fiche.tradingName && fiche.tradingName !== fiche.legalName ? `${fiche.tradingName} · ` : ''}
            {fiche.siren ? `SIREN ${fiche.siren} · ` : ''}
            {fiche.projects.length} projet{fiche.projects.length > 1 ? 's' : ''} rattaché
            {fiche.projects.length > 1 ? 's' : ''}
          </p>
          <div className="cc-hero-badges">
            {fiche.status === 'ARCHIVED' ? (
              <span className="badge badge-muted">Archivée</span>
            ) : null}
            <span className={fiche.readiness.billing.ready ? 'badge badge-ok' : 'badge badge-danger'}>
              {fiche.readiness.billing.ready ? 'Paiements possibles' : 'Paiements bloqués'}
            </span>
            <span className={fiche.readiness.signing.ready ? 'badge badge-ok' : 'badge badge-danger'}>
              {fiche.readiness.signing.ready ? 'Signatures possibles' : 'Signatures bloquées'}
            </span>
          </div>
        </div>

        {isDev ? (
          <div className="cc-hero-actions">
            {edition ? (
              <>
                <button type="button" className="btn btn-secondary" onClick={annulerEdition} disabled={enregistrement}>
                  Annuler
                </button>
                <button type="button" className="btn btn-primary" onClick={enregistrer} disabled={enregistrement}>
                  <Icon name="check2" size={13} />
                  {enregistrement ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-primary" onClick={ouvrirEdition}>
                  <Icon name="pencil" size={13} />
                  Modifier
                </button>
                <button type="button" className="btn btn-secondary" onClick={basculerArchive}>
                  {fiche.status === 'ARCHIVED' ? 'Réactiver' : 'Archiver'}
                </button>
              </>
            )}
          </div>
        ) : null}
      </header>

      {/*
        ── CE QUE CETTE FICHE PERMET, OU EMPÊCHE ────────────────────────────
        La conséquence en premier, le champ manquant ensuite. « SIREN absent »
        n'a de sens que si l'on sait ce qu'il empêche.
      */}
      {fiche.status === 'ARCHIVED' ? (
        <div className="alert alert-warn">
          Cette entreprise est <strong>archivée</strong>. Ses projets ne peuvent ni payer ni signer.
          Sa fiche et son histoire restent intégralement consultables.
        </div>
      ) : !fiche.readiness.ready ? (
        <div className="alert alert-warn">
          {!fiche.readiness.billing.ready ? (
            <p>
              <strong>Aucun paiement possible</strong> pour les projets de ce client :{' '}
              {fiche.readiness.billing.missing.join(', ')}.
            </p>
          ) : null}
          {!fiche.readiness.signing.ready ? (
            <p>
              <strong>Aucune signature possible</strong> : {fiche.readiness.signing.missing.join(', ')}.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="alert alert-ok">
          Fiche complète : les projets de ce client peuvent payer et signer.
        </div>
      )}

      {edition ? (
        <div className="alert alert-info cc-edit-notice">
          Modification en cours. L’enregistrement publie immédiatement la nouvelle identité aux
          projets rattachés — les factures et contrats <strong>déjà émis</strong> ne sont jamais
          réécrits.
        </div>
      ) : null}

      <Section icon="building" titre="Identité">
        <Ligne
          label="Raison sociale"
          value={fiche.legalName}
          edition={champ('legalName', {
            placeholder: 'SARL DUPONT AUTOMOBILES',
            hint: 'Ce qui figure sur la facture. Jamais l’enseigne.',
          })}
        />
        <Ligne
          label="Nom commercial"
          value={fiche.tradingName}
          edition={champ('tradingName', { placeholder: 'Auto Lilas' })}
        />
        <Ligne label="Forme juridique" value={fiche.legalForm} edition={champ('legalForm', { placeholder: 'SARL' })} />
        <Ligne
          label="SIREN"
          value={fiche.siren}
          edition={champ('siren', {
            placeholder: '732 829 320',
            hint: '9 chiffres. Mention obligatoire de la facture électronique au 1ᵉʳ septembre 2026.',
          })}
        />
        <Ligne
          label="SIRET"
          value={fiche.siret}
          edition={champ('siret', { placeholder: '732 829 320 00074', hint: '14 chiffres, commençant par le SIREN.' })}
        />
        <Ligne label="N° de TVA" value={fiche.vatNumber} edition={champ('vatNumber', { placeholder: 'FR44732829320' })} />
        <Ligne
          label="Ville d’immatriculation"
          value={fiche.registrationCity}
          edition={champ('registrationCity', { placeholder: 'Nice' })}
        />
      </Section>

      <Section icon="geo-alt" titre="Coordonnées">
        <BlocAdresse
          titre="Siège social"
          lecture={siege}
          edition={edition
            ? {
              value: edition.registeredOffice,
              onChange: (v) => setEdition({ ...edition, registeredOffice: v }),
              prefixe: 'registeredOffice',
              erreurs: erreursChamps,
            }
            : undefined}
        />
        <Ligne label="Téléphone" value={fiche.phone} edition={champ('phone', { placeholder: '+33 4 00 00 00 00' })} />
        <Ligne
          label="Site web"
          value={fiche.website}
          edition={champ('website', { placeholder: 'https://exemple.fr' })}
        />
        <Ligne
          label="Contact administratif"
          value={fiche.administrativeContact?.name}
          edition={sousChamp('administrativeContact', 'name', { placeholder: 'Marie Martin' })}
        />
        <Ligne
          label="E-mail du contact"
          value={fiche.administrativeContact?.email}
          edition={sousChamp('administrativeContact', 'email', { type: 'email', placeholder: 'contact@exemple.fr' })}
        />
      </Section>

      <Section icon="credit-card" titre="Facturation">
        {/*
          LE VERDICT EN TÊTE DE SECTION, et pas seulement dans la bannière :
          c'est ICI qu'on vient corriger ce qui bloque, et savoir CE QUI manque
          au moment où l'on regarde les champs évite un aller-retour.
        */}
        <div className="cc-field">
          <span className="cc-field-label">État</span>
          <span className="cc-field-value">
            {fiche.readiness.billing.ready ? (
              <span className="badge badge-ok">Prête à facturer</span>
            ) : (
              <>
                <span className="badge badge-danger">Incomplète</span>
                <span className="muted"> — il manque : {fiche.readiness.billing.missing.join(', ')}.</span>
              </>
            )}
          </span>
        </div>

        <Ligne
          label="E-mail de facturation"
          value={fiche.billingEmail}
          edition={champ('billingEmail', {
            type: 'email',
            placeholder: 'comptabilite@exemple.fr',
            hint: 'C’est à cette adresse que la facture part.',
          })}
        />

        {edition ? (
          <>
            <Checkbox
              checked={edition.useBillingAddress}
              onChange={(v) => setEdition({ ...edition, useBillingAddress: v })}
              label="L’adresse de facturation diffère du siège"
              hint="Décochée, la facture part à l’adresse du siège — jamais à une adresse vide."
            />
            {edition.useBillingAddress ? (
              <BlocAdresse
                titre="Adresse de facturation"
                lecture={null}
                edition={{
                  value: edition.billingAddress,
                  onChange: (v) => setEdition({ ...edition, billingAddress: v }),
                  prefixe: 'billingAddress',
                  erreurs: erreursChamps,
                }}
              />
            ) : null}
          </>
        ) : (
          <Ligne
            label="Adresse de facturation"
            value={facturation}
          />
        )}

        {!edition && facturation && facturation === siege ? (
          <p className="cc-note">Identique au siège social — c’est là que la facture part.</p>
        ) : null}
      </Section>

      <Section icon="person" titre="Signataire contractuel">
        {edition ? (
          <>
            <Ligne label="Prénom" value={null} edition={sousChamp('contractualSigner', 'firstName', { placeholder: 'Marc' })} />
            <Ligne label="Nom" value={null} edition={sousChamp('contractualSigner', 'lastName', { placeholder: 'Dupont' })} />
            <Ligne label="Fonction" value={null} edition={sousChamp('contractualSigner', 'jobTitle', { placeholder: 'Gérant' })} />
            <Ligne label="E-mail" value={null} edition={sousChamp('contractualSigner', 'email', { type: 'email', placeholder: 'marc@exemple.fr' })} />
            <Ligne label="Téléphone" value={null} edition={sousChamp('contractualSigner', 'phone', { placeholder: '+33 6 00 00 00 00' })} />
            <p className="cc-note">
              Laissés entièrement vides, ces champs signifient « personne n’est désigné » — et
              aucune signature ne pourra être ouverte.
            </p>
          </>
        ) : nomSignataire ? (
          <>
            <Ligne label="Nom" value={nomSignataire} />
            <Ligne label="Fonction" value={signataire?.jobTitle} />
            <Ligne label="E-mail" value={signataire?.email} />
            <Ligne label="Téléphone" value={signataire?.phone} />
          </>
        ) : (
          <p className="muted">
            Aucun signataire désigné. Aucune demande de signature ne pourra être ouverte pour les
            projets de ce client.
          </p>
        )}
      </Section>

      <Section
        icon="stack"
        titre="Projets rattachés"
        action={isDev && !edition ? (
          /*
            ── LE SÉLECTEUR REMPLACE UN `<select>` NATIF ────────────────────
            Le natif ouvrait une liste dessinée par le système : hors thème, et
            réduite à une ligne de texte par option — impossible d'y distinguer
            deux instances d'un même projet sur deux environnements.

            C'est le MÊME composant que les filtres du Panel, en mode
            cherchable : mêmes règles de clavier, même fermeture, même thème.
          */
          <ThemedSelect
            value={rattachement}
            options={rattachables}
            onChange={(v) => { setRattachement(v); void rattacher(v); }}
            placeholder="Ajouter un projet…"
            ariaLabel="Ajouter un projet à cette entreprise"
            searchable
            searchPlaceholder="Rechercher un projet…"
            emptyLabel="Aucun projet libre. Un projet déjà rattaché se change depuis sa propre fiche."
          />
        ) : undefined}
      >
        {fiche.projects.length === 0 ? (
          <p className="muted">Aucun projet n’est rattaché à cette entreprise.</p>
        ) : (
          <ul className="cc-rows">
            {fiche.projects.map((p) => (
              <li key={p.projectId} className="cc-row">
                <span className="cc-row-icon" aria-hidden="true"><Icon name="plug" size={16} /></span>
                <span className="cc-row-body">
                  <span className="cc-row-title">{p.projectName}</span>
                  <span className="cc-row-meta">
                    {p.environment ?? 'Environnement inconnu'}
                    {' · '}
                    {p.paired ? 'Appairé' : 'Non appairé'}
                  </span>
                </span>
                <span className="cc-row-actions">
                  <Link
                    to={`/projects/${p.projectId}`}
                    className="btn btn-secondary btn-sm"
                    aria-label={`Voir le projet ${p.projectName}`}
                  >
                    Voir
                    <Icon name="chevron-right" size={12} />
                  </Link>
                  {isDev ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setARetirer({ projectId: p.projectId, projectName: p.projectName })}
                      aria-label={`Retirer le projet ${p.projectName}`}
                    >
                      <Icon name="x-lg" size={12} />
                      Retirer
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        icon="file-earmark-text"
        titre="Documents"
        action={isDev && !edition ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setDepot({ file: null, label: '', type: '', date: '' })}
          >
            <Icon name="plus-lg" size={12} />
            Déposer
          </button>
        ) : undefined}
      >
        {/*
          ── AUCUNE URL N'EXISTE POUR CES FICHIERS ──────────────────────────
          Ils vivent dans le stockage PRIVÉ du Panel, qu'aucun serveur statique
          ne dessert. Le téléchargement passe par une route authentifiée portée
          par CETTE fiche : un identifiant récupéré ailleurs ne mène nulle part.

          C'est aussi pourquoi il n'y a pas de bouton « Voir » ici : il n'y a
          rien à ouvrir dans un onglet. Proposer un aperçu obligerait à servir
          le fichier par une adresse, ce que ce stockage refuse par conception.
        */}
        {fiche.documents.length === 0 ? (
          <p className="muted">Aucun document déposé.</p>
        ) : (
          <ul className="cc-rows">
            {fiche.documents.map((d) => (
              <li key={d.documentId} className="cc-row">
                <span className="cc-row-icon" aria-hidden="true"><Icon name="file-earmark-text" size={16} /></span>
                <span className="cc-row-body">
                  <span className="cc-row-title">{d.label}</span>
                  <span className="cc-row-meta">
                    {d.type ?? 'Sans catégorie'}
                    {d.documentDate ? ` · daté du ${d.documentDate}` : ''}
                    {` · déposé le ${formatDateTime(d.uploadedAt)}`}
                  </span>
                </span>
                <span className="cc-row-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => telecharger(d.documentId, d.label)}
                    aria-label={`Télécharger ${d.label}`}
                  >
                    <Icon name="download" size={12} />
                    Télécharger
                  </button>
                  {isDev ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => retirerDocument(d.documentId)}
                      aria-label={`Retirer ${d.label}`}
                    >
                      <Icon name="x-lg" size={12} />
                      Retirer
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {edition || fiche.notes ? (
        <Section icon="pencil" titre="Note interne">
          {edition ? (
            <label className="cc-field cc-field-editing">
              <span className="cc-field-label">Note</span>
              <textarea
                className="input cc-field-input cc-textarea"
                rows={3}
                value={edition.notes}
                onChange={(e) => setEdition({ ...edition, notes: e.target.value })}
              />
              <span className="cc-field-hint">
                Jamais publiée au projet, jamais imprimée sur une facture.
              </span>
            </label>
          ) : (
            <>
              <p>{fiche.notes}</p>
              <p className="muted">Jamais publiée au projet, jamais imprimée sur une facture.</p>
            </>
          )}
        </Section>
      ) : null}

      {/*
        ── RETIRER UN PROJET SE CONFIRME ──────────────────────────────────────
        Ce n'est pas un geste d'affichage : le projet perd son client légal, et
        avec lui la possibilité d'encaisser et de faire signer. La conséquence
        est écrite AVANT le bouton, pas après le clic.
      */}
      {aRetirer ? (
        <Modal
          title={`Retirer « ${aRetirer.projectName} » ?`}
          danger
          onClose={() => setARetirer(null)}
        >
          <p>
            Ce projet ne sera plus rattaché à <strong>{fiche.legalName}</strong>. Les nouvelles
            opérations de paiement et de signature seront bloquées tant qu’aucune autre entreprise
            ne lui sera rattachée.
          </p>
          <p className="muted">
            Les contrats et factures déjà émis conservent l’identité de facturation sous laquelle
            ils ont été établis : rien de passé n’est réécrit.
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setARetirer(null)}>
              Annuler
            </button>
            <button type="button" className="btn btn-danger" onClick={detacher}>
              Retirer le projet
            </button>
          </div>
        </Modal>
      ) : null}

      {depot ? (
        <Modal
          title="Déposer un document"
          hint="Kbis, attestation de vigilance, mandat, RIB… Le fichier n’est jamais servi par une adresse publique."
          onClose={() => setDepot(null)}
        >
          <div className="form">
            <label className="field">
              <span className="field-label">Fichier</span>
              <input
                className="input"
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => setDepot({ ...depot, file: e.target.files?.[0] ?? null })}
              />
            </label>
            <label className="field">
              <span className="field-label">Nom du document *</span>
              <input
                className="input"
                value={depot.label}
                onChange={(e) => setDepot({ ...depot, label: e.target.value })}
                placeholder="Kbis 2026"
              />
            </label>
            <label className="field">
              <span className="field-label">Catégorie</span>
              <input
                className="input"
                value={depot.type}
                onChange={(e) => setDepot({ ...depot, type: e.target.value })}
                placeholder="KBIS"
              />
              <span className="field-hint">Libre : KBIS, RIB, MANDAT… ou rien.</span>
            </label>
            <label className="field">
              <span className="field-label">Date du document</span>
              <input
                className="input"
                type="date"
                value={depot.date}
                onChange={(e) => setDepot({ ...depot, date: e.target.value })}
              />
              <span className="field-hint">La date du document lui-même, pas celle du dépôt.</span>
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setDepot(null)}>Annuler</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!depot.file || depot.label.trim().length === 0}
              onClick={deposer}
            >
              Déposer
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export default ClientCompanyDetailPage;
