/**
 * LES MODÈLES D'ACCROCHE.
 *
 * ══ CE QU'ON VIENT Y CHERCHER ═══════════════════════════════════════════════
 *
 * Un texte à copier, maintenant, pour l'envoyer ailleurs. L'écran est donc
 * organisé autour de ce geste : le corps est visible sans ouvrir quoi que ce
 * soit, et un bouton le met dans le presse-papiers.
 *
 * ══ LA DESCRIPTION N'EST PAS LE CORPS ══════════════════════════════════════
 *
 * Elle dit QUAND s'en servir — « après un premier refus poli », « quand ils ont
 * déjà un site mais qu'il date ». C'est ce qui permet de choisir entre deux
 * modèles sans lire les deux en entier.
 *
 * ══ RIEN N'ENVOIE ══════════════════════════════════════════════════════════
 *
 * Le Panel n'expédie aucun message. Un modèle se copie, se colle, et part par
 * l'outil de son choix.
 */
import { useMemo, useState } from 'react';
import { Badge } from '@/components/base/badges/badges';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Input } from '@/components/base/input/input';
import { TextArea } from '@/components/base/textarea/textarea';
import { Icon } from '@/components/Icon';
import { EmptyPanel } from '@/components/ui-kit';
import type { ProspectTemplate, ProspectTemplateInput } from '@/types.prospection';
import type { FolderNode } from '@/components/prospection/FolderTree';

/** Les dossiers, à plat et indentés — ce qu'un menu déroulant peut montrer. */
function aplatir(noeuds: FolderNode[], profondeur = 0): { id: string; label: string }[] {
  return noeuds.flatMap((n) => [
    { id: n.id, label: `${'— '.repeat(profondeur)}${n.name}` },
    ...aplatir(n.children, profondeur + 1),
  ]);
}

function TemplateCard({
  template, cheminDossier, onEdit, onDelete,
}: {
  template: ProspectTemplate;
  cheminDossier: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copie, setCopie] = useState(false);

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(template.body);
      setCopie(true);
      /* Le retour visuel s'efface : un bouton qui reste sur « Copié » ne dit
         plus rien à la copie suivante. */
      setTimeout(() => setCopie(false), 2000);
    } catch {
      /* Presse-papiers refusé — contexte non sécurisé, ou permission niée. Le
         texte reste sélectionnable à la main, et l'écran ne ment pas. */
      setCopie(false);
    }
  };

  return (
    <article className="rounded-xl border border-secondary bg-primary p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-md font-semibold text-primary">{template.title}</h3>
            {template.channel ? (
              <Badge size="sm" color="gray" type="pill-color">{template.channel}</Badge>
            ) : null}
          </div>
          {cheminDossier ? (
            <p className="mt-0.5 text-xs text-tertiary">{cheminDossier}</p>
          ) : (
            <p className="mt-0.5 text-xs text-quaternary">Sans dossier</p>
          )}
        </div>
        <Button
          size="sm"
          color="secondary"
          iconLeading={() => <Icon name={copie ? 'check2' : 'file-earmark-text'} />}
          onClick={() => void copier()}
          isDisabled={!template.body.trim()}
        >
          {copie ? 'Copié' : 'Copier'}
        </Button>
      </header>

      {template.description ? (
        <p className="mt-3 text-sm text-secondary">{template.description}</p>
      ) : null}

      {template.body.trim() ? (
        /*
          LE CORPS EST RENDU TEL QU'IL A ÉTÉ ÉCRIT : c'est un texte destiné à
          être copié-collé, et ses retours à la ligne font partie du message.
        */
        <pre className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-secondary bg-secondary p-3 text-sm whitespace-pre-wrap text-secondary">
          {template.body}
        </pre>
      ) : (
        <p className="mt-3 text-sm text-quaternary">Corps non rédigé.</p>
      )}

      <footer className="mt-3 flex flex-wrap gap-2 border-t border-secondary pt-3">
        <Button size="sm" color="secondary" iconLeading={() => <Icon name="pencil" />} onClick={onEdit}>
          Éditer
        </Button>
        <Button size="sm" color="link-destructive" onClick={onDelete}>Supprimer</Button>
      </footer>
    </article>
  );
}

