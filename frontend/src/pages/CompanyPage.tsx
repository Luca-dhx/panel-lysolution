// L'ENTREPRISE — Phase 4, LOTS 2 et 3.
//
// L'écran est construit autour de la distinction qui structure tout le
// modèle : SAISIR n'est pas PUBLIER.
//
//   · les champs modifient un BROUILLON, sans effet sur le parc ;
//   · un bandeau signale en permanence qu'un brouillon diverge de la
//     version publiée ;
//   · publier est un acte distinct, qui exige une raison et annonce combien
//     de projets recevront la configuration.
//
// Sans ce bandeau, un opérateur croirait avoir diffusé ce qu'il vient de
// saisir — c'est l'erreur que ce modèle rend impossible.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { DetailList, Disclosure } from '@/components/supervision';
import { LogoField, ReferencesEditor, SignerSection } from '@/components/company/DeveloperIdentity';
import { company as api, errorMessage } from '@/lib/api';
import type { CompanyState, VersionRow } from '@/types.company';

/**
 * FICHE VIERGE — la même forme que celle du serveur, sans aucune valeur.
 *
 * Elle n'existe que le temps de la première saisie : le formulaire s'édite
 * ainsi à l'identique avant et après la création, sans écran intermédiaire ni
 * champ technique. `slug` et `environment` sont vides à dessein — le serveur
 * les déduit, l'interface ne les montre jamais.
 */
const EMPTY_COMPANY = {
  companyId: '',
  slug: '',
  environment: '',
  identity: { name: '', legalName: null, tagline: null, description: null },
  branding: {
    logoUrl: null, logoDarkUrl: null, faviconUrl: null,
    primaryColor: null, secondaryColor: null, accentColor: null, fontFamily: null,
  },
  domains: { primaryDomain: null, websiteUrl: null, wildcardBases: [] },
  contacts: {
    email: null, phone: null, supportEmail: null,
    address: { line1: null, line2: null, postalCode: null, city: null, country: null },
  },
  legal: {
    legalForm: null, siret: null, vatNumber: null,
    legalRepresentative: null, hostingProvider: null,
  },
  settings: { locale: 'fr-FR', timezone: 'Europe/Paris', currency: 'EUR' },
  signer: null,
  references: [],
  active: true,
  publishedVersion: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
} as unknown as NonNullable<CompanyState['company']>;

