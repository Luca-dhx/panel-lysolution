/**
 * LA FICHE DE PROSPECT — création et correction, un seul formulaire.
 *
 * ── POURQUOI PAS DEUX ÉCRANS ────────────────────────────────────────────────
 * Créer et corriger demandent exactement les mêmes champs, les mêmes règles et
 * les mêmes messages. Deux écrans, c'est deux validations qui divergent — et
 * c'est toujours celle de la correction qu'on oublie de mettre à jour.
 *
 * ── LE STATUT N'EST PAS ICI, ET C'EST DÉLIBÉRÉ ──────────────────────────────
 * Il se change depuis la pastille du tableau ou de la fiche, parce que c'est un
 * geste isolé qu'on répète : reclasser cinq affaires ne doit pas demander
 * d'ouvrir, modifier et enregistrer cinq formulaires. La seule exception est la
 * CRÉATION, où il faut bien un état de départ.
 *
 * ── LES IMAGES SONT IMPORTÉES AVANT L'ENREGISTREMENT ────────────────────────
 * Le fichier part dès qu'il est choisi ; la fiche ne conserve ensuite qu'un
 * chemin. Attendre la validation du formulaire aurait obligé à garder les
 * fichiers en mémoire, à les renvoyer à chaque tentative, et à perdre l'import
 * si la validation échoue sur un autre champ.
 *
 * Conséquence assumée : une image importée puis abandonnée reste sur le disque.
 * C'est le prix d'un aperçu immédiat, et le même arbitrage que la fiche
 * d'entreprise — un média orphelin ne casse rien, une saisie perdue si.
 */
