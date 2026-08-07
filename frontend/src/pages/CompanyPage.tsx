// MON ENTREPRISE — ce que le Panel dit de lui aux projets qu'il opère.
//
// ── CE QUI A ÉTÉ SUPPRIMÉ, ET POURQUOI ──────────────────────────────────────
//
// 1. LE BROUILLON. L'écran distinguait « enregistrer » de « publier », le
//    second exigeant une justification écrite. Deux gestes pour une intention
//    unique : décrire son entreprise. Le brouillon ne servait qu'à créer un
//    état où ce qu'on voit à l'écran n'est pas ce que les projets appliquent —
//    exactement le malentendu qu'il prétendait éviter. Enregistrer publie.
//
// 2. LA RAISON DE PUBLICATION. En pratique elle valait « maj », « correction »,
//    « test » : un péage sans information, franchi machinalement. Le diff des
//    champs modifiés, lui, se relit vraiment — et il est calculé tout seul.
//
// 3. LE BLOC « MARQUE ». Couleurs et police n'étaient consommées par personne.
//    Le favicon, lui, l'est : il a rejoint la Configuration technique.
//
// 4. LE BLOC « COORDONNÉES ». Un e-mail, un téléphone et une adresse de support
//    dans des champs figés, alors que les RÉFÉRENCES font déjà cela — avec une
//    icône, un libellé libre, un ordre, et autant d'entrées qu'on veut. Seul
//    l'e-mail d'émission des certificats a survécu, parce que le moteur de
//    déploiement le lit vraiment ; il est passé en Configuration technique, où
//    l'on ne risque plus de le confondre avec un contact public.
//
// ── L'ORDRE DES BLOCS ───────────────────────────────────────────────────────
// Identité, références, signataire, équipe : du plus public au plus interne.
// La configuration technique vient en dernier, repliée — elle n'intéresse
// personne au quotidien.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { Disclosure } from '@/components/supervision';
import {
  LogoField, ReferencesEditor, SignerSection, TeamEditor,
} from '@/components/company/DeveloperIdentity';
import { company as api, errorMessage } from '@/lib/api';
import type { CompanyState, StoredMediaDescriptor, VersionRow } from '@/types.company';

/**
 * FICHE VIERGE — la même forme que celle du serveur, sans aucune valeur.
 *
 * Elle n'existe que le temps de la première saisie : le formulaire s'édite
 * ainsi à l'identique avant et après la création. `slug` et `environment` sont
 * vides à dessein — le serveur les déduit, l'interface ne les montre jamais.
 */
