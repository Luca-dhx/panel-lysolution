/**
 * IDENTIFIANTS D'UNE ENTREPRISE CLIENTE — le carnet d'accès de l'agence.
 *
 * Un identifiant est nommé (« Stripe », « OVH », « Boîte Gmail ») et porte
 * autant de champs `nom → valeur` qu'il en faut (« mail », « mot de passe »,
 * « clé API »…). C'est un outil d'organisation : rien dans le Panel ne s'en
 * sert pour appeler un fournisseur.
 *
 * ══ CE QUI EST MASQUÉ, ET POURQUOI PAS TOUT ═════════════════════════════════
 *
 * Masquer toutes les valeurs obligerait à cliquer pour lire une simple adresse
 * e-mail. Seuls les champs dont le NOM évoque un secret (mot de passe, clé,
 * token, code…) sont masqués par défaut ; tout se révèle d'un clic, et tout se
 * copie sans se révéler.
 *
 * Les valeurs sont chiffrées au repos côté serveur, et cet écran — lecture
 * comprise — est réservé aux comptes DEV.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Card, EmptyState } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { PageHeader } from '@/components/ui-kit';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/ToastProvider';
import { useIsDev } from '@/auth/RequireDev';
import { clientCompanies, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { ClientCredential } from '@/types.clientCompany';

const SECRET = /(mot\s*de\s*passe|password|passwd|mdp|secret|cl[ée]|key|token|pin|code|cvc|iban)/i;

type LigneBrouillon = { fieldId?: string; name: string; value: string; cle: string };
type Brouillon = { credentialId: string | null; name: string; fields: LigneBrouillon[] };

let compteur = 0;
const nouvelleCle = () => `l${Date.now()}-${compteur++}`;

function brouillonDepuis(c: ClientCredential | null): Brouillon {
  if (!c) {
    return {
      credentialId: null,
      name: '',
      fields: [
        { name: 'mail', value: '', cle: nouvelleCle() },
        { name: 'mot de passe', value: '', cle: nouvelleCle() },
      ],
    };
  }
  return {
    credentialId: c.credentialId,
    name: c.name,
    fields: c.fields.length > 0
      ? c.fields.map((f) => ({ fieldId: f.fieldId, name: f.name, value: f.value, cle: f.fieldId }))
      : [{ name: '', value: '', cle: nouvelleCle() }],
  };
}

/** Une valeur en lecture : masquée si secrète, révélable, copiable. */
function Valeur({ nom, valeur, illisible }: { nom: string; valeur: string; illisible?: boolean }) {
  const toast = useToast();
  const secret = SECRET.test(nom);
  const [visible, setVisible] = useState(!secret);

  if (illisible) {
    return <span className="cc-field-value cred-unreadable">Valeur illisible (clé de chiffrement changée ?)</span>;
  }

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(valeur);
      toast.success(`« ${nom} » copié.`);
    } catch {
      toast.error('La copie a été refusée par le navigateur.');
    }
  };

  return (
    <span className="cc-field-value cred-value">
      <span className={visible ? 'cred-text' : 'cred-text cred-masked'}>
        {valeur ? (visible ? valeur : '••••••••••') : <span className="muted">—</span>}
      </span>
      {valeur ? (
        <span className="cred-value-actions">
          {secret ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setVisible(!visible)}
              aria-label={visible ? `Masquer ${nom}` : `Afficher ${nom}`}
            >
              <Icon name="eye" size={12} />
              {visible ? 'Masquer' : 'Afficher'}
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={copier} aria-label={`Copier ${nom}`}>
            Copier
          </button>
        </span>
      ) : null}
    </span>
  );
}