export function CompanyPage() {
  const [state, setState] = useState<CompanyState | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // La fiche n'existe pas encore, mais on la remplit déjà : l'enregistrement
  // final la créera. Aucun état intermédiaire n'est persisté côté serveur.
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const current = await api.current();
      setState(current);
      if (current.company) setVersions((await api.versions()).items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Entreprise indisponible.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
      setDraft({});
    } catch (err) {
      setError(errorMessage(err, 'Opération refusée.'));
    } finally {
      setBusy(false);
    }
  };

  if (error && !state) return <div className="page"><div className="alert alert-error">{error}</div></div>;
  if (!state) return <div className="page"><p className="muted">Chargement…</p></div>;

  /**
   * PREMIÈRE FOIS — un état vide, puis le formulaire. Rien d'autre.
   *
   * ── CE QUI A ÉTÉ SUPPRIMÉ ─────────────────────────────────────────────────
   * Un écran de création demandait un identifiant et un environnement avant
   * de laisser entrer dans la fiche. Deux notions techniques posées à
   * quelqu'un qui veut simplement décrire son entreprise, et deux occasions
   * de se tromper une fois pour toutes : l'identifiant voyage jusqu'aux
   * projets, l'environnement ne peut pas être choisi puisqu'il est celui du
   * Panel qui tourne. Le serveur les déduit désormais tous les deux.
   *
   * Il reste un formulaire, le même avant et après la création — comme les
   * réglages de n'importe quel outil.
   */
  if (!state.company && !creating) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Mon entreprise</h1>
          <p className="muted">
            Votre identité, partagée avec les projets que vous opérez.
          </p>
        </header>
        <EmptyState
          title="Aucune entreprise configurée"
          hint="Le Panel ne peut pas se présenter aux projets tant qu’il ne sait pas qui il représente."
        />
        <div className="action-buttons">
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            Créer mon entreprise
          </button>
        </div>
      </div>
    );
  }

  // Avant la création, le formulaire s'édite sur une fiche vierge : mêmes
  // champs, mêmes règles, seul le bouton final diffère.
  const existe = Boolean(state.company);
  const c = state.company ?? EMPTY_COMPANY;

  const field = (path: string, value: string | null) => (
    <input
      type="text"
      value={(draft[path] as string) ?? value ?? ''}
      onChange={(e) => setDraft({ ...draft, [path]: e.target.value })}
    />
  );

  /**
   * L'ADRESSE TELLE QU'ELLE SERA PUBLIÉE — brouillon compris.
   *
   * L'aperçu ne s'affiche que sur une URL absolue : un lien relatif pointerait
   * sur le site du client, ce qui serait pire que pas de lien. La validation
   * définitive reste côté serveur (`company.validation.js`) ; ici on décide
   * seulement s'il y a quelque chose à montrer.
   */
  // Le nom est la seule chose exigée pour créer : tout le reste se complète
  // ensuite, comme dans n'importe quel réglage.
  const nomSaisi = String((draft['identity.name'] as string) ?? c.identity.name ?? '').trim().length > 0;

  const siteWebBrut = ((draft['domains.websiteUrl'] as string) ?? c.domains.websiteUrl ?? '').trim();
  const siteWeb = /^https?:\/\//i.test(siteWebBrut) ? siteWebBrut : '';

  const patch = () => {
    // Le brouillon est à plat (« branding.primaryColor ») ; l'API attend un
    // objet. On reconstruit à l'envoi plutôt que de manipuler un objet
    // imbriqué à chaque frappe.
    const body: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(draft)) {
      // Le signataire et les références sont des BLOCS entiers, pas des
      // champs : ils s'écrivent tels quels, sans passer par « groupe.clé ».
      if (!path.includes('.')) { body[path] = value; continue; }
      const [group, key] = path.split('.');
      const courant = (body[group] as Record<string, unknown>) ?? {};
      body[group] = { ...courant, [key]: value === '' ? null : value };
    }
    return body;
  };

  // Blocs édités d'un seul tenant — brouillon d'abord, valeur publiée sinon.
  const signataire = (draft.signer as typeof c.signer) ?? c.signer ?? null;
  const references = (draft.references as typeof c.references) ?? c.references ?? [];
  const logo = (draft['branding.logoUrl'] as string) ?? c.branding.logoUrl ?? '';

  return (
    <div className="page">
      <header className="page-head">
        <h1>Mon entreprise{c.identity.name ? ` — ${c.identity.name}` : ''}</h1>
        <p className="muted">
          Votre identité, partagée avec les projets que vous opérez.
        </p>
        {/*
          L'identifiant interne et l'environnement ne sont plus affichés ici :
          l'un est une clé technique que personne n'a à connaître, l'autre est
          déjà indiqué en permanence dans l'en-tête du Panel. Seul l'état de
          publication reste — c'est une information, pas un réglage.
        */}
        {existe ? (
          <div className="execution-head">
            {c.publishedVersion === null ? (
              <span className="badge badge-warn">Jamais publiée</span>
            ) : (
              <span className="badge badge-ok">Version {c.publishedVersion} publiée</span>
            )}
          </div>
        ) : null}
      </header>

      {/* — Le bandeau qui évite le malentendu central ————————— */}
      {c.hasUnpublishedChanges ? (
        <p className="mode-notice mode-execution">
          Des modifications ont été saisies depuis la dernière publication.
          <strong> Les projets appliquent encore la version {c.publishedVersion}.</strong>
          {' '}Publiez pour les diffuser.
        </p>
      ) : null}
      {c.publishedVersion === null ? (
        <p className="mode-notice mode-simulation">
          Cette entreprise n’a jamais été publiée : aucun projet ne la connaît
          encore. Saisir ne diffuse rien — la publication est un acte distinct.
        </p>
      ) : null}

      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-success">{notice}</div> : null}

      {/* — Identité ————————————————————————————————————— */}
      <Card title="Identité">
        <div className="parameter-form">
          <label className="field"><span className="field-label">Nom</span>{field('identity.name', c.identity.name)}</label>
          <label className="field"><span className="field-label">Raison sociale</span>{field('identity.legalName', c.identity.legalName)}</label>
          <label className="field"><span className="field-label">Signature</span>{field('identity.tagline', c.identity.tagline)}</label>
          <label className="field"><span className="field-label">Description</span>{field('identity.description', c.identity.description)}</label>
        </div>
      </Card>

      {/* — Marque ———————————————————————————————————————— */}
      <Card title="Marque">
        <div className="parameter-form">
          <label className="field"><span className="field-label">Favicon (https)</span>{field('branding.faviconUrl', c.branding.faviconUrl)}</label>
          <label className="field">
            <span className="field-label">Couleur primaire</span>
            {field('branding.primaryColor', c.branding.primaryColor)}
            <span className="field-hint muted">Hexadécimal, ex. #1b4dff</span>
          </label>
          <label className="field"><span className="field-label">Couleur secondaire</span>{field('branding.secondaryColor', c.branding.secondaryColor)}</label>
          <label className="field"><span className="field-label">Police</span>{field('branding.fontFamily', c.branding.fontFamily)}</label>
        </div>
        <div className="colour-preview">
          {[c.branding.primaryColor, c.branding.secondaryColor, c.branding.accentColor]
            .filter(Boolean)
            .map((colour) => (
              <span key={colour as string} className="colour-chip" style={{ background: colour as string }}>
                {colour}
              </span>
            ))}
        </div>
      </Card>

      {/*
        IDENTITÉ DÉVELOPPEUR — les blocs repris du Manager, dont le Panel est
        désormais l'autorité. Ils remplacent les champs texte bruts : on ne
        publie pas à l'aveugle une identité que tous les projets afficheront.
      */}
      <LogoField value={logo} onChange={(url) => setDraft({ ...draft, 'branding.logoUrl': url })} />

      <SignerSection
        value={signataire}
        onChange={(signer) => setDraft({ ...draft, signer })}
      />

      <ReferencesEditor
        value={references}
        onChange={(refs) => setDraft({ ...draft, references: refs })}
      />

      {/* — Coordonnées et mentions légales ————————————————— */}
      <Disclosure title="Coordonnées">
        <div className="parameter-form">
          <label className="field"><span className="field-label">E-mail</span>{field('contacts.email', c.contacts.email)}</label>
          <label className="field"><span className="field-label">Téléphone</span>{field('contacts.phone', c.contacts.phone)}</label>
          <label className="field"><span className="field-label">Support</span>{field('contacts.supportEmail', c.contacts.supportEmail)}</label>
        </div>
      </Disclosure>

      <Disclosure title="Mentions légales">
        <div className="parameter-form">
          <label className="field"><span className="field-label">Forme juridique</span>{field('legal.legalForm', c.legal.legalForm)}</label>
          <label className="field"><span className="field-label">SIRET</span>{field('legal.siret', c.legal.siret)}</label>
          <label className="field"><span className="field-label">TVA</span>{field('legal.vatNumber', c.legal.vatNumber)}</label>
          <label className="field"><span className="field-label">Représentant légal</span>{field('legal.legalRepresentative', c.legal.legalRepresentative)}</label>
          <label className="field"><span className="field-label">Hébergeur</span>{field('legal.hostingProvider', c.legal.hostingProvider)}</label>
        </div>
      </Disclosure>

      <Disclosure title="Domaines et paramètres">
        <div className="parameter-form">
          {/*
            LE SITE DE L'ENTREPRISE — publié aux projets, et affiché dans leur
            footer (« Réalisé par … »). Il n'était que consultable ici : sans
            moyen de le renseigner, aucun projet ne pouvait le montrer.
            Facultatif : sans lui, le footer affiche le nom sans lien.
          */}
          <label className="field">
            <span className="field-label">Site de l’entreprise</span>
            {field('domains.websiteUrl', c.domains.websiteUrl)}
            <span className="field-hint">
              Affiché dans le footer des sites que vous opérez : « Réalisé par {c.identity.name} ».
              {siteWeb ? ' Le nom sera cliquable.' : ' Sans adresse, le nom reste affiché sans lien.'}
            </span>
          </label>
          {siteWeb ? (
            <p className="field-hint">
              Aperçu :{' '}
              <a href={siteWeb} target="_blank" rel="noopener noreferrer">{siteWeb}</a>
            </p>
          ) : null}
        </div>
        <DetailList
          items={[
            ['Domaine principal', c.domains.primaryDomain ?? <span className="muted">non renseigné</span>],
            ['Langue', c.settings.locale],
            ['Fuseau', c.settings.timezone],
            ['Devise', c.settings.currency],
          ]}
        />
      </Disclosure>

      <div className="action-buttons">
        {/*
          UN SEUL BOUTON, deux chemins. À la première fois il crée la fiche ;
          ensuite il enregistre le brouillon. L'utilisateur, lui, fait le même
          geste : il décrit son entreprise et il enregistre.
        */}
        <button
          type="button"
          className="btn"
          disabled={busy || (existe ? Object.keys(draft).length === 0 : !nomSaisi)}
          onClick={() => run(async () => {
            if (!existe) {
              // L'identifiant interne et l'environnement sont déduits par le
              // serveur : rien à demander, rien à afficher.
              await api.create(patch());
              setCreating(false);
              return 'Entreprise créée. Rien n’a encore été diffusé aux projets.';
            }
            await api.update(patch());
            return 'Brouillon enregistré. Rien n’a été diffusé aux projets.';
          })}
        >
          {existe ? 'Enregistrer le brouillon' : 'Créer mon entreprise'}
        </button>
        {existe && Object.keys(draft).length > 0 ? (
          <button type="button" className="btn btn-small" onClick={() => setDraft({})}>Annuler les modifications</button>
        ) : null}
        {!existe ? (
          <button type="button" className="btn btn-small" onClick={() => { setCreating(false); setDraft({}); }}>
            Annuler
          </button>
        ) : null}
      </div>

      {/* — Publication ————————————————————————————————— */}
      <Card title="Publier la configuration">
        <p className="muted">
          Publier fige une version immuable et la diffuse à tous les projets
          appairés. La raison est conservée dans l’historique : elle sert à
          relire la décision des mois plus tard.
        </p>
        <label className="field">
          <span className="field-label">Raison de cette publication</span>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="action-buttons">
          <button
            type="button" className="btn btn-danger" disabled={busy || !reason.trim()}
            onClick={() => run(async () => {
              const result = await api.publish(reason.trim());
              setReason('');
              return `Version ${result.version} publiée — ${result.changes.length} changement(s), ${result.recipients} projet(s) destinataire(s).`;
            })}
          >
            Publier
          </button>
        </div>
      </Card>

      {/* — Historique ——————————————————————————————————— */}
      <Disclosure title={`Historique des versions (${versions.length})`}>
        {versions.length === 0 ? (
          <p className="muted">Aucune version publiée.</p>
        ) : (
          <ul className="version-list">
            {versions.map((v) => (
              <li key={v.version} className={v.current ? 'version-current' : undefined}>
                <div className="version-head">
                  <span className="version-number">v{v.version}</span>
                  {v.current ? <span className="badge badge-ok">en vigueur</span> : null}
                  <span className="muted">{v.publishedAt}</span>
                  <span className="muted">{v.changeCount} changement(s)</span>
                </div>
                <p className="version-reason">{v.reason}</p>
                <p className="muted">Par {v.publishedBy ?? 'inconnu'}</p>
                {!v.current ? (
                  <button
                    type="button" className="btn btn-small" disabled={busy}
                    onClick={() => run(async () => {
                      const result = await api.restore(v.version);
                      return `Version ${v.version} restaurée — publiée comme version ${result.version}.`;
                    })}
                  >
                    Restaurer cette version
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="muted read-only-note">
          Restaurer ne réécrit pas l’histoire : une version neuve est publiée
          avec l’ancien contenu, et le retour en arrière est lui-même tracé.
        </p>
      </Disclosure>

      <p><Link to="/integrated-apis">API intégrées de l’entreprise →</Link></p>
    </div>
  );
}

