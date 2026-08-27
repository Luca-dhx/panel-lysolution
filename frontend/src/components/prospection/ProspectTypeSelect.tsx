/**
 * CONCEPTION OU REFONTE — une pastille qui s'ouvre.
 *
 * ══ POURQUOI LE MÊME GESTE QUE LE STATUT ════════════════════════════════════
 *
 * Deux contrôles voisins dans la même ligne de tableau doivent s'utiliser de la
 * même façon : ce qu'on voit est ce qu'on change, d'un clic. Donner au type un
 * `<select>` natif alors que le statut s'ouvre en menu aurait produit deux
 * gestes différents pour deux informations de même nature.
 *
 * ══ CE QUI LES DISTINGUE MALGRÉ TOUT ════════════════════════════════════════
 *
 * La FORME. Le statut est une pastille à puce ; le type est une pastille à
 * ICÔNE. La couleur seule n'aurait pas suffi : côte à côte, deux pastilles
 * identiques de couleurs différentes se lisent comme deux états du même axe —
 * et quelqu'un qui distingue mal les couleurs n'aurait rien eu du tout.
 *
 * ══ IL N'Y A PAS DE ROUTE DÉDIÉE, ET C'EST VOULU ════════════════════════════
 *
 * Le statut a la sienne parce qu'il produit une entrée d'historique. Le type
 * n'en produit aucune : ce n'est pas une étape du pipeline, c'est une
 * caractéristique de l'affaire. Il passe donc par la correction partielle
 * (`PATCH`), qui ne touche que le champ nommé.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, RefreshCcw01, Stars01 } from '@untitledui/icons';
import { Button as AriaButton } from 'react-aria-components';
import { BadgeWithIcon } from '@/components/base/badges/badges';
import { Dropdown } from '@/components/base/dropdown/dropdown';
import { cx } from '@/utils/cx';
import { api, errorMessage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import {
  PROSPECT_TYPE_DEFS,
  PROSPECT_TYPE_ORDER,
  prospectType,
  prospectTypeColor,
  prospectTypeLabel,
} from '@/components/prospection/prospectStatus';
import type { ProspectType } from '@/types.prospection';

/**
 * L'icône DIT la nature avant la couleur : des étoiles pour ce qui naît, une
 * flèche circulaire pour ce qui se refait.
 */
const ICONE: Record<ProspectType, typeof Stars01> = {
  CREATION: Stars01,
  REDESIGN: RefreshCcw01,
};

/** La pastille seule — partout où l'on ne modifie pas. */
export function ProspectTypeBadge({
  type,
  size = 'sm',
}: {
  type: ProspectType | undefined;
  size?: 'sm' | 'md';
}) {
  const valeur = prospectType(type);
  return (
    <BadgeWithIcon size={size} color={prospectTypeColor(valeur)} iconLeading={ICONE[valeur]}>
      {prospectTypeLabel(valeur)}
    </BadgeWithIcon>
  );
}

export function ProspectTypeSelect({
  prospectId,
  type,
  onChanged,
  size = 'sm',
}: {
  prospectId: string;
  type: ProspectType | undefined;
  /** Prévient l'écran : il rechargera à son rythme. */
  onChanged?: (next: ProspectType) => void;
  size?: 'sm' | 'md';
}) {
  const toast = useToast();
  const [affiche, setAffiche] = useState<ProspectType>(prospectType(type));
  const [enCours, setEnCours] = useState(false);

  // La valeur du serveur reste l'autorité : si elle change ailleurs — un autre
  // poste, un autre onglet — la pastille suit, sauf pendant notre propre envoi.
  useEffect(() => {
    if (!enCours) setAffiche(prospectType(type));
  }, [type, enCours]);

  const choisir = async (cible: ProspectType) => {
    if (cible === affiche) return;
    const precedent = affiche;
    // Posé AVANT la réponse, repris si le serveur refuse : on reclasse
    // plusieurs affaires d'affilée, et un aller-retour par clic rendrait la
    // manipulation poussive. Un retour en arrière silencieux serait pire.
    setAffiche(cible);
    setEnCours(true);
    try {
      await api.updateProspect(prospectId, { type: cible });
      onChanged?.(cible);
    } catch (err) {
      setAffiche(precedent);
      toast.error(errorMessage(err, 'Le type n’a pas pu être changé.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={`Type : ${prospectTypeLabel(affiche)}. Changer.`}
        isDisabled={enCours}
        className={(state) =>
          cx(
            'flex cursor-pointer items-center gap-1 rounded-full outline-focus-ring transition',
            'hover:opacity-80',
            state.isFocusVisible && 'outline-2 outline-offset-2',
            enCours && 'opacity-60',
          )
        }
      >
        <ProspectTypeBadge type={affiche} size={size} />
        <ChevronDown className="size-4 shrink-0 text-fg-quaternary" aria-hidden="true" />
      </AriaButton>

      <Dropdown.Popover className="w-64">
        <Dropdown.Menu
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[affiche]}
          onSelectionChange={(cles) => {
            const [premiere] = Array.from(cles as Set<string>);
            if (premiere) void choisir(premiere as ProspectType);
          }}
        >
          {PROSPECT_TYPE_ORDER.map((valeur) => {
            const Icone = ICONE[valeur];
            return (
              <Dropdown.Item key={valeur} id={valeur} textValue={prospectTypeLabel(valeur)}>
                <span className="flex items-center gap-2">
                  <Icone
                    aria-hidden="true"
                    className={cx('size-4 shrink-0', COULEUR_ICONE[valeur])}
                  />
                  <span className="flex flex-col">
                    <span>{prospectTypeLabel(valeur)}</span>
                    <span className="text-xs font-normal text-tertiary">
                      {PROSPECT_TYPE_DEFS[valeur].hint}
                    </span>
                  </span>
                </span>
              </Dropdown.Item>
            );
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/**
 * Les classes sont ÉCRITES EN ENTIER — Tailwind lit le code source pour
 * décider quoi générer, et une classe fabriquée par concaténation
 * (`text-utility-${couleur}-500`) n'existerait dans aucun fichier au moment de
 * la compilation. Le style manquerait sans la moindre erreur.
 */
const COULEUR_ICONE: Record<ProspectType, string> = {
  CREATION: 'text-utility-indigo-500',
  REDESIGN: 'text-utility-purple-500',
};
