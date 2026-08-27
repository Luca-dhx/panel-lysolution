/**
 * LE CHANGEMENT DE STATUT — une pastille qui s'ouvre.
 *
 * ══ POURQUOI LA PASTILLE EST ELLE-MÊME LE BOUTON ════════════════════════════
 *
 * L'alternative était un `<select>` posé à côté de l'état. Elle affiche deux
 * fois la même information — une pastille colorée qui dit « En cours », puis
 * une liste déroulante qui dit « En cours » — et laisse le lecteur se demander
 * laquelle fait foi. Ici l'état EST le contrôle : ce qu'on voit est ce qu'on
 * change.
 *
 * ══ L'ÉTAT SE POSE AVANT LA RÉPONSE DU SERVEUR, ET SE REPREND S'IL REFUSE ═══
 *
 * Sur un tableau, on reclasse plusieurs affaires d'affilée. Attendre l'aller-
 * retour à chaque clic rendait la manipulation poussive, et le rafraîchissement
 * vivant (30 s) faisait « sauter » la pastille en arrière entre-temps. On
 * affiche donc la valeur choisie immédiatement, et on la REMET si le serveur
 * refuse — accompagnée d'un message, parce qu'un retour en arrière silencieux
 * est le pire des deux mondes.
 */
import { useEffect, useState } from 'react';
import { ChevronDown } from '@untitledui/icons';
import { Button as AriaButton } from 'react-aria-components';
import { BadgeWithDot } from '@/components/base/badges/badges';
import { Dropdown } from '@/components/base/dropdown/dropdown';
import { Dot } from '@/components/foundations/dot-icon';
import { cx } from '@/utils/cx';
import { api, errorMessage } from '@/lib/api';
import { useToast } from '@/components/ToastProvider';
import {
  PROSPECT_STATUS_DEFS,
  PROSPECT_STATUS_ORDER,
  prospectStatusColor,
  prospectStatusLabel,
} from '@/components/prospection/prospectStatus';
import type { ProspectStatus } from '@/types.prospection';

/** La pastille seule — sans interaction. Utilisée partout où l'on ne modifie pas. */
export function ProspectStatusBadge({
  status,
  size = 'sm',
}: {
  status: ProspectStatus;
  size?: 'sm' | 'md';
}) {
  return (
    <BadgeWithDot size={size} color={prospectStatusColor(status)}>
      {prospectStatusLabel(status)}
    </BadgeWithDot>
  );
}

export function ProspectStatusSelect({
  prospectId,
  status,
  onChanged,
  size = 'sm',
}: {
  prospectId: string;
  status: ProspectStatus;
  /** Prévient l'écran : il rechargera à son rythme. */
  onChanged?: (next: ProspectStatus) => void;
  size?: 'sm' | 'md';
}) {
  const toast = useToast();
  const [affiche, setAffiche] = useState<ProspectStatus>(status);
  const [enCours, setEnCours] = useState(false);

  // La valeur du serveur reste l'autorité : si elle change ailleurs — un autre
  // poste, un autre onglet — la pastille suit, sauf pendant notre propre envoi.
  useEffect(() => {
    if (!enCours) setAffiche(status);
  }, [status, enCours]);

  const choisir = async (cible: ProspectStatus) => {
    if (cible === affiche) return;
    const precedent = affiche;
    setAffiche(cible);
    setEnCours(true);
    try {
      await api.setProspectStatus(prospectId, cible);
      onChanged?.(cible);
    } catch (err) {
      setAffiche(precedent);
      toast.error(errorMessage(err, 'Le statut n’a pas pu être changé.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={`Statut : ${prospectStatusLabel(affiche)}. Changer.`}
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
        <ProspectStatusBadge status={affiche} size={size} />
        <ChevronDown className="size-4 shrink-0 text-fg-quaternary" aria-hidden="true" />
      </AriaButton>

      <Dropdown.Popover className="w-64">
        <Dropdown.Menu
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[affiche]}
          onSelectionChange={(cles) => {
            const [premiere] = Array.from(cles as Set<string>);
            if (premiere) void choisir(premiere as ProspectStatus);
          }}
        >
          {PROSPECT_STATUS_ORDER.map((valeur) => (
            <Dropdown.Item key={valeur} id={valeur} textValue={prospectStatusLabel(valeur)}>
              <span className="flex items-center gap-2">
                <Dot
                  size="sm"
                  aria-hidden="true"
                  className={COULEUR_PUCE[PROSPECT_STATUS_DEFS[valeur].color]}
                />
                <span className="flex flex-col">
                  <span>{prospectStatusLabel(valeur)}</span>
                  <span className="text-xs font-normal text-tertiary">
                    {PROSPECT_STATUS_DEFS[valeur].hint}
                  </span>
                </span>
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/**
 * La puce de la liste déroulante. Les classes sont ÉCRITES EN ENTIER — Tailwind
 * lit le code source pour décider quoi générer, et une classe fabriquée par
 * concaténation (`text-utility-${couleur}-500`) n'existerait dans aucun fichier
 * au moment de la compilation. Le style manquerait sans la moindre erreur.
 */
const COULEUR_PUCE: Record<string, string> = {
  gray: 'text-utility-neutral-500',
  orange: 'text-utility-orange-500',
  blue: 'text-utility-blue-500',
  error: 'text-utility-red-500',
  success: 'text-utility-green-500',
};
