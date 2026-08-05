import { useRef, useState } from 'react';
import { Card } from '@/components/ui';
import { errorMessage, uploadImage } from '@/lib/api';
import { EMPTY_SIGNER, getSignerGaps, isSignerEmpty, isValidEmail } from '@/lib/signer';
import type { CompanyReference, CompanySigner } from '@/types.company';

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
  const refs = value ?? [];

  const set = (i: number, patch: Partial<CompanyReference>) =>
    onChange(refs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const ajouter = () =>
    onChange([...refs, { type: 'TEXT', icon: 'bi-star', name: '', value: '', order: refs.length }]);
  const retirer = (i: number) =>
    // L'ordre est renuméroté : un trou ferait remonter une référence sans
    // qu'on l'ait demandé au prochain enregistrement.
    onChange(refs.filter((_, idx) => idx !== i).map((r, idx) => ({ ...r, order: idx })));

  return (
    <Card title={`Références (${refs.length})`}>
      <div className="company-block-head">
        <p className="muted">Liens et informations affichés par les projets.</p>
        <button type="button" className="btn btn-small" onClick={ajouter}>Ajouter</button>
      </div>

      {refs.length === 0 ? (
        <p className="muted company-empty">
          Aucune référence. Ajoutez des liens ou des informations (icônes Bootstrap Icons).
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
                <input
                  type="text"
                  className="company-ref-icon"
                  placeholder="Icône (bi-star)"
                  value={r.icon ?? ''}
                  onChange={(e) => set(i, { icon: e.target.value })}
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
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Logo                                                                      */
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
  onChange,
}: {
  value: string | null;
  onChange: (url: string) => void;
}) {
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const url = (value || '').trim();

  const importer = async (file: File | undefined) => {
    if (!file) return;
    setEnvoi(true);
    setErreur(null);
    try {
      const { url: chemin } = await uploadImage(file, 'logo');
      onChange(chemin);
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
    <Card title="Logo">
      <p className="muted">Affiché par les projets. Format libre, redimensionné automatiquement.</p>

      <div
        className={`company-logo-drop${envoi ? ' is-busy' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Importer une image"
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
        {url ? (
          <>
            <img src={url} alt="" />
            <button
              type="button"
              className="company-logo-remove"
              aria-label="Supprimer l’image"
              onClick={(e) => { e.stopPropagation(); onChange(''); }}
            >
              ×
            </button>
          </>
        ) : (
          <span className="muted">
            {envoi ? 'Envoi…' : 'Cliquez ou déposez une image'}
          </span>
        )}
        {envoi && url ? <span className="company-logo-veil">Envoi…</span> : null}
      </div>

      {erreur ? <p className="field-error">{erreur}</p> : null}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void importer(e.target.files?.[0])}
      />
    </Card>
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
