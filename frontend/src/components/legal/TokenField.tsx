import { useCallback, useLayoutEffect, useRef } from 'react';
import type { LegalVariable } from '@/types.legal';

/**
 * UN CHAMP DE SAISIE QUI MONTRE LES DONNÉES INSÉRÉES COMME DES JETONS.
 *
 * ══ LE PROBLÈME ═══════════════════════════════════════════════════════════
 *
 * On veut lire, dans l'éditeur :
 *
 *     Le présent site est édité par [ Nom commercial ].
 *
 * et non `{{client.tradeName}}`. Mais on veut aussi une zone de saisie qui se
 * comporte comme une zone de saisie : curseur, sélection, copier-coller,
 * annulation, saisie au clavier physique comme au clavier virtuel.
 *
 * ══ POURQUOI PAS UN `contenteditable` ═════════════════════════════════════
 *
 * C'est la solution qui donnerait des jetons parfaits, et c'est celle qu'on
 * écarte. Un `contenteditable` réimplémente à la main le placement du curseur,
 * le collage (qui arrive en HTML), l'annulation, la composition des claviers
 * asiatiques et les différences entre navigateurs. Pour un éditeur qui écrit
 * des documents JURIDIQUES, le risque d'un caractère perdu ou d'un curseur qui
 * saute est disproportionné.
 *
 * ══ CE QU'ON FAIT À LA PLACE ══════════════════════════════════════════════
 *
 * Un `<textarea>` NATIF, au texte transparent et au curseur visible, posé
 * au-dessus d'un miroir qui rend le MÊME texte avec les `{{…}}` habillés en
 * pastille colorée. Les deux partagent police, taille, interligne, marges et
 * césure : le miroir est donc au pixel près sous le texte réel, et le curseur
 * tombe exactement où il doit.
 *
 * ══ LA PASTILLE GARDE LE TEXTE EXACT, ET C'EST UN CHOIX ═══════════════════
 *
 * Écrire « Nom commercial » à la place de `{{client.tradeName}}` changerait la
 * LARGEUR du texte : le miroir et la zone de saisie se désaligneraient dès la
 * première variable, et tout ce qui suit sur la ligne deviendrait faux. La
 * pastille conserve donc les caractères réels, et le LIBELLÉ HUMAIN est servi
 * par l'infobulle (`title`) — « Nom commercial · Entreprise cliente ».
 *
 * L'aperçu, lui, montre la VRAIE valeur du projet choisi. C'est là qu'on lit
 * le document ; ici, on l'écrit.
 */

const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

interface TokenFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Le registre, pour l'infobulle et pour repérer une clé inconnue. */
  variables: LegalVariable[];
  placeholder?: string;
  rows?: number;
  /** Une seule ligne : les libellés de bloc « Identification légale ». */
  singleLine?: boolean;
  ariaLabel: string;
  /** Remonte la position du curseur, pour que l'insertion tombe au bon endroit. */
  onFocus?: () => void;
  inputRef?: (el: HTMLTextAreaElement | null) => void;
}

