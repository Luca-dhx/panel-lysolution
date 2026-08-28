/**
 * LA COLONNE DES DOSSIERS — l'arbre, et les gestes qui le font vivre.
 *
 * ══ ELLE EST UN `<aside>`, PAS UNE COLONNE DE GRILLE ════════════════════════
 *
 * Sous `lg`, elle passe AU-DESSUS de la liste plutôt qu'à côté : la barre
 * latérale du Panel prend déjà 250 px dès 900 px de fenêtre, et une seconde
 * colonne à cet endroit laisserait moins de trois cents pixels au contenu — la
 * largeur d'un nom de prospect tronqué.
 *
 * ══ RENOMMER ET SUPPRIMER PASSENT PAR UN DIALOGUE ══════════════════════════
 *
 * Renommer en place aurait demandé un champ dans l'arbre, donc un état d'édition
 * par nœud et un piège au clavier — la touche Entrée y sert déjà à sélectionner.
 *
 * Supprimer demande confirmation, mais la phrase dit ce qui se passe VRAIMENT :
 * le contenu remonte d'un cran, il n'est pas effacé. Une confirmation qui laisse
 * craindre le pire fait renoncer à un geste inoffensif.
 */
import { useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Dialog, Modal, ModalOverlay } from '@/components/application/modals/modal';
import { Input } from '@/components/base/input/input';
import { Icon } from '@/components/Icon';
import { FolderTree } from '@/components/prospection/FolderTree';
import type { FolderNode, FolderSelection } from '@/components/prospection/FolderTree';

type Volet =
  | { mode: 'creer'; parentId: string | null; parentNom: string | null }
  | { mode: 'renommer'; noeud: FolderNode }
  | { mode: 'supprimer'; noeud: FolderNode }
  | null;

export function FolderSidebar({
  racines, total, sansDossier, selection, onSelectionChange,
  onCreer, onRenommer, onSupprimer, labelTout, titre = 'Dossiers',
}: {
  racines: FolderNode[];
  total: number;
  sansDossier: number;
  selection: FolderSelection;
  onSelectionChange: (s: FolderSelection) => void;
  onCreer: (nom: string, parentId: string | null) => Promise<void>;
  onRenommer: (id: string, nom: string) => Promise<void>;
  onSupprimer: (id: string) => Promise<void>;
  labelTout?: string;
  titre?: string;
}) {
  const [volet, setVolet] = useState<Volet>(null);
  const [nom, setNom] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const ouvrir = (v: Volet) => {
    setVolet(v);
    setNom(v?.mode === 'renommer' ? v.noeud.name : '');
    setErreur(null);
  };

  const valider = async () => {
    if (!volet) return;
    if (volet.mode !== 'supprimer' && !nom.trim()) {
      setErreur('Un nom est requis.');
      return;
    }
    setEnCours(true);
    setErreur(null);
    try {
      if (volet.mode === 'creer') await onCreer(nom.trim(), volet.parentId);
      else if (volet.mode === 'renommer') await onRenommer(volet.noeud.id, nom.trim());
      else await onSupprimer(volet.noeud.id);
      setVolet(null);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Action impossible.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <>
      <aside className="uui flex flex-col gap-2 rounded-xl border border-secondary bg-primary p-3 lg:w-64 lg:shrink-0">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-tertiary uppercase">{titre}</h3>
          <Button
            size="sm"
            color="link-gray"
            iconLeading={() => <Icon name="plus-lg" size={12} />}
            onClick={() => ouvrir({ mode: 'creer', parentId: null, parentNom: null })}
          >
            Nouveau
          </Button>
        </div>

        {/* L'arbre défile DANS la colonne : quarante dossiers ne doivent pas
            faire défiler la liste qui est à côté. */}
        <div className="max-h-[26rem] overflow-y-auto lg:max-h-[calc(100vh-16rem)]">
          <FolderTree
            racines={racines}
            total={total}
            sansDossier={sansDossier}
            selection={selection}
            onSelectionChange={onSelectionChange}
            labelTout={labelTout}
            onAjouterEnfant={(n) => ouvrir({ mode: 'creer', parentId: n.id, parentNom: n.name })}
            onRenommer={(n) => ouvrir({ mode: 'renommer', noeud: n })}
            onSupprimer={(n) => ouvrir({ mode: 'supprimer', noeud: n })}
          />
        </div>
      </aside>

      <ModalOverlay isOpen={volet !== null} onOpenChange={(v) => { if (!v) setVolet(null); }} isDismissable>
        <Modal className="w-full max-w-md">
          <Dialog>
            <div className="uui flex flex-col gap-4 p-5 sm:p-6">
              <h3 className="text-lg font-semibold text-primary">
                {volet?.mode === 'creer'
                  ? (volet.parentNom ? `Sous-dossier de « ${volet.parentNom} »` : 'Nouveau dossier')
                  : volet?.mode === 'renommer' ? 'Renommer le dossier'
                    : `Supprimer « ${volet?.noeud.name} » ?`}
              </h3>

              {volet?.mode === 'supprimer' ? (
                /*
                  LA PHRASE DIT CE QUI SE PASSE VRAIMENT. Une confirmation qui
                  laisse craindre le pire fait renoncer à un geste inoffensif —
                  et un rangement n'est pas une corbeille.
                */
                <p className="text-sm text-secondary">
                  Le dossier disparaît. Ce qu’il contient — sous-dossiers compris —
                  {' '}<strong>remonte d’un cran</strong> et reste intact.
                </p>
              ) : (
                <Input
                  label="Nom"
                  isRequired
                  autoFocus
                  value={nom}
                  onChange={setNom}
                  placeholder="Restaurants"
                  onKeyDown={(e) => { if (e.key === 'Enter') void valider(); }}
                />
              )}

              {erreur ? <p role="alert" className="text-sm text-error-primary">{erreur}</p> : null}

              <footer className="flex flex-wrap justify-end gap-2 border-t border-secondary pt-4">
                <Button color="secondary" onClick={() => setVolet(null)} isDisabled={enCours}>
                  Annuler
                </Button>
                <Button
                  color={volet?.mode === 'supprimer' ? 'primary-destructive' : 'primary'}
                  isLoading={enCours}
                  onClick={() => void valider()}
                >
                  {volet?.mode === 'supprimer' ? 'Supprimer' : 'Enregistrer'}
                </Button>
              </footer>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

export default FolderSidebar;
