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
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { TextArea } from '@/components/base/textarea/textarea';
import { Icon } from '@/components/Icon';
import { ThemedSelect } from '@/components/ThemedSelect';
import { ProspectInfoFieldsEditor } from '@/components/prospection/ProspectInfoFields';
import type { FolderNode } from '@/components/prospection/FolderTree';
import { api, errorMessage, uploadImage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import {
  PROSPECT_STATUS_DEFS,
  PROSPECT_STATUS_ORDER,
  PROSPECT_TYPE_DEFS,
  PROSPECT_TYPE_ORDER,
  prospectType as replierType,
} from '@/components/prospection/prospectStatus';
import type { ProspectInfoField } from '@/types.prospection';
import type {
  Prospect, ProspectImage, ProspectLink, ProspectStatus, ProspectType,
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

/** Les dossiers, à plat et indentés — ce qu'un menu déroulant peut montrer. */
function aplatirDossiers(noeuds: FolderNode[], profondeur = 0): { id: string; label: string }[] {
  return noeuds.flatMap((n) => [
    { id: n.id, label: `${'— '.repeat(profondeur)}${n.name}` },
    ...aplatirDossiers(n.children, profondeur + 1),
  ]);
}

export function ProspectForm({
  prospect,
  onSaved,
  onCancel,
  dossiers = [],
  dossierParDefaut = null,
}: {
  /** Présent = CORRECTION ; absent = création. */
  prospect?: Prospect;
  onSaved: () => void;
  onCancel: () => void;
  /** L'arbre des dossiers de prospects — pour le menu de rangement. */
  dossiers?: FolderNode[];
  /** Le dossier sélectionné dans l'arbre : proposé à la CRÉATION seulement. */
  dossierParDefaut?: string | null;
}) {
  const toast = useToast();
  const champFichier = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(prospect?.name ?? '');
  const [email, setEmail] = useState(prospect?.email ?? '');
  const [phone, setPhone] = useState(prospect?.phone ?? '');
  const [notes, setNotes] = useState(prospect?.notes ?? '');
  const [status, setStatus] = useState<ProspectStatus>(prospect?.status ?? 'WAITING');
  /**
   * Le TYPE est proposé ici même en CORRECTION, contrairement au statut.
   *
   * Le statut a sa pastille, qu'on manipule à la volée depuis le tableau. Le
   * type aussi — mais on le découvre souvent en remplissant la fiche, au
   * moment où l'on note que le prospect a déjà un site. L'omettre du
   * formulaire aurait obligé à enregistrer, fermer, puis rouvrir un menu.
   */
  const [type, setType] = useState<ProspectType>(replierType(prospect?.type));
  const [links, setLinks] = useState<ProspectLink[]>(prospect?.links ?? []);
  const [images, setImages] = useState<ProspectImage[]>(prospect?.images ?? []);
  const [infoFields, setInfoFields] = useState<ProspectInfoField[]>(prospect?.infoFields ?? []);
  /* À la CRÉATION, le dossier sélectionné dans l'arbre est proposé : on vient
     d'y cliquer, c'est là qu'on veut ranger. Sur une fiche existante, c'est le
     sien qui fait foi — sans quoi ouvrir « Modifier » depuis un autre dossier
     le déplacerait sans qu'on l'ait demandé. */
  const [folderId, setFolderId] = useState<string | null>(
    prospect ? (prospect.folderId ?? null) : dossierParDefaut,
  );

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
      /* Une information SANS NOM n'a aucun sens pour celui qui relit la fiche :
         elle est écartée ici plutôt que refusée, parce qu'une ligne ajoutée
         puis laissée vide est un geste abandonné, pas une erreur. */
      folderId,
      infoFields: infoFields.filter((f) => f.label.trim()),
      type,
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
        <Input
          label="Nom"
          isRequired
          value={name}
          onChange={setName}
          placeholder="Boulangerie Martin"
        />
        <Input
          label="Adresse e-mail"
          type="email"
          hint="Facultatif."
          value={email}
          onChange={setEmail}
          placeholder="contact@exemple.fr"
        />
        <Input
          label="Téléphone"
          type="tel"
          hint="Facultatif."
          value={phone}
          onChange={setPhone}
          placeholder="06 12 34 56 78"
        />
        <div className="field">
          <span className="field-label">Nature de l’affaire</span>
          <ThemedSelect
            ariaLabel="Nature de l’affaire"
            value={type}
            onChange={(v) => setType(v as ProspectType)}
            options={PROSPECT_TYPE_ORDER.map((t) => ({
              value: t,
              label: `${PROSPECT_TYPE_DEFS[t].label} — ${PROSPECT_TYPE_DEFS[t].hint}`,
            }))}
          />
        </div>
        {/*
          LE RANGEMENT, à côté de la nature : ce sont les deux classements de la
          fiche, et les séparer aurait obligé à chercher à deux endroits.
        */}
        <div className="field">
          <span className="field-label">Dossier</span>
          {/*
            UN `<select>` NATIF, ET C'EST VOULU. La hiérarchie est rendue par
            l'indentation des intitulés ; un arbre déroulant complet dans un
            formulaire déjà long aurait coûté plus qu'il n'apporte, et le natif
            se manipule au clavier partout.
          */}
          <select
            className="input"
            aria-label="Dossier du prospect"
            value={folderId ?? ''}
            onChange={(e) => setFolderId(e.target.value || null)}
          >
            <option value="">Sans dossier</option>
            {aplatirDossiers(dossiers).map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </div>
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

      {/*
        ── LES INFORMATIONS LIBRES, JUSTE APRÈS L'IDENTITÉ ────────────────────

        C'est là qu'on note ce qui décide d'une affaire — budget annoncé,
        hébergeur actuel, qui signe. Les placer après les images les aurait
        reléguées en bas d'un formulaire qu'on ne fait défiler que la première
        fois.
      */}
      <div className="field">
        <div className="field-head">
          <span className="field-label">Informations</span>
          <span className="muted">Un nom, un contenu — autant qu’il en faut.</span>
        </div>
        <ProspectInfoFieldsEditor fields={infoFields} onChange={setInfoFields} />
      </div>

      <TextArea
        label="Notes internes"
        hint="Elles ne sortent jamais du Panel."
        rows={4}
        value={notes}
        onChange={setNotes}
        placeholder="Ce qu’on sait de l’affaire, ce qui a été dit, ce qu’il reste à faire."
      />

      {/* ── LIENS ─────────────────────────────────────────────────────────── */}
      <div className="field">
        <div className="field-head">
          <span className="field-label">Liens</span>
          <Button size="sm" color="secondary" onClick={ajouterLien}>
            Ajouter un lien
          </Button>
        </div>
        {links.length === 0 ? (
          <p className="muted">
            Aucun lien. Le site, la fiche Google, un réseau social, un document partagé.
          </p>
        ) : (
          <ul className="prospect-links">
            {links.map((lien) => (
              <li key={lien.id} className="prospect-link">
                <Input
                  size="sm"
                  label="Intitulé"
                  value={lien.label}
                  onChange={(v) => modifierLien(lien.id, 'label', v)}
                  placeholder="Site officiel"
                />
                <Input
                  size="sm"
                  label="Adresse"
                  value={lien.url}
                  onChange={(v) => modifierLien(lien.id, 'url', v)}
                  placeholder="exemple.fr"
                />
                <Button
                  size="sm"
                  color="secondary"
                  aria-label={`Retirer le lien ${lien.label || lien.url || 'vide'}`}
                  onClick={() => retirerLien(lien.id)}
                >
                  Retirer
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── IMAGES ────────────────────────────────────────────────────────── */}
      <div className="field">
        <div className="field-head">
          <span className="field-label">Images</span>
          <Button
            size="sm"
            color="secondary"
            isLoading={importEnCours}
            onClick={() => champFichier.current?.click()}
          >
            Ajouter des images
          </Button>
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

      {/*
        L'ACTION PRINCIPALE À DROITE, comme dans les dialogues du Panel : c'est
        là que l'œil termine sa lecture, et c'est le geste qu'on cherche.
      */}
      <div className="uui mt-4 flex flex-wrap justify-end gap-2 border-t border-secondary pt-4">
        <Button color="secondary" onClick={onCancel} isDisabled={enCours}>Annuler</Button>
        <Button
          color="primary"
          isDisabled={!pret}
          isLoading={enCours}
          onClick={() => void enregistrer()}
        >
          {prospect ? 'Enregistrer' : 'Ajouter le prospect'}
        </Button>
      </div>
    </Card>
  );
}