export function TemplatesPanel({
  templates, racines, chemins, onCreate, onUpdate, onDelete, dossierCourant,
}: {
  templates: ProspectTemplate[];
  racines: FolderNode[];
  /** L'adresse lisible d'un dossier — « Accroches froides / Restaurants ». */
  chemins: Map<string, string>;
  onCreate: (body: ProspectTemplateInput) => Promise<void>;
  onUpdate: (id: string, body: ProspectTemplateInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Le dossier sélectionné dans l'arbre — proposé par défaut à la création. */
  dossierCourant: string | null;
}) {
  const [edite, setEdite] = useState<ProspectTemplate | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const [titre, setTitre] = useState('');
  const [canal, setCanal] = useState('');
  const [description, setDescription] = useState('');
  const [corps, setCorps] = useState('');
  const [dossier, setDossier] = useState<string | null>(null);

  const options = useMemo(() => aplatir(racines), [racines]);

  const ouvrir = (t: ProspectTemplate | null) => {
    setEdite(t);
    setTitre(t?.title ?? '');
    setCanal(t?.channel ?? '');
    setDescription(t?.description ?? '');
    setCorps(t?.body ?? '');
    /* À la création, le dossier SÉLECTIONNÉ est proposé : on vient d'y cliquer,
       c'est là qu'on veut ranger. */
    setDossier(t ? t.folderId : dossierCourant);
    setErreur(null);
    setOuvert(true);
  };

  const enregistrer = async () => {
    if (!titre.trim()) { setErreur('Un titre est requis.'); return; }
    setEnCours(true);
    setErreur(null);
    try {
      const corpsEnvoye: ProspectTemplateInput = {
        title: titre.trim(), channel: canal, description, body: corps, folderId: dossier,
      };
      if (edite) await onUpdate(edite._id, corpsEnvoye);
      else await onCreate(corpsEnvoye);
      setOuvert(false);
      setEdite(null);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Enregistrement impossible.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="uui flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-tertiary">
          Nos accroches, prêtes à copier. Rien n’est envoyé d’ici.
        </p>
        <Button
          color="primary"
          iconLeading={() => <Icon name="plus-lg" />}
          onClick={() => ouvrir(null)}
        >
          Nouveau modèle
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyPanel
          title="Aucun modèle ici"
          hint="Un modèle porte un titre, un canal, une description — quand s’en servir — et le texte lui-même."
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {templates.map((t) => (
            <TemplateCard
              key={t._id}
              template={t}
              cheminDossier={t.folderId ? (chemins.get(t.folderId) ?? null) : null}
              onEdit={() => ouvrir(t)}
              onDelete={() => void onDelete(t._id)}
            />
          ))}
        </div>
      )}

      <ModalOverlay isOpen={ouvert} onOpenChange={(v) => { if (!v) { setOuvert(false); setEdite(null); } }} isDismissable>
        <Modal className="w-full max-w-2xl">
          <Dialog>
            <div className="uui flex flex-col gap-4 p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-primary">
                {edite ? 'Modifier le modèle' : 'Nouveau modèle'}
              </h2>

              <Input label="Titre" isRequired value={titre} onChange={setTitre}
                placeholder="Premier contact — restaurant sans site" />

              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Canal" value={canal} onChange={setCanal}
                  hint="Texte libre : e-mail, LinkedIn, au téléphone…"
                  placeholder="E-mail" />

                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-secondary">Dossier</span>
                  {/*
                    UN `<select>` NATIF, ET C'EST VOULU. La hiérarchie est rendue
                    par l'indentation des intitulés ; un arbre déroulant complet
                    dans un formulaire déjà long aurait coûté plus qu'il
                    n'apporte, et le natif se manipule au clavier partout.
                  */}
                  <select
                    className="input"
                    aria-label="Dossier du modèle"
                    value={dossier ?? ''}
                    onChange={(e) => setDossier(e.target.value || null)}
                  >
                    <option value="">Sans dossier</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <TextArea
                label="Description"
                hint="Quand s’en sert-on ? C’est ce qui permet de choisir sans tout relire."
                rows={2}
                value={description}
                onChange={setDescription}
                placeholder="Après un premier refus poli."
              />

              <TextArea
                label="Corps"
                rows={10}
                value={corps}
                onChange={setCorps}
                placeholder="Le texte de l’accroche."
              />

              {erreur ? <p role="alert" className="text-sm text-error-primary">{erreur}</p> : null}

              <footer className="flex flex-wrap justify-end gap-2 border-t border-secondary pt-4">
                <Button color="secondary" onClick={() => { setOuvert(false); setEdite(null); }} isDisabled={enCours}>
                  Annuler
                </Button>
                <Button color="primary" isLoading={enCours} onClick={() => void enregistrer()}>
                  {edite ? 'Enregistrer' : 'Créer le modèle'}
                </Button>
              </footer>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

export default TemplatesPanel;
