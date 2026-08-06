import { useRef, useState } from 'react';
import { IconPicker } from './IconPicker';
import { ICONE_PAR_DEFAUT } from './referenceIcons';
import { Card } from '@/components/ui';
import { errorMessage, uploadImage } from '@/lib/api';
import { EMPTY_SIGNER, getSignerGaps, isSignerEmpty, isValidEmail } from '@/lib/signer';
import type {
  CompanyReference, CompanySigner, CompanyTeamMember, StoredMediaDescriptor,
} from '@/types.company';

/**
 * IDENTITÉ DÉVELOPPEUR — les blocs repris du Manager, adaptés au Panel.
 *
 * ── POURQUOI CE FICHIER EXISTE ──────────────────────────────────────────────
 * Le Panel est devenu l'autorité de cette identité, mais sa fiche d'entreprise
 * n'offrait que des champs texte bruts : pas d'éditeur de références, pas
 * d'import de logo, aucune validation du signataire. On y saisissait donc à
 * l'aveugle ce que le Manager, lui, présentait proprement. Ces trois blocs
 * portent exactement la même finition — y compris l'import de fichier, pour
 * lequel le Panel a reçu son propre stockage.
 *
 * Ils écrivent tous dans le BROUILLON de la page : saisir ne publie rien, et
 * cette distinction reste celle qui structure tout l'écran.
 */

/* -------------------------------------------------------------------------- */
/*  Signataire                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Le signataire est une donnée MÉTIER : la personne physique qui engage
 * l'entreprise. Jamais déduite d'un compte utilisateur — un compte sert à se
 * connecter, pas à signer.
 *
 * Les erreurs n'apparaissent qu'après interaction : ouvrir la page sur un
 * formulaire vide déjà tout en rouge serait un reproche, pas une aide.
 */
