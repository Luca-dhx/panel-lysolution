/**
 * UNE FICHE DU PANEL — une ligne, pleine largeur, et rien d'autre.
 *
 * ══ CE QUE CES COMPOSANTS NE FONT PAS ═══════════════════════════════════════
 *
 * Ils ne décident rien. L'état d'une fiche, son besoin d'action, son
 * environnement, sa destination : tout est calculé par `projectConnections.ts`
 * à partir des verdicts que le backend publie. Ici on met en forme.
 *
 * ══ CE QUI A DISPARU ════════════════════════════════════════════════════════
 *
 * `EnvironmentConnectionRow` rendait DEUX lignes par projet — TEST et PROD —
 * dont l'une, presque toujours, était une case vide portant un bouton
 * « Appairer la production ». Ce bouton ne pouvait pas aboutir : une instance
 * de Panel ne sert qu'un environnement, et le bootstrap refuse l'autre.
 *
 * Une fiche, une ligne. Si le client a une recette et une production, ce sont
 * deux fiches — dans deux Panels — et elles ne se croisent jamais.
 */
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { formatDateTime } from '@/lib/format';
import { ConnectionActions } from '@/components/ConnectionActions';
import { manageLink, type PairingRow } from '@/lib/projectConnections';

/**
 * LE POINT D'ÉTAT — couleur ET forme ET texte.
 *
 * Un statut porté par la seule couleur est invisible pour une partie des
 * lecteurs. Le symbole (plein, à demi, vide) le double, et le libellé le dit
 * en toutes lettres. Le point lui-même est décoratif : il est retiré de l'arbre
 * d'accessibilité pour ne pas faire lire « rond noir » avant le mot utile.
 */
export function ConnectionStatusDot({ row }: { row: PairingRow }) {
  return (
    <span className={`conn-dot conn-dot-${row.state.tone}`} aria-hidden="true">
      {row.state.symbol}
    </span>
  );
}

/**
 * UNE VALEUR QU'ON NE CONNAÎT PAS — dite, jamais devinée.
 *
 * Un tiret muet se lit comme « vide ». « — non connu — » se lit comme « le
 * projet ne l'a pas encore déclaré », ce qui est exactement la situation.
 */
function Inconnu({ quoi }: { quoi: string }) {
  return <span className="conn-unknown">— {quoi} —</span>;
}

/**
 * LA LIGNE D'UNE FICHE — l'unité de lecture de toute la page.
 *
 * AVANT APPAIRAGE : le nom, « Non appairé », et l'action d'appairer. Aucun
 * environnement, aucune destination, aucune clé technique — rien de dérivé
 * d'un projet qui n'a pas encore parlé.
 *
 * APRÈS : le nom courant poussé par le projet, son état, l'environnement qu'il
 * DÉCLARE, sa destination courante, son dernier contact et la dernière donnée
 * métier reçue.
 */
export function PairingRowItem({
  row,
  onChanged,
}: {
  row: PairingRow;
  /**
   * Les actions secondaires (code, révocation) ne sont proposées QUE si
   * l'écran sait se rafraîchir ensuite. Une action dont on ne voit pas l'effet
   * pousse à la rejouer — et révoquer deux fois n'est pas anodin.
   */
  onChanged?: () => Promise<void> | void;
}) {
  const titreId = `pairing-${row.projectId}`;

  return (
    <article
      className={row.paired ? 'pairing-item' : 'pairing-item pairing-item-unpaired'}
      aria-labelledby={titreId}
    >
      <div className="pairing-identity">
        <h2 className="pairing-name" id={titreId}>{row.name}</h2>
        {row.tagline ? <p className="pairing-tagline">{row.tagline}</p> : null}
        <span className="pairing-state">
          <ConnectionStatusDot row={row} />
          <span className={`conn-state-label conn-state-${row.state.tone}`}>
            {row.state.label}
          </span>
        </span>
      </div>

      {/*
        LES FAITS DU PROJET DISTANT — et eux seuls.
        Sur une fiche non appairée, ce bloc dit trois fois « non connu ». C'est
        l'information juste : le Panel ne sait rien d'un projet qui ne lui a
        pas encore parlé.
      */}
      <dl className="pairing-facts">
        <div>
          <dt>Environnement</dt>
          <dd>{row.environment ?? <Inconnu quoi="non connu" />}</dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>
            {row.destination
              ? <span className="pairing-host" title={row.destination}>{row.destination}</span>
              : <Inconnu quoi="non connue" />}
          </dd>
        </div>
        <div>
          <dt>Dernier contact</dt>
          <dd>{row.lastContactLabel ?? <Inconnu quoi="jamais" />}</dd>
        </div>
        <div>
          <dt>Données métier reçues</dt>
          <dd>
            {row.lastBusinessSyncAt
              ? formatDateTime(row.lastBusinessSyncAt)
              : <Inconnu quoi="jamais" />}
          </dd>
        </div>
      </dl>

      <div className="pairing-actions">
        {row.needsAttention ? (
          <span className="conn-flag" title="Cette fiche demande une action">
            <Icon name="plug" size={14} label="" />
            À vérifier
          </span>
        ) : null}
        <Link className="btn btn-secondary btn-small" to={manageLink(row.projectId)}>
          {row.paired ? 'Gérer' : 'Appairer'}
          <span className="sr-only"> {row.name}</span>
        </Link>
        {onChanged ? <ConnectionActions row={row} onDone={onChanged} /> : null}
      </div>
    </article>
  );
}

export default PairingRowItem;