/** L'éditeur d'un identifiant — nom, puis les lignes `champ → valeur`. */
function Editeur({
  brouillon,
  onChange,
  onAnnuler,
  onEnregistrer,
  enCours,
}: {
  brouillon: Brouillon;
  onChange: (b: Brouillon) => void;
  onAnnuler: () => void;
  onEnregistrer: () => void;
  enCours: boolean;
}) {
  const setLigne = (cle: string, patch: Partial<LigneBrouillon>) => onChange({
    ...brouillon,
    fields: brouillon.fields.map((f) => (f.cle === cle ? { ...f, ...patch } : f)),
  });

  return (
    <Card className="cc-section cred-card cred-editing">
      <form
        className="cred-form"
        onSubmit={(e) => { e.preventDefault(); onEnregistrer(); }}
      >
        <label className="cc-field cc-field-editing">
          <span className="cc-field-label">Nom de l’identifiant</span>
          <input
            className="input cc-field-input"
            value={brouillon.name}
            onChange={(e) => onChange({ ...brouillon, name: e.target.value })}
            placeholder="Stripe, OVH, Google Workspace…"
            autoFocus
          />
        </label>

        <div className="cred-lines">
          <div className="cred-line cred-line-head" aria-hidden="true">
            <span>Champ</span>
            <span>Valeur</span>
            <span />
          </div>
          {brouillon.fields.map((f) => (
            <div key={f.cle} className="cred-line">
              <input
                className="input"
                value={f.name}
                onChange={(e) => setLigne(f.cle, { name: e.target.value })}
                placeholder="mail"
                aria-label="Nom du champ"
              />
              <input
                className="input"
                value={f.value}
                onChange={(e) => setLigne(f.cle, { value: e.target.value })}
                placeholder="valeur"
                aria-label={`Valeur de ${f.name || 'ce champ'}`}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onChange({ ...brouillon, fields: brouillon.fields.filter((x) => x.cle !== f.cle) })}
                aria-label={`Retirer le champ ${f.name}`}
              >
                <Icon name="x-lg" size={12} />
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onChange({
                ...brouillon,
                fields: [...brouillon.fields, { name: '', value: '', cle: nouvelleCle() }],
              })}
            >
              <Icon name="plus-lg" size={12} />
              Ajouter un champ
            </button>
          </div>
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onAnnuler} disabled={enCours}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={enCours || !brouillon.name.trim()}>
            <Icon name="check2" size={13} />
            {enCours ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function ClientCredentialsPage() {
  const { clientCompanyId = '' } = useParams();
  const isDev = useIsDev();
  const toast = useToast();

  const [nomClient, setNomClient] = useState<string>('');
  const [liste, setListe] = useState<ClientCredential[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [brouillon, setBrouillon] = useState<Brouillon | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [aSupprimer, setASupprimer] = useState<ClientCredential | null>(null);
  const [filtre, setFiltre] = useState('');

  const charger = async () => {
    try {
      const r = await clientCompanies.listCredentials(clientCompanyId);
      setNomClient(r.legalName);
      setListe(r.credentials);
      setErreur(null);
    } catch (err) {
      setErreur(errorMessage(err, 'Les identifiants n’ont pas pu être chargés.'));
    } finally {
      setChargement(false);
    }
  };

  useEffect(() => {
    if (isDev) void charger();
    else setChargement(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientCompanyId, isDev]);

  const retour = { to: `/clients/${clientCompanyId}`, label: nomClient || 'Fiche client' };

  if (!isDev) {
    return (
      <div className="page">
        <PageHeader backTo={retour} title="Identifiants" />
        <EmptyState title="Réservé aux comptes développeur" hint="Ces identifiants sont des secrets." />
      </div>
    );
  }
  if (chargement) return <p className="muted">Chargement des identifiants…</p>;
  if (erreur) {
    return (
      <div className="page">
        <PageHeader backTo={retour} title="Identifiants" />
        <EmptyState title="Identifiants indisponibles" hint={erreur} />
      </div>
    );
  }

  const enregistrer = async () => {
    if (!brouillon) return;
    setEnCours(true);
    const corps = {
      name: brouillon.name,
      fields: brouillon.fields.map(({ fieldId, name, value }) => ({ fieldId, name, value })),
    };
    try {
      if (brouillon.credentialId) {
        const { credential } = await clientCompanies.updateCredential(clientCompanyId, brouillon.credentialId, corps);
        setListe((l) => l.map((c) => (c.credentialId === credential.credentialId ? credential : c)));
        toast.success(`« ${credential.name} » mis à jour.`);
      } else {
        const { credential } = await clientCompanies.createCredential(clientCompanyId, corps);
        setListe((l) => [...l, credential].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
        toast.success(`« ${credential.name} » ajouté.`);
      }
      setBrouillon(null);
    } catch (err) {
      toast.error(errorMessage(err, 'L’identifiant n’a pas pu être enregistré.'));
    } finally {
      setEnCours(false);
    }
  };

  const supprimer = async () => {
    if (!aSupprimer) return;
    try {
      await clientCompanies.deleteCredential(clientCompanyId, aSupprimer.credentialId);
      setListe((l) => l.filter((c) => c.credentialId !== aSupprimer.credentialId));
      toast.success(`« ${aSupprimer.name} » supprimé.`);
      setASupprimer(null);
    } catch (err) {
      toast.error(errorMessage(err, 'L’identifiant n’a pas pu être supprimé.'));
    }
  };

  const terme = filtre.trim().toLowerCase();
  const visibles = terme
    ? liste.filter((c) => c.name.toLowerCase().includes(terme)
      || c.fields.some((f) => f.name.toLowerCase().includes(terme)))
    : liste;

  return (
    <div className="page cc-detail">
      <PageHeader
        backTo={retour}
        title="Identifiants"
        avatar={(
          <span className="flex size-12 items-center justify-center rounded-lg bg-secondary text-fg-quaternary">
            <Icon name="shield-check" size={24} aria-hidden="true" />
          </span>
        )}
        description={`${nomClient} · ${liste.length} identifiant${liste.length > 1 ? 's' : ''} · valeurs chiffrées, visibles des seuls comptes DEV`}
        actions={!brouillon || brouillon.credentialId ? (
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => setBrouillon(brouillonDepuis(null))}
          >
            <Icon name="plus-lg" size={13} />
            Nouvel identifiant
          </button>
        ) : null}
      />

      {liste.length > 3 ? (
        <input
          className="input cred-search"
          type="search"
          value={filtre}
          onChange={(e) => setFiltre(e.target.value)}
          placeholder="Rechercher un identifiant ou un champ…"
          aria-label="Rechercher un identifiant"
        />
      ) : null}

      {brouillon && !brouillon.credentialId ? (
        <Editeur
          brouillon={brouillon}
          onChange={setBrouillon}
          onAnnuler={() => setBrouillon(null)}
          onEnregistrer={enregistrer}
          enCours={enCours}
        />
      ) : null}

      {liste.length === 0 && !brouillon ? (
        <EmptyState
          title="Aucun identifiant pour ce client"
          hint="Ajoutez-en un (ex. « Stripe ») et rangez-y ses champs : mail, mot de passe, clé API…"
        />
      ) : null}

      {visibles.map((c) => (brouillon?.credentialId === c.credentialId ? (
        <Editeur
          key={c.credentialId}
          brouillon={brouillon}
          onChange={setBrouillon}
          onAnnuler={() => setBrouillon(null)}
          onEnregistrer={enregistrer}
          enCours={enCours}
        />
      ) : (
        <Card key={c.credentialId} className="cc-section cred-card">
          <div className="cc-section-head">
            <span className="cc-section-icon" aria-hidden="true"><Icon name="shield-check" size={16} /></span>
            <h2 className="cc-section-title">{c.name}</h2>
            <div className="cc-section-action">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setBrouillon(brouillonDepuis(c))}
                disabled={Boolean(brouillon)}
              >
                <Icon name="pencil" size={12} />
                Modifier
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setASupprimer(c)}
                aria-label={`Supprimer ${c.name}`}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          </div>
          <div className="cc-section-body">
            {c.fields.length === 0 ? (
              <p className="muted">Aucun champ.</p>
            ) : c.fields.map((f) => (
              <div key={f.fieldId} className="cc-field">
                <span className="cc-field-label">{f.name}</span>
                <Valeur nom={f.name} valeur={f.value} illisible={f.unreadable} />
              </div>
            ))}
            <p className="cc-note">
              Modifié le {formatDateTime(c.updatedAt)}{c.updatedBy ? ` par ${c.updatedBy}` : ''}
            </p>
          </div>
        </Card>
      )))}

      {terme && visibles.length === 0 ? <p className="muted">Aucun identifiant ne correspond.</p> : null}

      {aSupprimer ? (
        <Modal title={`Supprimer « ${aSupprimer.name} » ?`} danger onClose={() => setASupprimer(null)}>
          <p>
            Ses {aSupprimer.fields.length} champ{aSupprimer.fields.length > 1 ? 's' : ''} seront effacés
            définitivement. Il n’existe aucune autre copie dans le Panel.
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setASupprimer(null)}>Annuler</button>
            <button type="button" className="btn btn-danger" onClick={supprimer}>Supprimer</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export default ClientCredentialsPage;