const EMPTY_COMPANY = {
  companyId: '',
  slug: '',
  environment: '',
  identity: { name: '', legalName: null, tagline: null, description: null },
  branding: {
    logoUrl: null, faviconUrl: null,
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
  team: [],
  active: true,
  publishedVersion: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
} as unknown as NonNullable<CompanyState['company']>;

export function CompanyPage() {
  const [state, setState] = useState<CompanyState | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
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
   * Un écran de création demandait autrefois un identifiant et un environnement
   * avant de laisser entrer dans la fiche : deux notions techniques posées à
   * quelqu'un qui veut simplement décrire son entreprise. Le serveur les déduit.
   */
  if (!state.company && !creating) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Mon entreprise</h1>
          <p className="muted">Votre identité, partagée avec les projets que vous opérez.</p>
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

  const existe = Boolean(state.company);
  const c = state.company ?? EMPTY_COMPANY;

  const field = (path: string, value: string | null) => (
    <input
      type="text"
      value={(draft[path] as string) ?? value ?? ''}
      onChange={(e) => setDraft({ ...draft, [path]: e.target.value })}
    />
  );

  // Le nom est la seule chose exigée pour créer : tout le reste se complète
  // ensuite, comme dans n'importe quel réglage.
  const nomSaisi = String((draft['identity.name'] as string) ?? c.identity.name ?? '').trim().length > 0;

  const siteWebBrut = ((draft['domains.websiteUrl'] as string) ?? c.domains.websiteUrl ?? '').trim();
  const siteWeb = /^https?:\/\//i.test(siteWebBrut) ? siteWebBrut : '';

  const patch = () => {
    // Le brouillon est à plat (« branding.logoUrl ») ; l'API attend un objet.
    // On reconstruit à l'envoi plutôt que de manipuler un objet imbriqué à
    // chaque frappe.
    const body: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(draft)) {
      // Les aperçus sont des ADRESSES CALCULÉES, gardées le temps de l'écran.
      // Les renvoyer les ferait écrire en fiche — le défaut même qu'on corrige.
      if (path.endsWith('Preview')) continue;
      // Signataire, références et équipe sont des BLOCS entiers, pas des
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
  const equipe = (draft.team as typeof c.team) ?? c.team ?? [];
  /**
   * LE LOGO SE LIT EN TROIS MORCEAUX, ET C'EST VOULU.
   *
   * · `logo` — le chemin de stockage, ce qui part dans `branding.logoUrl` ;
   * · `logoDescripteur` — LA source de vérité, ce qui part dans `branding.logo` ;
   * · `logoApercu` — l'adresse d'affichage, calculée par le serveur, qui ne
   *   repart JAMAIS. L'écrire en fiche est exactement le défaut qu'on corrige.
   *
   * Pendant l'édition, l'aperçu vient de l'import ; après rechargement, du bloc
   * `media` résolu par le serveur.
   */
  const logo = (draft['branding.logoUrl'] as string) ?? c.branding.logoUrl ?? '';
  const logoDescripteur = (draft['branding.logo'] as StoredMediaDescriptor | null | undefined)
    ?? c.branding.logo ?? null;
  const logoApercu = (draft['branding.logoPreview'] as string | undefined)
    ?? state.media?.['branding.logo']?.url
    ?? null;
  /** Les aperçus résolus par le serveur, à plat : `branding.logo`, `team.0.photo`. */
  const apercusMedias = Object.fromEntries(
    Object.entries(state.media ?? {}).map(([chemin, m]) => [chemin, m.url]),
  );
  /** Les trois médias de marque suivent EXACTEMENT le même chemin. */
  const mediaMarque = (cle: 'logo' | 'favicon', champUrl: string) => ({
    value: (draft[champUrl] as string)
      ?? (c.branding as unknown as Record<string, string | null>)[champUrl.split('.')[1]]
      ?? '',
    descriptor: (draft[`branding.${cle}`] as StoredMediaDescriptor | null | undefined)
      ?? (c.branding as unknown as Record<string, StoredMediaDescriptor | null>)[cle] ?? null,
    previewUrl: (draft[`branding.${cle}Preview`] as string | undefined)
      ?? state.media?.[`branding.${cle}`]?.url ?? null,
    published: draft[`branding.${cle}Preview`] !== undefined
      ? /^https?:\/\//i.test(String(draft[`branding.${cle}Preview`] ?? ''))
      : Boolean(state.media?.[`branding.${cle}`]?.published),
    onChange: (path: string, descriptor: StoredMediaDescriptor | null, previewUrl?: string) => setDraft({
      ...draft,
      [champUrl]: path,
      [`branding.${cle}`]: descriptor,
      [`branding.${cle}Preview`]: previewUrl ?? path,
    }),
  });

  const logoPublie = draft['branding.logoPreview'] !== undefined
    ? /^https?:\/\//i.test(String(draft['branding.logoPreview'] ?? ''))
    : Boolean(state.media?.['branding.logo']?.published);

  const modifie = Object.keys(draft).length > 0;

  /** Le bouton unique : créer la première fois, enregistrer ensuite. */
  const enregistrer = () => run(async () => {
    if (!existe) {
      const r = await api.create(patch());
      setCreating(false);
      return `Entreprise créée et diffusée à ${r.recipients} projet(s).`;
    }
    const r = await api.update(patch());
    // Enregistrer sans rien avoir changé est un geste anodin : on le dit,
    // on ne le punit pas.
    if (!r.published) return 'Aucune modification à diffuser.';
    return `Version ${r.version} diffusée à ${r.recipients} projet(s).`;
  });

  return (
    <div className="page">
      <header className="page-head">
        <h1>Mon entreprise{c.identity.name ? ` — ${c.identity.name}` : ''}</h1>
        <p className="muted">
          Votre identité, partagée avec les projets que vous opérez. Chaque
          enregistrement est diffusé immédiatement.
        </p>
        {existe ? (
          <div className="execution-head">
            {c.publishedVersion === null ? (
              <span className="badge badge-warn">Jamais diffusée</span>
            ) : (
              <span className="badge badge-ok">Version {c.publishedVersion} en vigueur</span>
            )}
          </div>
        ) : null}
      </header>

      {/*
        Ce bandeau ne devrait jamais apparaître : enregistrer publie. Il subsiste
        pour le seul cas où la diffusion a échoué après l'écriture — sans lui,
        l'écran montrerait une fiche que les projets n'ont pas.
      */}
      {c.hasUnpublishedChanges ? (
        <p className="mode-notice mode-execution">
          La dernière diffusion n’a pas abouti.
          <strong> Les projets appliquent encore la version {c.publishedVersion}.</strong>
          {' '}Enregistrez de nouveau pour les mettre à jour.
        </p>
      ) : null}

      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-success">{notice}</div> : null}

      {/* 1 — IDENTITÉ : ce qu'un visiteur lit en bas d'un site. */}
      <Card title="Identité de l’entreprise">
        <div className="parameter-form">
          <label className="field">
            <span className="field-label">Nom</span>
            {field('identity.name', c.identity.name)}
          </label>
          <label className="field">
            <span className="field-label">Slogan</span>
            {field('identity.tagline', c.identity.tagline)}
          </label>
        </div>
      </Card>

      <LogoField
        value={logo}
        descriptor={logoDescripteur}
        previewUrl={logoApercu}
        published={logoPublie}
        onChange={(path, descriptor, previewUrl) => setDraft({
          ...draft,
          'branding.logoUrl': path,
          'branding.logo': descriptor,
          'branding.logoPreview': previewUrl ?? path,
        })}
      />

      {/*
        FAVICON — importé, comme le logo.
        Il se saisissait en collant une adresse, dans « Configuration
        technique » : une image hors de tout pipeline, sans empreinte, sans
        environnement, sans état de publication, invalide le jour d'un
        changement de domaine. Deux médias, un seul chemin.

        Le « logo sombre » a été retiré : aucun écran, aucun e-mail, aucun
        document ne basculait sur fond sombre — le champ demandait un travail
        d'import pour une image que personne n'affichait.
      */}
      <LogoField
        {...mediaMarque('favicon', 'branding.faviconUrl')}
        title="Favicon"
        description="Icône d’onglet de votre Panel, et transmise aux projets. Carrée, redimensionnée automatiquement."
        role="favicon"
        label="le favicon"
      />

      {/* 2 — RÉFÉRENCES : tous les contacts publics passent par ici. */}
      <ReferencesEditor
        value={references}
        onChange={(refs) => setDraft({ ...draft, references: refs })}
      />

      {/* 3 — SIGNATAIRE : la personne qui engage l'entreprise. */}
      <SignerSection
        value={signataire}
        onChange={(signer) => setDraft({ ...draft, signer })}
      />

      {/* 4 — ÉQUIPE : les personnes affichées sur la page Support des projets. */}
      <TeamEditor
        value={equipe}
        previews={apercusMedias}
        onChange={(team) => setDraft({ ...draft, team })}
      />

      {/*
        5 — CONFIGURATION TECHNIQUE.
        Ces champs ne décrivent pas l'entreprise : ils font fonctionner le
        déploiement. Les mêler à l'identité publique conduisait à prendre
        l'e-mail d'émission des certificats pour un contact client.
      */}
      <Disclosure title="Configuration technique">
        <p className="muted">
          Ces réglages ne sont affichés nulle part : ils sont lus par le moteur
          de déploiement.
        </p>
        <div className="parameter-form">
          <label className="field">
            <span className="field-label">Site de l’entreprise</span>
            {field('domains.websiteUrl', c.domains.websiteUrl)}
            <span className="field-hint">
              Affiché dans le pied de page des sites que vous opérez : « Réalisé par {c.identity.name} ».
              {siteWeb ? ' Le nom sera cliquable.' : ' Sans adresse, le nom reste affiché sans lien.'}
            </span>
          </label>
          <label className="field">
            <span className="field-label">E-mail d’émission des certificats</span>
            {field('contacts.supportEmail', c.contacts.supportEmail)}
            <span className="field-hint">
              Transmis à Let’s Encrypt lors d’un déploiement, pour les alertes
              d’expiration. Ce n’est PAS un contact client — ceux-ci sont des
              références.
            </span>
          </label>
        </div>
      </Disclosure>

      {/* UN SEUL BOUTON — il crée la première fois, il enregistre ensuite, et
          dans les deux cas il diffuse. */}
      <div className="action-buttons">
        <button
          type="button"
          className="btn"
          disabled={busy || (existe ? !modifie : !nomSaisi)}
          onClick={enregistrer}
        >
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {existe && modifie ? (
          <button type="button" className="btn btn-small" onClick={() => setDraft({})}>
            Annuler les modifications
          </button>
        ) : null}
        {!existe ? (
          <button type="button" className="btn btn-small" onClick={() => { setCreating(false); setDraft({}); }}>
            Annuler
          </button>
        ) : null}
      </div>

      {/* HISTORIQUE — le versionnement reste entier, sans rien exiger de
          l'utilisateur au moment d'enregistrer. */}
      <Disclosure title={`Historique des versions (${versions.length})`}>
        {versions.length === 0 ? (
          <p className="muted">Aucune version diffusée.</p>
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
                      return `Version ${v.version} restaurée — diffusée comme version ${result.version}.`;
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
          Restaurer ne réécrit pas l’histoire : une version neuve est diffusée
          avec l’ancien contenu, et le retour en arrière est lui-même tracé.
        </p>
      </Disclosure>

      <p><Link to="/integrated-apis">API intégrées de l’entreprise →</Link></p>
    </div>
  );
}