import { useRef, useState } from 'react';
import { Card } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { ThemedSelect } from '@/components/ThemedSelect';
import { api, errorMessage, uploadImage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import {
  PROSPECT_STATUS_DEFS,
  PROSPECT_STATUS_ORDER,
} from '@/components/prospection/prospectStatus';
import type {
  Prospect, ProspectImage, ProspectLink, ProspectStatus,
} from '@/types.prospection';

function nouvelId(): string {
  const natif = globalThis.crypto?.randomUUID?.();
  return natif ?? `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Ce qui part réellement au serveur : les lignes vides disparaissent.
 *
 * Un lien ouvert puis abandonné n'est jamais envoyé. Le serveur applique la
 * même règle de son côté — une garantie de formulaire ne protège que les gens
 * qui passent par le formulaire.
 */
function liensPrets(liens: ProspectLink[]): ProspectLink[] {
  return liens
    .map((l) => ({ id: l.id, label: l.label.trim(), url: l.url.trim() }))
    .filter((l) => l.url);
}

export function ProspectForm({
  prospect,
  onSaved,
  onCancel,
}: {
  /** Présent = CORRECTION ; absent = création. */
  prospect?: Prospect;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const champFichier = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(prospect?.name ?? '');
  const [email, setEmail] = useState(prospect?.email ?? '');
  const [phone, setPhone] = useState(prospect?.phone ?? '');
  const [notes, setNotes] = useState(prospect?.notes ?? '');
  const [status, setStatus] = useState<ProspectStatus>(prospect?.status ?? 'WAITING');
  const [links, setLinks] = useState<ProspectLink[]>(prospect?.links ?? []);
  const [images, setImages] = useState<ProspectImage[]>(prospect?.images ?? []);

  const [importEnCours, setImportEnCours] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const pret = name.trim().length > 0;

  const ajouterLien = () =>
    setLinks((actuels) => [...actuels, { id: nouvelId(), label: '', url: '' }]);

  const modifierLien = (id: string, champ: 'label' | 'url', valeur: string) =>
    setLinks((actuels) => actuels.map((l) => (l.id === id ? { ...l, [champ]: valeur } : l)));

  const retirerLien = (id: string) =>
    setLinks((actuels) => actuels.filter((l) => l.id !== id));

  /**
   * IMPORT — plusieurs fichiers d'un coup, en SÉRIE.
   *
   * En parallèle, cinq photos de téléphone partiraient ensemble : le serveur
   * les décode toutes en même temps (sharp travaille en mémoire) et le poste
   * le plus modeste se met à ramer. Une par une reste imperceptible à l'usage.
   */
  const importer = async (fichiers: FileList | null) => {
    if (!fichiers || fichiers.length === 0) return;
    setErreur(null);
    setImportEnCours(true);
    try {
      for (const fichier of Array.from(fichiers)) {
        // eslint-disable-next-line no-await-in-loop
        const rendu = await uploadImage(fichier, 'prospect', 'prospect', '/api/prospects/images');
        setImages((actuelles) => [
          ...actuelles,
          {
            id: nouvelId(),
            url: rendu.url,
            filename: rendu.filename ?? null,
            caption: '',
          },
        ]);
      }
    } catch (err) {
      setErreur(errorMessage(err, 'Cette image n’a pas pu être importée.'));
    } finally {
      setImportEnCours(false);
      // Le champ est vidé : sans cela, réimporter LE MÊME fichier ne déclenche
      // aucun `change`, et l'écran paraît ignorer le clic.
      if (champFichier.current) champFichier.current.value = '';
    }
  };

  const enregistrer = async () => {
    setErreur(null);
    setEnCours(true);
    const corps = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      notes,
      links: liensPrets(links),
      images,
      ...(prospect ? {} : { status }),
    };
    try {
      if (prospect) await api.updateProspect(prospect._id, corps);
      else await api.createProspect(corps);
      toast.success(prospect ? 'Prospect mis à jour.' : 'Prospect ajouté.');
      onSaved();
    } catch (err) {
      setErreur(errorMessage(err, 'La fiche n’a pas pu être enregistrée.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Card title={prospect ? 'Modifier le prospect' : 'Nouveau prospect'}>
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      <div className="event-form">
        <label className="field">
          <span className="field-label">Nom</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Boulangerie Martin"
          />
        </label>
        <label className="field">
          <span className="field-label">
            Adresse e-mail <span className="muted">(facultatif)</span>
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="contact@exemple.fr"
          />
        </label>
        <label className="field">
          <span className="field-label">
            Téléphone <span className="muted">(facultatif)</span>
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="06 12 34 56 78"
          />
        </label>
        {/*
          Le statut de DÉPART, à la création seulement. Sur une fiche existante,
          il se change depuis sa pastille — voir l'en-tête de ce fichier.
        */}
        {prospect ? null : (
          <div className="field">
            <span className="field-label">Statut de départ</span>
            <ThemedSelect
              ariaLabel="Statut de départ"
              value={status}
              onChange={(v) => setStatus(v as ProspectStatus)}
              options={PROSPECT_STATUS_ORDER.map((s) => ({
                value: s,
                label: PROSPECT_STATUS_DEFS[s].label,
              }))}
            />
          </div>
        )}
      </div>

      <label className="field">
        <span className="field-label">
          Notes internes <span className="muted">(elles ne sortent jamais du Panel)</span>
        </span>
        <textarea
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Ce qu’on sait de l’affaire, ce qui a été dit, ce qu’il reste à faire."
        />
      </label>

      {/* ── LIENS ─────────────────────────────────────────────────────────── */}
      <div className="field">
        <div className="field-head">
          <span className="field-label">Liens</span>
          <button type="button" className="btn btn-secondary btn-small" onClick={ajouterLien}>
            Ajouter un lien
          </button>
        </div>
        {links.length === 0 ? (
          <p className="muted">
            Aucun lien. Le site, la fiche Google, un réseau social, un document partagé.
          </p>
        ) : (
          <ul className="prospect-links">
            {links.map((lien) => (
              <li key={lien.id} className="prospect-link">
                <label className="field">
                  <span className="field-label">Intitulé</span>
                  <input
                    type="text"
                    value={lien.label}
                    onChange={(e) => modifierLien(lien.id, 'label', e.target.value)}
                    placeholder="Site officiel"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Adresse</span>
                  <input
                    type="text"
                    value={lien.url}
                    onChange={(e) => modifierLien(lien.id, 'url', e.target.value)}
                    placeholder="exemple.fr"
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  aria-label={`Retirer le lien ${lien.label || lien.url || 'vide'}`}
                  onClick={() => retirerLien(lien.id)}
                >
                  Retirer
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── IMAGES ────────────────────────────────────────────────────────── */}
      <div className="field">
        <div className="field-head">
          <span className="field-label">Images</span>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={importEnCours}
            onClick={() => champFichier.current?.click()}
          >
            {importEnCours ? 'Import…' : 'Ajouter des images'}
          </button>
        </div>
        <input
          ref={champFichier}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => void importer(e.target.files)}
        />
        {images.length === 0 ? (
          <p className="muted">
            Aucune image. Une devanture, une capture d’écran, une carte de visite.
          </p>
        ) : (
          <ul className="prospect-images">
            {images.map((image) => (
              <li key={image.id} className="prospect-image">
                <img src={image.url} alt={image.caption || 'Image du prospect'} />
                <input
                  type="text"
                  value={image.caption}
                  placeholder="Légende (facultatif)"
                  onChange={(e) =>
                    setImages((actuelles) =>
                      actuelles.map((i) =>
                        i.id === image.id ? { ...i, caption: e.target.value } : i,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="prospect-image-remove"
                  aria-label="Retirer cette image"
                  onClick={() =>
                    setImages((actuelles) => actuelles.filter((i) => i.id !== image.id))
                  }
                >
                  <Icon name="x-lg" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="contract-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={!pret || enCours}
          onClick={() => void enregistrer()}
        >
          {enCours ? 'Enregistrement…' : prospect ? 'Enregistrer' : 'Ajouter le prospect'}
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </Card>
  );
}
