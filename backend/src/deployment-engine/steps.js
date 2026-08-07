/**
 * Catalogue CANONIQUE des étapes de déploiement.
 *
 * Stable, typé, partagé par le backend, le flux NDJSON, le frontend,
 * l'historique et le rapport. Chaque étape correspond à une action RÉELLEMENT
 * exécutée par le pipeline — aucune étape fictive marquée réussie sans action.
 *
 * Le pipeline interne émet des identifiants « bruts » (upload, dirs, nginx…) ;
 * on les projette sur ces identifiants canoniques via RAW_TO_CANONICAL.
 */

/** @typedef {'pending'|'running'|'ok'|'warning'|'error'|'skipped'|'cancelled'} StepStatus */

export const CANONICAL_STEPS = [
  { id: 'deployment.initialize', label: 'Préparation du déploiement', critical: true },
  // --- Phase DNS (fournisseur, ex. Hostinger). Mutations APRÈS la connexion SSH. ---
  { id: 'dns.zone', label: 'Détection du domaine', critical: true },
  { id: 'dns.provider', label: 'Connexion au gestionnaire de domaine', critical: true },
  { id: 'dns.read', label: 'Lecture de la configuration du domaine', critical: true },
  { id: 'ssh.connect', label: 'Connexion sécurisée au serveur', critical: true },
  { id: 'server.preflight', label: 'Vérification des prérequis du serveur', critical: true },
  { id: 'remote.safety', label: 'Vérification de sécurité de la destination', critical: true },
  { id: 'dns.site', label: 'Préparation de l’adresse du site', critical: true },
  { id: 'dns.apps', label: 'Préparation des adresses des applications', critical: true },
  { id: 'dns.verify', label: 'Vérification de la disponibilité des adresses', critical: true },
  { id: 'artifact.build', label: 'Préparation de la nouvelle version', critical: true },
  { id: 'artifact.upload', label: 'Transfert du projet', critical: true },
  { id: 'dependencies.install', label: 'Installation & configuration', critical: true },
  { id: 'uploads.migrate', label: 'Migration des médias persistants', critical: true },
  /**
   * REPRISE puis PUBLICATION — deux actes distincts, dans cet ordre.
   *
   * `media.adopt` DÉCRIT, sur la destination, les médias qui n'avaient encore
   * aucun descripteur : ils n'existaient que comme chemins dans des fiches.
   * `media.publish` CONSTATE ensuite lesquels sont réellement servis. Publier
   * ne peut pas précéder décrire : la publication ne voit que ce qui est
   * décrit, et un parc historique ne l'est pas.
   */
  { id: 'media.adopt', label: 'Reprise des médias existants', critical: true },
  { id: 'nginx.configure', label: 'Configuration du routage web', critical: true },
  { id: 'https.configure', label: 'Activation HTTPS', critical: true },
  { id: 'services.start', label: 'Démarrage des services', critical: true },
  { id: 'services.verify', label: 'Vérification des services', critical: true },
  { id: 'media.publish', label: 'Publication des médias', critical: true },
  /**
   * L'ORDRE DE CETTE LISTE EST CELUI DE L'EXÉCUTION — il pilote l'affichage, le
   * rapport et l'historique.
   *
   * `runtime.sync` PUBLIE la configuration réseau canonique, partagée avec les
   * emplacements antérieurs du projet ; `public.healthcheck` CONSTATE que la
   * nouvelle destination est saine. Publier ne peut pas précéder constater :
   * quand c'était le cas, un déploiement qui échouait avait déjà fait pointer
   * l'ancienne vitrine, restée saine, vers un backend en échec.
   */
  { id: 'public.healthcheck', label: 'Vérification publique finale', critical: true },
  { id: 'runtime.sync', label: 'Synchronisation de la configuration réseau', critical: true },
  { id: 'deployment.finalize', label: 'Finalisation', critical: false },
];

export const CANONICAL_ORDER = CANONICAL_STEPS.map((s) => s.id);
const BY_ID = new Map(CANONICAL_STEPS.map((s) => [s.id, s]));

export function canonicalStep(id) {
  return BY_ID.get(id) || { id, label: id, critical: false };
}

/** Projection des identifiants bruts du pipeline vers les identifiants canoniques. */
export const RAW_TO_CANONICAL = {
  // Phase préflight (émise depuis les groupes de contrôles).
  ssh: 'ssh.connect',
  preflight: 'server.preflight',
  occupied: 'remote.safety',
  dns: 'dns.verify',
  'host-cert': 'https.configure',
  // Build local.
  build: 'artifact.build',
  // Pipeline distant.
  upload: 'artifact.upload',
  dirs: 'dependencies.install',
  uploads_migrate: 'uploads.migrate',
  project_media_adopt: 'media.adopt',
  media_publish: 'media.publish',
  nginx: 'nginx.configure',
  certbot: 'https.configure',
  runtime_config: 'runtime.sync',
  // La phase HTTPS (bascule config complète + reload) fait partie de l'activation
  // HTTPS, APRÈS l'émission des certificats — projetée sur https.configure.
  reload: 'https.configure',
  pm2: 'services.start',
  health: 'services.verify',
  validate: 'public.healthcheck',
  finalize: 'deployment.finalize',
};

export function toCanonical(rawId) {
  return RAW_TO_CANONICAL[rawId] || rawId;
}

export default { CANONICAL_STEPS, CANONICAL_ORDER, RAW_TO_CANONICAL, toCanonical, canonicalStep };
