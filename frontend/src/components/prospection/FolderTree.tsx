/**
 * L'ARBRE DES DOSSIERS.
 *
 * ══ POURQUOI UN VRAI `Tree`, ET PAS UNE LISTE INDENTÉE ══════════════════════
 *
 * Parce qu'une liste indentée ne s'annonce pas. Le `Tree` de React Aria — la
 * base sur laquelle Untitled UI est construit — pose `role="tree"`,
 * `aria-expanded`, `aria-level`, un seul arrêt de tabulation pour le groupe, et
 * la navigation aux flèches : haut/bas pour parcourir, droite pour déplier,
 * gauche pour replier ou remonter au parent. Rien de cela ne s'obtient d'une
 * `<ul>` à `padding-left`.
 *
 * ══ DEUX ENTRÉES QUI NE SONT PAS DES DOSSIERS ══════════════════════════════
 *
 *   « Tout »          ne filtre rien. C'est l'état d'arrivée : on ouvre l'écran
 *                     pour voir ce qu'on a, pas pour choisir un rayon.
 *   « Sans dossier »  ce qui n'est rangé nulle part. Sans cette entrée, un
 *                     prospect noté pendant un appel disparaîtrait de l'écran
 *                     dès qu'un dossier est sélectionné, et on le croirait
 *                     perdu.
 *
 * Elles vivent DANS l'arbre, à la racine, et pas dans une barre d'outils à
 * côté : ce sont trois réponses à la même question — « qu'est-ce que je
 * regarde ? » — et les séparer obligerait à chercher à deux endroits.
 *
 * ══ LE COMPTE EST CELUI DE LA BRANCHE, PAS DU DOSSIER ══════════════════════
 *
 * « Restaurants (12) » où le dossier lui-même n'en porte que deux, les dix
 * autres étant dans « Restaurants/Paris », est la seule lecture utile : sinon
 * un dossier de rangement pur afficherait zéro, et on le croirait vide.
 */
import { useMemo } from 'react';
import {
  Button as AriaButton,
  Tree as AriaTree,
  TreeItem as AriaTreeItem,
  TreeItemContent as AriaTreeItemContent,
} from 'react-aria-components';
import { Icon } from '@/components/Icon';
import type { ProspectFolder } from '@/types.prospection';

/** La sélection de l'écran : un dossier, la racine, ou tout. */
export type FolderSelection = string | 'ALL' | 'NONE';

export interface FolderNode {
  id: string;
  name: string;
  children: FolderNode[];
  /** Ce que porte ce dossier seul. */
  compte: number;
  /** Ce que porte la BRANCHE — lui et toute sa descendance. */
  compteBranche: number;
}

/**
 * L'ARBRE, DEPUIS LA LISTE PLATE DU SERVEUR.
 *
 * ── LA BORNE N'EST PAS DE LA SUPERSTITION ─────────────────────────────────
 * Un cycle déjà présent en base — écrit par une version antérieure, ou par une
 * écriture concurrente — ferait boucler l'écran sans fin. Le serveur l'interdit
 * à l'écriture ; l'écran refuse de s'y perdre à la lecture.
 */