export function TokenField({
  value,
  onChange,
  variables,
  placeholder,
  rows = 3,
  singleLine = false,
  ariaLabel,
  onFocus,
  inputRef,
}: TokenFieldProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * LE MIROIR SUIT LE DÉFILEMENT DE LA ZONE DE SAISIE.
   *
   * Sans cela, un texte plus haut que le champ ferait glisser le texte réel
   * sous les pastilles d'un autre paragraphe. Il n'y a pas d'état React
   * là-dedans : ce serait un rendu par pixel défilé.
   */
  const syncScroll = useCallback(() => {
    if (mirrorRef.current && areaRef.current) {
      mirrorRef.current.scrollTop = areaRef.current.scrollTop;
      mirrorRef.current.scrollLeft = areaRef.current.scrollLeft;
    }
  }, []);

  /**
   * LA HAUTEUR SUIT LE CONTENU.
   *
   * Une barre de défilement interne dans un champ de trois lignes oblige à
   * faire défiler pour relire une phrase qu'on vient d'écrire. Sur un document
   * juridique, on relit tout le temps.
   */
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || singleLine) return;
    area.style.height = 'auto';
    area.style.height = `${Math.max(area.scrollHeight, rows * 22)}px`;
    if (mirrorRef.current) mirrorRef.current.style.height = area.style.height;
  }, [value, rows, singleLine]);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    areaRef.current = el;
    inputRef?.(el);
  };

  return (
    <div className={`legal-token-field ${singleLine ? 'is-single' : ''}`}>
      {/*
        LE MIROIR — `aria-hidden` : il double le texte, et un lecteur d'écran
        qui l'annoncerait ferait entendre chaque phrase deux fois. Ce qui est
        lu, c'est la zone de saisie, qui porte le texte réel.
      */}
      <div ref={mirrorRef} className="legal-token-mirror" aria-hidden="true">
        {renderMirror(value, variables)}
      </div>
      <textarea
        ref={setRefs}
        className="legal-token-input"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        rows={singleLine ? 1 : rows}
        spellCheck
        onFocus={onFocus}
        onScroll={syncScroll}
        onChange={(e) => {
          // Une ligne unique reste une ligne : un collage multi-ligne dans un
          // libellé « SIRET » casserait l'alignement du bloc d'identification.
          onChange(singleLine ? e.target.value.replace(/\n/g, ' ') : e.target.value);
        }}
        onKeyDown={(e) => {
          if (singleLine && e.key === 'Enter') e.preventDefault();
        }}
      />
    </div>
  );
}

/**
 * Découpe le texte en fragments et habille les variables.
 *
 * Le fragment final est TOUJOURS suivi d'un `​` invisible : sans lui, un
 * texte se terminant par un saut de ligne perd sa dernière ligne dans le
 * miroir — les navigateurs n'affichent pas une ligne vide finale — et le
 * miroir devient plus court que la zone de saisie.
 */
function renderMirror(value: string, variables: LegalVariable[]) {
  const known = new Map(variables.map((v) => [v.key, v]));
  const out: JSX.Element[] = [];
  let last = 0;
  let index = 0;

  TOKEN_RE.lastIndex = 0;
  let match = TOKEN_RE.exec(value);
  while (match) {
    if (match.index > last) {
      out.push(<span key={`t${index}`}>{value.slice(last, match.index)}</span>);
      index += 1;
    }
    const variable = known.get(match[1]);
    out.push(
      <span
        key={`v${index}`}
        /*
          UNE CLÉ INCONNUE SE VOIT TOUT DE SUITE, EN ROUGE.

          Le backend la refuserait à l'enregistrement avec un message précis ;
          mais découvrir un refus après avoir écrit trois paragraphes est une
          punition. Ici, elle se signale à la frappe.
        */
        className={`legal-token ${variable ? '' : 'is-unknown'}`}
        title={
          variable
            ? `${variable.label} · ${sourceLabel(variable.source)}${variable.required ? '' : ' · facultative'}`
            : `Donnée inconnue : ${match[1]}`
        }
      >
        {match[0]}
      </span>,
    );
    index += 1;
    last = match.index + match[0].length;
    match = TOKEN_RE.exec(value);
  }

  out.push(<span key="tail">{value.slice(last)}&#8203;</span>);
  return out;
}

function sourceLabel(source: string): string {
  if (source === 'CLIENT') return 'Entreprise cliente';
  if (source === 'DEVELOPER') return 'Concepteur du site';
  return 'Hébergeur';
}

/**
 * Insère une variable À LA POSITION DU CURSEUR d'un champ.
 *
 * Elle prend l'élément DOM plutôt que la valeur : le curseur n'existe que là.
 * Reconstruire la chaîne dans React et « deviner » l'endroit reviendrait à
 * insérer toujours à la fin, ce qui rend la palette inutilisable dès qu'on
 * corrige une phrase déjà écrite.
 */
export function insertAtCursor(
  el: HTMLTextAreaElement | null,
  current: string,
  key: string,
): { value: string; caret: number } {
  const token = `{{${key}}}`;
  if (!el) return { value: `${current}${token}`, caret: current.length + token.length };
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? start;
  const value = `${current.slice(0, start)}${token}${current.slice(end)}`;
  return { value, caret: start + token.length };
}

export default TokenField;
