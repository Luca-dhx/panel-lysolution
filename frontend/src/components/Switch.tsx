import { useSwitchIntent } from '@/lib/useSwitchIntent';

/**
 * INTERRUPTEUR — l'intention est immédiate, la vérité reste distante.
 *
 * ══ LE PROBLÈME QU'IL RÉSOUT ════════════════════════════════════════════════
 *
 * Une case à cocher native ne connaît que deux états : coché, décoché. Or ce
 * réglage-ci voyage : le Panel envoie une commande, le projet l'applique,
 * réconcilie son état, puis REPROJETTE le résultat. L'aller-retour prend
 * environ 500 à 700 ms — dont 500 ms de fenêtre de regroupement, délibérée.
 *
 * Pendant ce temps, la case native restait figée sur l'ancienne valeur puis
 * sautait d'un coup : l'utilisateur cliquait et ne voyait rien bouger pendant
 * une demi-seconde, ce qui invite à recliquer.
 *
 * ══ CE QUE CE COMPOSANT NE FAIT PAS ═════════════════════════════════════════
 *
 * Il n'écrit RIEN. Il ne devine RIEN. `checked` reste la valeur CONFIRMÉE par
 * la projection ; l'intention n'est qu'un état d'AFFICHAGE, local et éphémère.
 *
 * La distinction n'est pas cosmétique : une écriture optimiste ferait afficher
 * un réglage que rien n'a persisté, et qu'un rechargement contredirait.
 *
 * ══ LA PROJECTION GAGNE TOUJOURS ════════════════════════════════════════════
 *
 * Si `checked` change pendant l'attente — parce qu'un autre opérateur a agi,
 * ou que le projet a réconcilié autrement — l'intention est ABANDONNÉE et
 * l'interrupteur suit la projection. C'est la seule règle qui garantisse que
 * deux écrans ouverts ne racontent jamais deux histoires différentes.
 */
export interface SwitchProps {
  /** L'état CONFIRMÉ. Jamais écrit par ce composant. */
  checked: boolean;
  /** Rendue quand l'utilisateur demande un changement. Doit résoudre ou lever. */
  onToggle: (next: boolean) => Promise<void>;
  label: string;
  disabled?: boolean;
  /** Nommé pour les lecteurs d'écran quand l'état diffère de l'intention. */
  busyLabel?: string;
}

export function Switch({
  checked, onToggle, label, disabled = false, busyLabel = 'Synchronisation…',
}: SwitchProps) {
  const { affiche, enCours, phase, erreur, basculer } = useSwitchIntent({
    checked, onToggle, disabled,
  });

  return (
    <div className="switch-field">
      <button
        type="button"
        role="switch"
        aria-checked={affiche}
        aria-busy={enCours}
        aria-label={label}
        disabled={disabled || enCours}
        onClick={() => void basculer()}
        className={[
          'switch',
          affiche ? 'switch-on' : 'switch-off',
          enCours ? 'switch-pending' : '',
          phase === 'ERROR' ? 'switch-error' : '',
        ].filter(Boolean).join(' ')}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </button>

      {/*
        LE MOT ACCOMPAGNE LA COULEUR — jamais l'inverse.
        Un état qui ne se lit qu'à la teinte est illisible pour une partie des
        utilisateurs, et invisible en impression ou en fort contraste.
      */}
      <span className="switch-label">
        {enCours ? busyLabel : (affiche ? 'Activée' : 'Désactivée')}
      </span>

      {/*
        `aria-live` : le changement d'état est ANNONCÉ. Sans lui, un lecteur
        d'écran ne signalerait ni l'attente, ni son issue — l'utilisateur
        resterait sur la dernière valeur lue.
      */}
      <span className="sr-only" aria-live="polite">
        {enCours ? busyLabel : `${label} ${affiche ? 'activée' : 'désactivée'}`}
      </span>

      {erreur ? <div className="alert alert-error switch-error-message">{erreur}</div> : null}
    </div>
  );
}

export default Switch;
