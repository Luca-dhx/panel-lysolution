/**
 * BANDEAU DE FRAÎCHEUR — ce que l'écran doit dire AVANT tout le reste.
 *
 * ── POURQUOI EN TÊTE DE FICHE ───────────────────────────────────────────────
 * L'information « ce projet ne répond plus » vivait dans une pastille grise au
 * milieu des autres, et « ces données viennent d'un autre environnement »
 * n'existait nulle part. On lisait donc un contrat « Actif », une équipe, une
 * identité — tout cela présenté comme l'état du jour, alors que le projet avait
 * été redéployé en TEST et son contrat résilié.
 *
 * Un bandeau ne remplace pas ces informations : il les DATE. Les données
 * restent consultables, comme un historique assumé.
 */
import { Icon } from '@/components/Icon';
import { formatDateTime } from '@/lib/format';
import type { ProjectDataFreshness } from '@/lib/projectFreshness';

const quand = (iso: string | null) => (iso ? formatDateTime(iso) : 'jamais');

export function FreshnessBanner({ fraicheur }: { fraicheur: ProjectDataFreshness }) {
  if (fraicheur.isBusinessDataFresh) return null;

  /**
   * TROIS SITUATIONS, ET ELLES NE SE DISENT PAS PAREIL.
   *
   * ── LE MOT QUI MENTAIT ────────────────────────────────────────────────────
   * Un changement de GÉNÉRATION affichait « Données de l'environnement
   * précédent », puis listait deux environnements identiques — TEST et TEST.
   * Le lecteur cherchait un changement d'environnement qui n'avait pas eu lieu.
   *
   * Une génération, ce sont trois choses : l'environnement, l'appairage, et le
   * domaine. Deux instances SUCCESSIVES du même environnement changent les deux
   * dernières sans toucher la première — c'est le cas d'un redéploiement ou
   * d'un déménagement de domaine. On le nomme pour ce qu'il est.
   */
  const conflitEnv = fraicheur.isEnvironmentMismatch;
  const conflitInstance = !conflitEnv && fraicheur.isGenerationMismatch;
  const conflit = conflitEnv || conflitInstance;

  const titre = conflitEnv
    ? 'Données d’un autre environnement'
    : conflitInstance
      ? 'Données de l’instance précédente'
      : 'Projet actuellement injoignable';

  return (
    <div className={conflit ? 'freshness-banner freshness-banner-danger' : 'freshness-banner'}>
      <span className="freshness-banner-icon">
        <Icon name="plug" size={22} label="Avertissement" />
      </span>
      <div className="freshness-banner-body">
        <p className="freshness-banner-title">{titre}</p>
        <p>
          {conflitEnv ? (
            <>
              Ces informations ont été synchronisées depuis{' '}
              <strong>{fraicheur.projectionEnvironment ?? 'un autre environnement'}</strong>, alors
              que ce projet déclare aujourd’hui{' '}
              <strong>{fraicheur.runtimeEnvironment ?? 'un environnement inconnu'}</strong>. Elles
              ne décrivent plus ce qui est en ligne.
            </>
          ) : conflitInstance ? (
            <>
              Le déploiement{' '}
              <strong>{fraicheur.runtimeEnvironment ?? 'actuel'}</strong> est connecté, mais il n’a
              pas encore transmis sa photographie complète. Certaines informations affichées
              proviennent encore de l’instance{' '}
              {fraicheur.projectionEnvironment ?? ''} précédente.
            </>
          ) : (
            'Les informations affichées ci-dessous peuvent être obsolètes.'
          )}
        </p>
        <dl className="freshness-banner-facts">
          <div>
            <dt>Dernier contact</dt>
            <dd>{quand(fraicheur.lastContactAt)}</dd>
          </div>
          <div>
            <dt>Dernière photographie reçue</dt>
            <dd>{quand(fraicheur.lastFullSyncAt)}</dd>
          </div>
          <div>
            <dt>Environnement de la dernière photographie</dt>
            <dd>{fraicheur.projectionEnvironment ?? 'inconnu'}</dd>
          </div>
          <div>
            <dt>Environnement actuellement déclaré</dt>
            <dd>{fraicheur.runtimeEnvironment ?? 'inconnu'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/**
 * Marque une valeur métier dont on ne peut plus affirmer qu'elle est actuelle.
 * La valeur reste lisible — c'est le dernier état CONNU, et il est utile.
 */
export function DernierEtatConnu({
  fraicheur,
  children,
  attente,
}: {
  fraicheur: ProjectDataFreshness;
  children: React.ReactNode;
  /** Ce qu'on dit quand la nouvelle instance n'a encore rien envoyé. */
  attente?: string;
}) {
  if (fraicheur.isBusinessDataFresh) return <>{children}</>;

  const conflit = fraicheur.isEnvironmentMismatch || fraicheur.isGenerationMismatch;
  return (
    <span className="stale-value">
      {conflit && attente ? (
        <span className="stale-value-waiting">{attente}</span>
      ) : null}
      <span className="stale-value-label">
        Dernier état connu
        {/* « en TEST » n'a de sens que si l'ENVIRONNEMENT diffère. Sur un
            changement d'instance, les deux valent TEST : le préciser laissait
            croire à un désaccord d'environnement inexistant. */}
        {fraicheur.isEnvironmentMismatch && fraicheur.projectionEnvironment
          ? ` en ${fraicheur.projectionEnvironment}`
          : ''}
        {' : '}
      </span>
      {children}
      <span className="badge badge-muted stale-value-badge">Donnée potentiellement obsolète</span>
    </span>
  );
}

export default FreshnessBanner;