export function SignerSection({
  value,
  onChange,
}: {
  value: CompanySigner | null;
  onChange: (signer: CompanySigner | null) => void;
}) {
  const [touched, setTouched] = useState<Partial<Record<keyof CompanySigner, boolean>>>({});

  const signer: CompanySigner = value ?? EMPTY_SIGNER;
  const gaps = getSignerGaps(signer);
  const empty = isSignerEmpty(signer);
  const complete = gaps.length === 0;

  const set = (patch: Partial<CompanySigner>) => {
    const next = { ...signer, ...patch };
    // Repasser à `null` quand tout est effacé : « non configuré » reste un
    // état atteignable depuis l'écran, sans bouton dédié.
    onChange(isSignerEmpty(next) ? null : next);
  };

  const touch = (field: keyof CompanySigner) => setTouched((t) => ({ ...t, [field]: true }));
  const erreur = (field: keyof CompanySigner, message: string) =>
    touched[field] && gaps.includes(field) ? message : null;

  const badge = empty
    ? <span className="badge badge-muted">À configurer</span>
    : complete
      ? <span className="badge badge-ok">Complet</span>
      : <span className="badge badge-warn">Incomplet</span>;

  return (
    <Card title="Signataire des contrats">
      <div className="company-block-head">
        <p className="muted">
          Personne qui signe les contrats au nom de l’entreprise, chez chaque projet.
        </p>
        {badge}
      </div>

      <div className="parameter-form company-grid-2">
        <Champ label="Prénom" erreur={erreur('firstName', 'Prénom requis')}>
          <input
            type="text"
            value={signer.firstName ?? ''}
            placeholder="Jean"
            onChange={(e) => set({ firstName: e.target.value })}
            onBlur={() => touch('firstName')}
          />
        </Champ>
        <Champ label="Nom" erreur={erreur('lastName', 'Nom requis')}>
          <input
            type="text"
            value={signer.lastName ?? ''}
            placeholder="Dupont"
            onChange={(e) => set({ lastName: e.target.value })}
            onBlur={() => touch('lastName')}
          />
        </Champ>
        <Champ label="Fonction" hint="Facultatif — mention portée au contrat.">
          <input
            type="text"
            value={signer.jobTitle ?? ''}
            placeholder="Gérant"
            onChange={(e) => set({ jobTitle: e.target.value })}
          />
        </Champ>
        <Champ
          label="E-mail"
          hint="Adresse qui recevra la demande de signature."
          erreur={erreur(
            'email',
            (signer.email || '').trim() && !isValidEmail(signer.email || '')
              ? 'E-mail invalide'
              : 'E-mail requis',
          )}
        >
          <input
            type="email"
            value={signer.email ?? ''}
            placeholder="jean.dupont@exemple.fr"
            onChange={(e) => set({ email: e.target.value })}
            onBlur={() => touch('email')}
          />
        </Champ>
      </div>

      <p className="field-hint muted">
        Son identité est figée dans chaque contrat au moment de la validation : la modifier
        ici n’affecte que les contrats créés ensuite. Sans signataire complet, un projet
        refusera de valider un contrat.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Références                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Liens et informations affichés par les projets.
 *
 * Le bloc était purement absent du Panel : les références ne pouvaient donc
 * plus être saisies nulle part une fois le Manager passé en lecture seule.
 */
export function ReferencesEditor({
  value,
  onChange,
}: {
  value: CompanyReference[];
  onChange: (references: CompanyReference[]) => void;
}) {
  return (
    <Card title={`Références (${(value ?? []).length})`}>
      <ReferenceRows
        value={value}
        onChange={onChange}
        description="Liens et informations affichés par les projets."
        vide="Aucune référence. Ajoutez les liens et informations que vos projets afficheront."
      />
    </Card>
  );
}

/**
 * LES LIGNES DE RÉFÉRENCES — sans carte autour.
 *
 * Extraites parce que DEUX porteurs en ont besoin : l'entreprise, et chaque
 * membre de l'équipe. Les recopier aurait garanti qu'un correctif appliqué à
 * l'une manque à l'autre — c'est précisément ce qui rend deux formulaires
 * jumeaux dangereux.
 */
export function ReferenceRows({
  value,
  onChange,
  titre,
  description,
  vide,
}: {
  value: CompanyReference[];
  onChange: (references: CompanyReference[]) => void;
  titre?: string;
  description?: string;
  vide?: string;
}) {
  const refs = value ?? [];

  const set = (i: number, patch: Partial<CompanyReference>) =>
    onChange(refs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const ajouter = () =>
    onChange([...refs, { type: 'TEXT', icon: ICONE_PAR_DEFAUT, name: '', value: '', order: refs.length }]);
  const retirer = (i: number) =>
    // L'ordre est renuméroté : un trou ferait remonter une référence sans
    // qu'on l'ait demandé au prochain enregistrement.
    onChange(refs.filter((_, idx) => idx !== i).map((r, idx) => ({ ...r, order: idx })));

  return (
    <>
      <div className="company-block-head">
        <p className="muted">{titre ?? description}</p>
        <button type="button" className="btn btn-small" onClick={ajouter}>Ajouter</button>
      </div>

      {refs.length === 0 ? (
        <p className="muted company-empty">
          {vide ?? 'Aucune référence.'}
        </p>
      ) : (
        <ul className="company-refs">
          {refs.map((r, i) => (
            <li key={i} className="company-ref">
              <div className="company-ref-line">
                {/* Basculer texte/lien d'un clic : deux champs distincts pour
                    la même intention seraient une occasion de se tromper. */}
                <button
                  type="button"
                  className="btn btn-small"
                  title="Basculer texte / lien"
                  onClick={() => set(i, { type: r.type === 'TEXT' ? 'LINK' : 'TEXT' })}
                >
                  {r.type === 'LINK' ? 'Lien' : 'Texte'}
                </button>
                {/* L'icône se CHOISIT : la saisir de mémoire donnait un carré
                    vide chez le client, sans le moindre signal ici. */}
                <IconPicker
                  value={r.icon ?? ICONE_PAR_DEFAUT}
                  onChange={(icon) => set(i, { icon })}
                />
                <input
                  type="text"
                  placeholder="Nom"
                  value={r.name ?? ''}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  onClick={() => retirer(i)}
                  aria-label={`Supprimer la référence ${r.name || i + 1}`}
                >
                  Supprimer
                </button>
              </div>
              <input
                type="text"
                placeholder={r.type === 'LINK' ? 'Adresse du lien' : 'Valeur'}
                value={r.value ?? ''}
                onChange={(e) => set(i, { value: e.target.value })}
              />
              {/* Un lien qui n'en est pas un ne sera pas cliquable côté projet :
                  autant le dire pendant la saisie. */}
              {r.type === 'LINK' && (r.value || '').trim() && !/^https?:\/\//i.test(r.value || '') ? (
                <p className="field-error">Adresse absolue attendue (http ou https) — sinon le lien ne sera pas affiché.</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Images                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * LOGO — import de fichier, comme dans le Manager.
 *
 * ── POURQUOI CE COMPOSANT A CHANGÉ ──────────────────────────────────────────
 * Le Panel n'ayant pas de stockage, le logo se saisissait en collant une URL :
 * une expérience dégradée née d'une limite technique, pas d'un choix. Le Panel
 * étant l'autorité de cette identité, c'est à lui de s'aligner — il héberge
 * désormais ses médias (`POST /api/uploads/image`).
 *
 * Le chemin rendu est relatif ; le Panel le rend absolu au moment de publier
 * aux projets, qui l'affichent depuis d'autres origines.
 */
export function LogoField({
  value,
  descriptor,
  previewUrl,
  published = false,
  onChange,
}: {
  value: string | null;
  descriptor?: StoredMediaDescriptor | null;
  previewUrl?: string | null;
  /** Servi par une destination active — relevé par le serveur, jamais deviné ici. */
  published?: boolean;
  onChange: (path: string, descriptor: StoredMediaDescriptor | null, previewUrl?: string) => void;
}) {
  return (
    <Card title="Logo">
      <p className="muted">Affiché par les projets. Format libre, redimensionné automatiquement.</p>
      <ImageField
        value={value}
        previewUrl={previewUrl}
        onChange={onChange}
        kind="logo"
        label="le logo"
      />
      {/*
        Un logo importé sur un Panel pas encore déployé est parfaitement
        valide : il est enregistrable, et l'aperçu fonctionne. Il n'est
        simplement pas encore publiable aux projets — le dire évite de le
        prendre pour une panne.
      */}
      {descriptor?.objectKey && !published ? (
        <p className="muted read-only-note">
          Ce média est enregistré dans cet environnement mais n’est pas encore
          publié : aucune destination ne le sert. Il le sera au premier
          déploiement, sans réimport.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * UNE IMAGE QU'ON DÉPOSE — logo d'entreprise ou portrait d'un membre.
 *
 * Le même geste dans les deux cas : cliquer ou déposer, jamais coller une
 * adresse. Deux composants jumeaux auraient divergé au premier correctif —
 * l'un aurait gardé le bug de la réimportation du même fichier, l'autre non.
 *
 * `kind` ne change que la FORME du cadre (carré pour un logo, rond pour un
 * portrait) et le dossier de destination côté serveur. Le reste est identique,
 * y compris la remise à zéro de l'input après un échec.
 */
export function ImageField({
  value,
  onChange,
  kind,
  label,
  previewUrl,
}: {
  /** Chemin de stockage conservé par la fiche — jamais une adresse publique. */
  value: string | null;
  /**
   * Rend le chemin de stockage, le DESCRIPTEUR (la source de vérité) et
   * l'adresse d'aperçu du moment. Le parent enregistre les deux premiers ; la
   * troisième ne sert qu'à l'affichage.
   */
  onChange: (path: string, descriptor: StoredMediaDescriptor | null, previewUrl?: string) => void;
  kind: 'logo' | 'avatar';
  label: string;
  /** Adresse d'affichage résolue par le parent, quand elle diffère du chemin. */
  previewUrl?: string | null;
}) {
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * L'adresse d'APERÇU, qui n'est pas l'identité.
   *
   * Elle vient de l'import quand il vient d'avoir lieu, du parent sinon. À
   * défaut, le chemin de stockage suffit : le Panel sert ses propres médias
   * sur `/uploads/…`, y compris sur un poste jamais déployé.
   */
  const [apercuImport, setApercuImport] = useState<string | null>(null);
  const url = (apercuImport ?? previewUrl ?? value ?? '').trim();

  /**
   * L'image a-t-elle échoué à se charger ?
   *
   * L'état est indexé sur l'URL COURANTE : une nouvelle adresse remet
   * l'ardoise à zéro. Sans cela, une image cassée resterait annoncée cassée
   * après un remplacement réussi — exactement le genre de résidu que ce lot
   * cherche à supprimer.
   */
  const [casseeUrl, setCasseeUrl] = useState<string | null>(null);
  const casse = Boolean(url) && casseeUrl === url;
  const setCasse = (valeur: boolean) => setCasseeUrl(valeur ? url : null);

  const importer = async (file: File | undefined) => {
    if (!file) return;
    setEnvoi(true);
    setErreur(null);
    try {
      // Le RÔLE métier accompagne le fichier : c'est lui que le descripteur
      // publié porte, et que les projets lisent pour savoir quoi afficher où.
      // Le préfixe, lui, ne fait que nommer le fichier.
      const importe = await uploadImage(
        file,
        kind === 'avatar' ? 'avatar' : 'logo',
        kind === 'avatar' ? 'team-photo' : 'logo',
      );

      /**
       * ── CE QUI ENTRE DANS LA FICHE EST LE DESCRIPTEUR, PAS UNE ADRESSE ──
       *
       * Une correction précédente y écrivait l'URL ABSOLUE, et refusait
       * l'import quand aucune n'était résolue. Conséquence : un Panel de
       * RECETTE non encore déployé n'a aucune adresse publique — on ne pouvait
       * donc plus y enregistrer de logo, c'est-à-dire plus le configurer avant
       * sa première mise en ligne. Le remède était pire que le mal.
       *
       * L'identité d'un média est sa CLÉ D'OBJET et son empreinte. L'adresse
       * en est dérivée à la lecture, contre la destination active du moment :
       * la fiche n'a donc jamais à être réécrite quand le Panel est déployé,
       * ni quand il change de domaine.
       *
       * `publicUrl` — absolue ou locale selon ce qui existe — ne sert qu'à
       * l'aperçu, et n'est jamais enregistrée.
       */
      setApercuImport(importe.publicUrl);
      onChange(importe.url, importe.descriptor, importe.publicUrl);
    } catch (err) {
      setErreur(errorMessage(err, "L'image n'a pas pu être importée."));
    } finally {
      setEnvoi(false);
      // Sans cela, réimporter le MÊME fichier après une erreur ne déclencherait
      // aucun évènement : la valeur de l'input n'aurait pas changé.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <>
      <div
        className={`company-image-drop is-${kind}${envoi ? ' is-busy' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`Importer ${label}`}
        aria-busy={envoi}
        onClick={() => { if (!envoi) inputRef.current?.click(); }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !envoi) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!envoi) void importer(e.dataTransfer.files?.[0]);
        }}
      >
        {url && !casse ? (
          <>
            {/*
              L'APERÇU SE MET À JOUR SEUL, sans paramètre anti-cache.

              L'adresse d'un média porte l'empreinte de son contenu : une image
              remplacée a forcément une AUTRE adresse, et React remonte donc une
              autre image. Ajouter un `?t=…` reviendrait à faire changer
              l'adresse alors que l'image n'a pas changé — un cache qui ne sert
              jamais, pour résoudre un problème qui n'existe plus.

              `key` sur l'URL garantit que l'élément est bien remplacé plutôt
              que réutilisé avec un `src` modifié — c'est ce qui efface aussi
              l'état d'erreur d'une image précédente.
            */}
            <img key={url} src={url} alt="" onError={() => setCasse(true)} />
            <button
              type="button"
              className="company-image-remove"
              aria-label={`Supprimer ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                // Retirer, c'est effacer LES DEUX : le chemin et le
                // descripteur. N'effacer que l'un laisserait la fiche décrire
                // un média qu'elle ne référence plus.
                setApercuImport(null);
                onChange('', null);
              }}
            >
              ×
            </button>
          </>
        ) : (
          <span className="muted">
            {envoi
              ? 'Envoi…'
              : (casse
                /* Un média retiré côté serveur répond 410 : on le DIT, plutôt
                   que de laisser une vignette cassée sans explication. */
                ? 'Image indisponible — elle a peut-être été supprimée. Cliquez pour en importer une autre.'
                : 'Cliquez ou déposez une image')}
          </span>
        )}
        {envoi && url ? <span className="company-image-veil">Envoi…</span> : null}
      </div>

      {erreur ? <p className="field-error">{erreur}</p> : null}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void importer(e.target.files?.[0])}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */

/** Un champ étiqueté, avec son aide et son erreur — jamais les deux à la fois. */
function Champ({
  label, hint, erreur, children,
}: {
  label: string;
  hint?: string;
  erreur?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {erreur ? (
        <span className="field-error">{erreur}</span>
      ) : hint ? (
        <span className="field-hint muted">{hint}</span>
      ) : null}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/*  Équipe                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * L'ÉQUIPE DE L'AGENCE — celle qu'un client voit sur sa page Support.
 *
 * ── POURQUOI ELLE VIT ICI DÉSORMAIS ────────────────────────────────────────
 * Chaque projet tenait sa propre liste, éditée sur place. Deux projets opérés
 * par la même agence pouvaient donc annoncer deux équipes différentes, et un
 * départ devait être répercuté autant de fois qu'il y avait de projets. Une
 * seule liste, publiée par le Panel, supprime les deux problèmes d'un coup.
 *
 * ── RETIRER N'EST PAS SUPPRIMER ────────────────────────────────────────────
 * Un membre inactif reste dans la fiche mais disparaît des pages Support. Un
 * départ n'est pas une faute de saisie : effacer la personne obligerait à tout
 * ressaisir si elle revient, et ferait perdre la trace de qui était là.
 */
export function TeamEditor({
  value,
  onChange,
  previews,
}: {
  value: CompanyTeamMember[];
  onChange: (team: CompanyTeamMember[]) => void;
  /**
   * Adresses d'affichage des portraits, résolues par le serveur et indexées
   * par position. Elles ne sont QUE des aperçus : le portrait enregistré est
   * le descripteur, jamais l'adresse.
   */
  previews?: Record<string, string | null>;
}) {
  const membres = value ?? [];

  const set = (i: number, patch: Partial<CompanyTeamMember>) =>
    onChange(membres.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));

  const ajouter = () =>
    onChange([...membres, {
      firstName: '', lastName: '', role: '', email: '', phone: '',
      photoUrl: null, active: true, references: [], order: membres.length,
    }]);

  // L'ordre est renuméroté après chaque retrait : un trou ferait remonter
  // quelqu'un sans qu'on l'ait demandé au prochain enregistrement.
  const retirer = (i: number) =>
    onChange(membres.filter((_, idx) => idx !== i).map((m, idx) => ({ ...m, order: idx })));

  /** Déplace un membre, et réécrit l'ordre de toute la liste. */
  const deplacer = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= membres.length) return;
    const copie = [...membres];
    [copie[i], copie[j]] = [copie[j], copie[i]];
    onChange(copie.map((m, idx) => ({ ...m, order: idx })));
  };

  const actifs = membres.filter((m) => m.active !== false).length;

  return (
    <Card title={`Équipe (${membres.length})`}>
      <div className="company-block-head">
        <p className="muted">
          Les personnes affichées sur la page Support de vos projets.
          {membres.length > actifs ? ` ${membres.length - actifs} retirée(s) de l’affichage.` : ''}
        </p>
        <button type="button" className="btn btn-small" onClick={ajouter}>Ajouter</button>
      </div>

      {membres.length === 0 ? (
        <p className="muted company-empty">
          Aucun membre. Vos projets afficheront une page Support sans interlocuteur.
        </p>
      ) : (
        <ul className="company-team">
          {membres.map((m, i) => (
            <li key={i} className={`company-member${m.active === false ? ' is-inactive' : ''}`}>
              <div className="company-member-head">
                <ImageField
                  value={m.photoUrl}
                  previewUrl={previews?.[`team.${i}.photo`] ?? null}
                  onChange={(photoUrl, photo) => set(i, {
                    photoUrl: photoUrl || null,
                    // Le descripteur suit toujours le chemin : les dissocier
                    // laisserait la fiche décrire un média qu'elle ne
                    // référence plus, ou l'inverse.
                    photo: photo ?? null,
                  })}
                  kind="avatar"
                  label={`Photo de ${m.firstName || 'ce membre'}`}
                />
                <div className="company-member-fields">
                  <div className="parameter-form">
                    <label className="field">
                      <span className="field-label">Prénom</span>
                      <input
                        type="text"
                        value={m.firstName ?? ''}
                        onChange={(e) => set(i, { firstName: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Nom</span>
                      <input
                        type="text"
                        value={m.lastName ?? ''}
                        onChange={(e) => set(i, { lastName: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Fonction</span>
                      <input
                        type="text"
                        value={m.role ?? ''}
                        onChange={(e) => set(i, { role: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">E-mail</span>
                      <input
                        type="email"
                        value={m.email ?? ''}
                        onChange={(e) => set(i, { email: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Téléphone</span>
                      <input
                        type="tel"
                        value={m.phone ?? ''}
                        onChange={(e) => set(i, { phone: e.target.value })}
                      />
                    </label>
                  </div>

                  {/* Un e-mail mal formé sera refusé à l'enregistrement : le
                      dire pendant la saisie évite un aller-retour. */}
                  {(m.email || '').trim() && !isValidEmail(m.email || '') ? (
                    <p className="field-error">Adresse e-mail invalide.</p>
                  ) : null}
                </div>
              </div>

              <ReferenceRows
                value={m.references ?? []}
                onChange={(references) => set(i, { references })}
                titre={`Contacts directs de ${m.firstName || 'ce membre'}`}
              />

              <div className="company-member-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => set(i, { active: m.active === false })}
                >
                  {m.active === false ? 'Réafficher' : 'Retirer de l’affichage'}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={i === 0}
                  aria-label={`Monter ${m.firstName || 'ce membre'}`}
                  onClick={() => deplacer(i, -1)}
                >
                  Monter
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={i === membres.length - 1}
                  aria-label={`Descendre ${m.firstName || 'ce membre'}`}
                  onClick={() => deplacer(i, 1)}
                >
                  Descendre
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  aria-label={`Supprimer ${m.firstName || 'ce membre'}`}
                  onClick={() => retirer(i)}
                >
                  Supprimer
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
