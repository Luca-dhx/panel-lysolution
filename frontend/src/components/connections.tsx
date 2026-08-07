/**
 * LES CONNEXIONS D'UN PROJET — les briques d'affichage, et rien d'autre.
 *
 * ══ CE QUE CES COMPOSANTS NE FONT PAS ═══════════════════════════════════════
 *
 * Ils ne décident rien. L'état d'une connexion, son besoin d'action, son
 * regroupement : tout est calculé par `projectConnections.ts`, à partir des
 * verdicts que le backend publie. Ici on met en forme.
 *
 * C'est ce qui permet de tester la règle sans monter React, et de la corriger
 * à un seul endroit — plutôt qu'au fil de conditionnelles dispersées dans le
 * JSX, comme le faisait la table d'appairages.
 */
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { formatDateTime } from '@/lib/format';
import { ConnectionActions } from '@/components/ConnectionActions';
import {
  connectionLink, pairEnvironmentLink,
  type EnvironmentConnection, type ProjectGroup,
} from '@/lib/projectConnections';

/**
 * LE POINT D'ÉTAT — couleur ET forme ET texte.
 *
 * Un statut porté par la seule couleur est invisible pour une partie des
 * lecteurs. Le symbole (plein, à demi, vide) le double, et le libellé le dit
 * en toutes lettres. Le point lui-même est décoratif : il est retiré de l'arbre
 * d'accessibilité pour ne pas faire lire « rond noir » avant le mot utile.
 */
export function ConnectionStatusDot({ connection }: { connection: EnvironmentConnection }) {
  return (
    <span className={`conn-dot conn-dot-${connection.state.tone}`} aria-hidden="true">
      {connection.state.symbol}
    </span>
  );
}

/**
 * UNE LIGNE D'ENVIRONNEMENT — l'unité de lecture de toute la refonte.
 *
 * L'ordre est celui de la hiérarchie demandée : l'environnement, l'état, le
 * domaine, puis le reste. Rien de technique ici : ni identifiant, ni jeton, ni
 * génération. Ils vivent dans le repli « Informations techniques ».
 */
export function EnvironmentConnectionRow({
  connection,
  group,
  compact = false,
  onChanged,
}: {
  connection: EnvironmentConnection;
  group: ProjectGroup;
  /** La page Appairages resserre ; la fiche projet respire. */
  compact?: boolean;
  /**
   * Les actions secondaires (code, révocation) ne sont proposées QUE si
   * l'écran sait se rafraîchir ensuite. Une action dont on ne voit pas l'effet
   * pousse à la rejouer — et révoquer deux fois n'est pas anodin.
   */
  onChanged?: () => Promise<void> | void;
}) {
  const { environment, state, project } = connection;
  const absent = state.status === 'ABSENT';

  return (
    <div className={absent ? 'conn-row conn-row-absent' : 'conn-row'}>
      <div className="conn-row-head">
        <span className="conn-env">{environment}</span>
        <span className="conn-state">
          <ConnectionStatusDot connection={connection} />
          <span className={`conn-state-label conn-state-${state.tone}`}>{state.label}</span>
        </span>
      </div>

      {connection.host ? (
        <a
          className="conn-host"
          href={connection.host}
          target="_blank"
          rel="noreferrer"
          title={connection.host}
        >
          {connection.host.replace(/^https?:\/\//, '')}
        </a>
      ) : (
        <p className="conn-host conn-host-empty">
          {absent ? 'Aucune instance connectée' : 'Adresse inconnue'}
        </p>
      )}

      {!compact && project ? (
        <dl className="conn-facts">
          <div>
            <dt>Dernier contact</dt>
            <dd>{connection.lastContactLabel ?? 'jamais'}</dd>
          </div>
          <div>
            <dt>Dernière photographie reçue</dt>
            <dd>
              {connection.lastSnapshotAt ? formatDateTime(connection.lastSnapshotAt) : 'jamais'}
            </dd>
          </div>
        </dl>
      ) : null}

      {compact && project && connection.lastContactLabel ? (
        <p className="conn-meta">Dernier contact {connection.lastContactLabel}</p>
      ) : null}

      <div className="conn-actions">
        {project ? (
          <>
            <Link
              className="btn btn-secondary btn-small"
              to={connectionLink(project.projectId, environment)}
            >
              Gérer
              <span className="sr-only"> la connexion {environment} de {group.name}</span>
            </Link>
            {onChanged ? (
              <ConnectionActions
                connection={connection}
                projectName={group.name}
                onDone={onChanged}
              />
            ) : null}
          </>
        ) : (
          <Link
            className="btn btn-secondary btn-small"
            to={pairEnvironmentLink(
              environment,
              group.projects[0]?.logicalProjectKey ?? null,
              group.name,
            )}
          >
            Appairer {environment === 'PROD' ? 'la production' : 'la recette'}
            <span className="sr-only"> pour {group.name}</span>
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * UNE CARTE = UN PROJET. C'est toute la refonte tenue en une phrase.
 *
 * L'ancienne table alignait des lignes d'appairage : deux instances d'un même
 * client y apparaissaient comme deux projets sans rapport. Ici le projet est
 * l'objet, et ses environnements sont ses connexions.
 */
export function ProjectConnectionsCard({
  group,
  onChanged,
}: {
  group: ProjectGroup;
  onChanged?: () => Promise<void> | void;
}) {
  return (
    <article className="conn-card" aria-labelledby={`conn-${group.key}`}>
      <header className="conn-card-head">
        <div className="conn-card-identity">
          <h2 className="conn-card-name" id={`conn-${group.key}`}>{group.name}</h2>
          {group.tagline ? <p className="conn-card-tagline">{group.tagline}</p> : null}
        </div>
        {group.needsAttention ? (
          <span className="conn-flag" title="Une connexion demande une action">
            <Icon name="plug" size={14} label="" />
            À vérifier
          </span>
        ) : null}
      </header>

      <div className="conn-card-body">
        {group.connections.map((c) => (
          <EnvironmentConnectionRow
            key={c.environment}
            connection={c}
            group={group}
            compact
            onChanged={onChanged}
          />
        ))}
      </div>
    </article>
  );
}

export default ProjectConnectionsCard;