export function buildFolderTree(
  folders: ProspectFolder[],
  comptes: Map<string | null, number>,
): { racines: FolderNode[]; total: number; sansDossier: number } {
  const parParent = new Map<string | null, ProspectFolder[]>();
  for (const f of folders) {
    const clef = f.parentId ?? null;
    parParent.set(clef, [...(parParent.get(clef) ?? []), f]);
  }

  const vus = new Set<string>();
  const construire = (parentId: string | null, profondeur: number): FolderNode[] => {
    if (profondeur > 20) return [];
    return (parParent.get(parentId) ?? [])
      .filter((f) => !vus.has(f._id))
      .map((f) => {
        vus.add(f._id);
        const enfants = construire(f._id, profondeur + 1);
        const compte = comptes.get(f._id) ?? 0;
        return {
          id: f._id,
          name: f.name,
          children: enfants,
          compte,
          compteBranche: compte + enfants.reduce((n, e) => n + e.compteBranche, 0),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  };

  const racines = construire(null, 0);
  let total = 0;
  for (const n of comptes.values()) total += n;

  return { racines, total, sansDossier: comptes.get(null) ?? 0 };
}

/** Tous les identifiants de la branche, sélection comprise. */
export function branche(noeud: FolderNode): string[] {
  return [noeud.id, ...noeud.children.flatMap(branche)];
}

function trouver(noeuds: FolderNode[], id: string): FolderNode | null {
  for (const n of noeuds) {
    if (n.id === id) return n;
    const trouve = trouver(n.children, id);
    if (trouve) return trouve;
  }
  return null;
}

/** Les identifiants couverts par une sélection — la branche entière. */
export function idsCouverts(racines: FolderNode[], selection: FolderSelection): string[] {
  if (selection === 'ALL' || selection === 'NONE') return [];
  const noeud = trouver(racines, selection);
  return noeud ? branche(noeud) : [selection];
}

const LIGNE = [
  'group flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm outline-hidden',
  'cursor-pointer transition-colors',
  'hover:bg-secondary',
  'focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
  'selected:bg-secondary selected:font-medium',
].join(' ');

function Noeud({
  noeud, onRenommer, onSupprimer, onAjouterEnfant,
}: {
  noeud: FolderNode;
  onRenommer?: (n: FolderNode) => void;
  onSupprimer?: (n: FolderNode) => void;
  onAjouterEnfant?: (n: FolderNode) => void;
}) {
  const aDesEnfants = noeud.children.length > 0;

  return (
    <AriaTreeItem id={noeud.id} textValue={noeud.name} className={LIGNE}>
      <AriaTreeItemContent>
        {/*
          LE CHEVRON EST UN BOUTON `slot="chevron"` : React Aria lui câble le
          dépliage, l'état `aria-expanded` et la touche Entrée. Un `<span>` avec
          un `onClick` aurait tout laissé au clavier sans réponse.

          Une feuille garde son emplacement, vide : sans lui, les noms des
          feuilles et ceux des dossiers ne s'aligneraient pas, et l'œil lirait
          deux niveaux là où il n'y en a qu'un.
        */}
        {aDesEnfants ? (
          <AriaButton
            slot="chevron"
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-tertiary outline-hidden hover:text-primary"
          >
            <Icon name="chevron-right" size={12} className="transition-transform group-expanded:rotate-90" />
          </AriaButton>
        ) : (
          <span aria-hidden="true" className="size-5 shrink-0" />
        )}

        <Icon name={aDesEnfants ? 'stack' : 'journal-text'} size={14} className="shrink-0 text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-secondary group-selected:text-primary">
          {noeud.name}
        </span>
        <span className="shrink-0 text-xs text-quaternary">{noeud.compteBranche}</span>

        {/*
          LES ACTIONS N'APPARAISSENT QU'AU SURVOL ET AU FOCUS.
          `focus-within` est la moitié qui compte : sans elle, un utilisateur au
          clavier atteindrait des boutons invisibles.
        */}
        {(onAjouterEnfant || onRenommer || onSupprimer) ? (
          <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {onAjouterEnfant ? (
              <button
                type="button" aria-label={`Ajouter un sous-dossier à ${noeud.name}`}
                className="rounded-sm p-0.5 text-tertiary hover:text-primary"
                onClick={(e) => { e.stopPropagation(); onAjouterEnfant(noeud); }}
              ><Icon name="plus-lg" size={12} /></button>
            ) : null}
            {onRenommer ? (
              <button
                type="button" aria-label={`Renommer ${noeud.name}`}
                className="rounded-sm p-0.5 text-tertiary hover:text-primary"
                onClick={(e) => { e.stopPropagation(); onRenommer(noeud); }}
              ><Icon name="pencil" size={12} /></button>
            ) : null}
            {onSupprimer ? (
              <button
                type="button" aria-label={`Supprimer ${noeud.name}`}
                className="rounded-sm p-0.5 text-tertiary hover:text-primary"
                onClick={(e) => { e.stopPropagation(); onSupprimer(noeud); }}
              ><Icon name="trash" size={12} /></button>
            ) : null}
          </span>
        ) : null}
      </AriaTreeItemContent>

      {noeud.children.map((enfant) => (
        <Noeud
          key={enfant.id}
          noeud={enfant}
          onRenommer={onRenommer}
          onSupprimer={onSupprimer}
          onAjouterEnfant={onAjouterEnfant}
        />
      ))}
    </AriaTreeItem>
  );
}

export function FolderTree({
  racines, total, sansDossier, selection, onSelectionChange,
  onRenommer, onSupprimer, onAjouterEnfant, labelTout = 'Tout',
}: {
  racines: FolderNode[];
  total: number;
  sansDossier: number;
  selection: FolderSelection;
  onSelectionChange: (s: FolderSelection) => void;
  onRenommer?: (n: FolderNode) => void;
  onSupprimer?: (n: FolderNode) => void;
  onAjouterEnfant?: (n: FolderNode) => void;
  labelTout?: string;
}) {
  const cles = useMemo(() => new Set([selection]), [selection]);

  return (
    <AriaTree
      aria-label="Dossiers"
      selectionMode="single"
      selectedKeys={cles}
      disallowEmptySelection
      onSelectionChange={(k) => {
        const premier = [...k][0];
        if (typeof premier === 'string') onSelectionChange(premier as FolderSelection);
      }}
      className="uui flex flex-col gap-0.5 outline-hidden"
    >
      <AriaTreeItem id="ALL" textValue={labelTout} className={LIGNE}>
        <AriaTreeItemContent>
          <span aria-hidden="true" className="size-5 shrink-0" />
          <Icon name="stack" size={14} className="shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-secondary group-selected:text-primary">
            {labelTout}
          </span>
          <span className="shrink-0 text-xs text-quaternary">{total}</span>
        </AriaTreeItemContent>
      </AriaTreeItem>

      <AriaTreeItem id="NONE" textValue="Sans dossier" className={LIGNE}>
        <AriaTreeItemContent>
          <span aria-hidden="true" className="size-5 shrink-0" />
          <Icon name="archive" size={14} className="shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-secondary group-selected:text-primary">
            Sans dossier
          </span>
          <span className="shrink-0 text-xs text-quaternary">{sansDossier}</span>
        </AriaTreeItemContent>
      </AriaTreeItem>

      {racines.map((n) => (
        <Noeud
          key={n.id}
          noeud={n}
          onRenommer={onRenommer}
          onSupprimer={onSupprimer}
          onAjouterEnfant={onAjouterEnfant}
        />
      ))}
    </AriaTree>
  );
}

export default FolderTree;
