/**
 * REGISTRE CANONIQUE DES ÉTAPES DE DÉPLOIEMENT — source de vérité UNIQUE.
 *
 * ══ CE QUE CE FICHIER ÉTAIT, ET CE QUI LUI MANQUAIT ═════════════════════════
 *
 * Il portait déjà les identifiants, les libellés et l'ordre — et le moteur, le
 * rapport et l'historique en dérivaient correctement. Ce qui lui manquait, ce
 * sont les métadonnées dont l'INTERFACE a besoin : icône, groupe, visibilité,
 * mode d'exécution. Faute de les trouver ici, le Manager s'était constitué ses
 * propres listes — trois, exactement :
 *
 *   · `CHECKLIST_STEPS` : ids + libellés + icônes + ordre, recopiés à la main ;
 *   · `PRECHECK_STEPS`  : le sous-ensemble du préflight, avec des libellés
 *     DIFFÉRENTS pour les mêmes identifiants (`deployment.initialize` s'appelait
 *     « Préparation du déploiement » d'un côté et « Validation de la
 *     destination » de l'autre) ;
 *   · `PIPELINE_PHASES` / `PIPELINE_ORDER` : une quatrième liste, indexée cette
 *     fois par les identifiants BRUTS internes au pipeline (`dirs`, `certbot`,
 *     `reload`) — qui n'ont aucune raison d'être connus d'une interface.
 *
 * Une liste recopiée dérive. Celle-ci l'a fait : le moteur avait renommé
 * `dns.manager` en `dns.apps`, et l'écran a continué d'afficher une ligne qui ne
 * recevait plus jamais d'événement.
 *
 * ══ CE QU'IL EST DEVENU ═════════════════════════════════════════════════════
 *
 * La définition complète d'une étape, et rien d'autre. Le moteur l'émet, le
 * flux la valide, l'interface la demande (`GET /deployment/phases`), le rapport
 * la projette. Ajouter une étape = une entrée ici, et une seule.
 *
 * ══ CE QU'IL N'EST PAS ══════════════════════════════════════════════════════
 *
 * Il ne décrit pas les DIAGNOSTICS. `reasonCode`, `failingFile`, `candidatePath`,
 * `certbotVersion`, `restoreSucceeded` sont des données d'exécution : elles
 * voyagent dans les détails d'un événement, jamais comme des pseudo-étapes.
 * Confondre les deux ferait apparaître une ligne de checklist par cause
 * d'échec.
 */

/**
 * ══ LES ÉTATS D'UNE ÉTAPE — vocabulaire FERMÉ ═══════════════════════════════
 *
 * `warning` mérite d'être défendu : il n'est pas un `ok` timide. Une
 * vérification DNS peut aboutir tout en signalant une propagation incomplète ;
 * l'appeler `ok` masquerait un fait que l'exploitant doit voir, et `error`
 * arrêterait un déploiement parfaitement légitime.
 *
 * `cancelled` couvre l'interruption par l'opérateur, distincte d'un échec.
 *
 * @typedef {'pending'|'running'|'ok'|'warning'|'error'|'skipped'|'cancelled'} StepStatus
 */
export const STEP_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  OK: 'ok',
  WARNING: 'warning',
  ERROR: 'error',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
});

export const STEP_STATUS_VALUES = Object.freeze(Object.values(STEP_STATUS));

/**
 * LES MODES D'EXÉCUTION. Un préflight (`PRECHECK`) exécute le PROLOGUE d'un
 * déploiement puis s'arrête : c'est le même moteur, sur un sous-ensemble
 * d'étapes. Déclarer ce sous-ensemble ICI est ce qui permet à l'interface de
 * dériver DEUX checklists d'une seule définition — au lieu d'en recopier une
 * seconde, comme elle le faisait.
 */
export const RUN_MODES = Object.freeze({ DEPLOYMENT: 'DEPLOYMENT', PRECHECK: 'PRECHECK' });

const TOUS_MODES = [RUN_MODES.DEPLOYMENT, RUN_MODES.PRECHECK];
const DEPLOIEMENT_SEUL = [RUN_MODES.DEPLOYMENT];

/** Familles d'affichage — utilisées pour grouper, jamais pour décider. */
export const STEP_GROUPS = Object.freeze({
  LOCAL: 'local',
  NETWORK: 'network',
  REMOTE: 'remote',
  RELEASE: 'release',
  PUBLICATION: 'publication',
  RUNTIME: 'runtime',
  HEALTH: 'health',
});

const G = STEP_GROUPS;

/**
 * ══ LE CATALOGUE ════════════════════════════════════════════════════════════
 *
 * `order` est explicite et espacé de 10 : insérer une étape entre deux autres
 * ne doit pas obliger à renuméroter la liste entière — c'est exactement le
 * genre de modification en cascade qu'on finit par faire à moitié.
 *
 * L'ORDRE DE CETTE LISTE EST CELUI DE L'EXÉCUTION. Deux successions ne sont pas
 * négociables et portent leur raison :
 *
 *   · `media.adopt` avant `media.publish` — publier ne voit que ce qui est
 *     décrit, et un parc historique ne l'est pas ;
 *   · `public.healthcheck` avant `runtime.sync` — constater avant de publier la
 *     configuration réseau. L'inverse a déjà fait pointer une vitrine saine
 *     vers un backend en échec.
 *
 * `precheckLabel` existe pour une seule raison : en préflight, « Préparation du
 * déploiement » serait mensonger — rien n'est déployé. Le libellé alternatif est
 * DÉCLARÉ ici plutôt que réinventé par un écran.
 */
export const CANONICAL_STEPS = Object.freeze([
  {
    id: 'deployment.initialize',
    order: 10,
    label: 'Préparation du déploiement',
    precheckLabel: 'Validation de la destination',
    icon: 'Wand2',
    group: G.LOCAL,
    modes: TOUS_MODES,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  /* --- Domaine (fournisseur DNS). Mutations APRÈS la connexion SSH. ------- */
  {
    id: 'dns.zone',
    order: 20,
    label: 'Détection du domaine',
    icon: 'Globe',
    group: G.NETWORK,
    modes: TOUS_MODES,
    critical: true,
    /**
     * CONDITIONNELLE, ET C'EST LE CAS LE PLUS INSTRUCTIF DU REGISTRE.
     *
     * Sans fournisseur DNS configuré, la gestion automatique du domaine n'a pas
     * lieu : ces trois étapes sont `skipped`, avec leur raison. Les déclarer
     * `required` ferait échouer tout déploiement sur un domaine géré à la main
     * — c'est-à-dire la majorité des premiers déploiements.
     */
    required: false,
    conditional: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'dns.provider',
    order: 30,
    label: 'Connexion au gestionnaire de domaine',
    icon: 'Server',
    group: G.NETWORK,
    modes: TOUS_MODES,
    critical: true,
    required: false,
    conditional: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'dns.read',
    order: 40,
    label: 'Lecture de la configuration du domaine',
    icon: 'Database',
    group: G.NETWORK,
    modes: TOUS_MODES,
    critical: true,
    required: false,
    conditional: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'ssh.connect',
    order: 50,
    label: 'Connexion sécurisée au serveur',
    icon: 'Server',
    group: G.REMOTE,
    modes: TOUS_MODES,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'server.preflight',
    order: 60,
    label: 'Vérification des prérequis du serveur',
    precheckLabel: 'Vérification du serveur',
    icon: 'ShieldCheck',
    group: G.REMOTE,
    modes: TOUS_MODES,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'remote.safety',
    order: 70,
    label: 'Vérification de sécurité de la destination',
    precheckLabel: 'Vérification de la destination',
    icon: 'ShieldCheck',
    group: G.REMOTE,
    modes: TOUS_MODES,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'dns.site',
    order: 80,
    label: 'Préparation de l’adresse du site',
    icon: 'Globe',
    group: G.NETWORK,
    modes: TOUS_MODES,
    critical: true,
    required: false,
    conditional: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'dns.apps',
    order: 90,
    label: 'Préparation des adresses des applications',
    icon: 'Settings2',
    group: G.NETWORK,
    modes: TOUS_MODES,
    critical: true,
    required: false,
    conditional: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'dns.verify',
    order: 100,
    label: 'Vérification de la disponibilité des adresses',
    icon: 'BadgeCheck',
    group: G.NETWORK,
    modes: TOUS_MODES,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  /* --- À partir d'ici : déploiement réel uniquement. --------------------- */
  {
    id: 'artifact.build',
    order: 110,
    label: 'Préparation de la nouvelle version',
    icon: 'Wand2',
    group: G.LOCAL,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    /**
     * ══ LA FRONTIÈRE DE PUBLICATION EST ICI, ET C'EST UNE CORRECTION ═════════
     *
     * Elle était portée par « Activation HTTPS » — le moment où la nouvelle
     * version devient joignable de l'extérieur sur un PREMIER déploiement.
     * C'est vrai, et insuffisant : sur un REDÉPLOIEMENT, Nginx sert déjà la
     * racine du site, et la BASCULE de release (`release.swap`, à l'intérieur
     * de cette étape) change instantanément ce que voit le public.
     *
     * La frontière doit être la PREMIÈRE mutation observable, pas la plus
     * visible. Placer une barrière après elle laisserait publier avant de
     * savoir écrire ce qu'on publie — exactement le défaut que ce lot ferme.
     *
     * `https.configure` conserve sa qualité propre (`publicActivation`) : c'est
     * elle qui rend le site joignable en HTTPS, et le rapport en a besoin pour
     * distinguer les deux instants.
     */
    id: 'artifact.upload',
    order: 120,
    label: 'Transfert du projet',
    icon: 'CloudUpload',
    group: G.RELEASE,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
    publicationBoundary: true,
  },
  {
    id: 'dependencies.install',
    order: 130,
    label: 'Installation & configuration',
    icon: 'FolderCog',
    group: G.RELEASE,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'uploads.migrate',
    order: 140,
    label: 'Migration des médias persistants',
    icon: 'FolderCog',
    group: G.RELEASE,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'media.adopt',
    order: 150,
    label: 'Reprise des médias existants',
    icon: 'FolderCog',
    group: G.RELEASE,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'nginx.configure',
    order: 160,
    label: 'Configuration du routage web',
    icon: 'Globe',
    group: G.PUBLICATION,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    /**
     * L'ACTIVATION PUBLIQUE — joignable de l'extérieur, en HTTPS.
     *
     * Ce n'est plus la frontière de publication (voir `artifact.upload`), mais
     * elle reste un instant distinct qui mérite son nom : c'est ici que le
     * certificat est posé et la configuration complète rechargée. Un premier
     * déploiement n'est visible du public qu'à partir de cette étape.
     */
    id: 'https.configure',
    order: 170,
    label: 'Activation HTTPS',
    icon: 'ShieldCheck',
    group: G.PUBLICATION,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
    publicActivation: true,
  },
  {
    id: 'services.start',
    order: 180,
    label: 'Démarrage des services',
    icon: 'Rocket',
    group: G.RUNTIME,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'services.verify',
    order: 190,
    label: 'Vérification des services',
    icon: 'Activity',
    group: G.HEALTH,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'media.publish',
    order: 200,
    label: 'Publication des médias',
    icon: 'FolderCheck',
    group: G.RELEASE,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'public.healthcheck',
    order: 210,
    label: 'Vérification publique finale',
    icon: 'BadgeCheck',
    group: G.HEALTH,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'runtime.sync',
    order: 220,
    label: 'Synchronisation de la configuration réseau',
    icon: 'RefreshCw',
    group: G.RUNTIME,
    modes: DEPLOIEMENT_SEUL,
    critical: true,
    required: true,
    blocking: true,
    visible: true,
  },
  {
    id: 'deployment.finalize',
    order: 230,
    label: 'Finalisation',
    precheckLabel: 'Validation finale',
    icon: 'BadgeCheck',
    group: G.LOCAL,
    modes: TOUS_MODES,
    critical: false,
    required: true,
    blocking: false,
    visible: true,
  },
]);

export const CANONICAL_ORDER = CANONICAL_STEPS.map((s) => s.id);
const BY_ID = new Map(CANONICAL_STEPS.map((s) => [s.id, s]));

export function canonicalStep(id) {
  return BY_ID.get(id) || { id, label: id, critical: false, required: false, visible: true };
}

export function isKnownStep(id) {
  return BY_ID.has(id);
}

/**
 * Refuse une étape hors registre, AU POINT D'ÉMISSION. Un identifiant inventé
 * doit faire échouer le déploiement qui l'invente — pas s'évanouir dans une
 * interface incapable de savoir qu'elle attend quelque chose qui n'arrivera
 * jamais.
 */
export function assertKnownStep(id) {
  const meta = BY_ID.get(id);
  if (!meta) {
    throw new Error(
      `Étape de déploiement inconnue : « ${id} ». Déclarez-la dans `
        + 'deployment-engine/steps.js — nulle part ailleurs.'
    );
  }
  return meta;
}

export function assertKnownStatus(status) {
  if (!STEP_STATUS_VALUES.includes(status)) {
    throw new Error(
      `Statut d'étape inconnu : « ${status} ». Attendu : ${STEP_STATUS_VALUES.join(' | ')}.`
    );
  }
  return status;
}

/** Les étapes applicables à un mode d'exécution, dans l'ordre canonique. */
export function stepsForMode(mode = RUN_MODES.DEPLOYMENT) {
  return CANONICAL_STEPS.filter((s) => s.modes.includes(mode));
}

/**
 * LA PROJECTION PUBLIQUE — ce que l'interface consomme.
 *
 * Volontairement pauvre : ni commande, ni chemin, ni diagnostic. Une définition
 * d'étape ne doit rien apprendre à qui la lit sur l'infrastructure qui
 * l'exécute.
 */
export function describeDeploymentSteps() {
  return CANONICAL_STEPS.map((s) => ({
    id: s.id,
    order: s.order,
    label: s.label,
    ...(s.precheckLabel ? { precheckLabel: s.precheckLabel } : {}),
    icon: s.icon,
    group: s.group,
    modes: [...s.modes],
    required: Boolean(s.required),
    blocking: Boolean(s.blocking),
    visible: Boolean(s.visible),
    ...(s.conditional ? { conditional: true } : {}),
    ...(s.publicationBoundary ? { publicationBoundary: true } : {}),
    ...(s.publicActivation ? { publicActivation: true } : {}),
  }));
}

/**
 * Projection des identifiants BRUTS du pipeline vers les identifiants
 * canoniques.
 *
 * ── POURQUOI CETTE TABLE SURVIT ────────────────────────────────────────────
 *
 * Le pipeline distant nomme ses opérations par ce qu'elles FONT sur la machine
 * (`dirs`, `certbot`, `reload`), et plusieurs d'entre elles composent une seule
 * étape visible : `certbot` et `reload` sont deux gestes d'une même « Activation
 * HTTPS ». Cette table est donc une TRADUCTION, pas une seconde liste — elle
 * n'introduit aucun identifiant que le registre ne déclare, et un test le
 * vérifie.
 */
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
  // La bascule de configuration complète + reload appartient à l'activation
  // HTTPS, APRÈS l'émission des certificats.
  reload: 'https.configure',
  pm2: 'services.start',
  health: 'services.verify',
  validate: 'public.healthcheck',
  finalize: 'deployment.finalize',
};

/**
 * ══ LA FRONTIÈRE DE PUBLICATION — une seule définition, dérivée du registre ══
 *
 * Elle répond à une question précise : à partir de quelle étape la nouvelle
 * version peut-elle être observée par quelqu'un d'autre que le déployeur ?
 *
 * Tout ce qui précède est RÉVERSIBLE sans que personne ne l'ait vu : on peut
 * s'arrêter, la version précédente continue de servir. Tout ce qui suit a déjà
 * changé le monde — s'arrêter ne le défait pas.
 *
 * Le reste du moteur ne doit pas réinventer cette notion : il la DEMANDE.
 */
export function publicationBoundaryStep() {
  return CANONICAL_STEPS.find((s) => s.publicationBoundary) || null;
}

/** L'étape appartient-elle à la zone AVANT publication (donc réversible) ? */
export function isBeforePublication(stepId) {
  const frontiere = publicationBoundaryStep();
  const etape = canonicalStep(stepId);
  if (!frontiere || !etape?.order) return true;
  return etape.order < frontiere.order;
}

/**
 * ══ CE QU'ON PEUT AFFIRMER D'UNE PUBLICATION, À PARTIR DES SEULES ÉTAPES ════
 *
 * Il y a trois vérités possibles, et les confondre est exactement le mensonge
 * que ce lot interdit :
 *
 *   NOT_REACHED — la frontière n'a jamais été atteinte. Personne n'a rien vu
 *                 changer ; on peut dire « rien n'a été publié ».
 *   POSSIBLE    — la bascule a COMMENCÉ et son issue n'est pas connue (elle a
 *                 échoué en cours, ou le process est mort dedans). On ne sait
 *                 pas, et prétendre le contraire dans un sens ou dans l'autre
 *                 serait inventé.
 *   OCCURRED    — la bascule s'est terminée. La nouvelle version est servie,
 *                 même si tout ce qui suit a échoué.
 *
 * Rien ici ne devine : on lit le statut de l'étape frontière, et lui seul.
 */
export const PUBLICATION = Object.freeze({
  NOT_REACHED: 'NOT_REACHED',
  POSSIBLE: 'POSSIBLE',
  OCCURRED: 'OCCURRED',
});

/**
 * Les codes qui signent un REFUS DE PUBLIER, prononcé avant toute commande.
 *
 * L'étape frontière porte alors le statut `error` sans avoir rien tenté : la
 * barrière l'ouvre et la referme pour que le rapport nomme l'endroit exact où
 * le déploiement s'est arrêté. Sans cette liste, ce refus serait lu comme « la
 * bascule a commencé et on ne sait pas où elle s'est arrêtée » — c'est-à-dire
 * l'inquiétude maximale pour la situation la plus sûre.
 */
const REFUS_AVANT_TENTATIVE = new Set([
  'DEPLOYMENT_RECORDER_WRITE_FAILED',
  'DEPLOYMENT_RECORDER_UNAVAILABLE',
]);

export function publicationVerdict(steps = []) {
  const frontiere = publicationBoundaryStep();
  const vue = (steps || []).find((s) => (s?.id ?? s?.stepId) === frontiere?.id);
  const statut = vue?.status ?? null;

  const etat = !frontiere || !statut || statut === 'pending' || statut === 'skipped'
    ? PUBLICATION.NOT_REACHED
    : (statut === 'ok' || statut === 'warning')
      ? PUBLICATION.OCCURRED
      : REFUS_AVANT_TENTATIVE.has(vue?.errorCode)
        ? PUBLICATION.NOT_REACHED
        : PUBLICATION.POSSIBLE;

  return { state: etat, boundaryStepId: frontiere?.id ?? null, boundaryStatus: statut };
}

export function toCanonical(rawId) {
  return RAW_TO_CANONICAL[rawId] || rawId;
}

/**
 * ══ LE DERNIER GESTE BRUT D'UNE ÉTAPE COMPOSÉE ══════════════════════════════
 *
 * `certbot` (émission du certificat) puis `reload` (bascule de la configuration
 * complète) composent une seule étape visible : « Activation HTTPS ».
 *
 * ── LE DÉFAUT QUE CETTE FONCTION FERME ─────────────────────────────────────
 *
 * Le moteur dédoublonnait les DÉPARTS (un seul `running` par étape visible)
 * mais émettait un `ok` à CHAQUE geste brut terminé. L'étape était donc
 * déclarée réussie dès la fin de `certbot` — c'est-à-dire AVANT que la
 * configuration ne soit appliquée. Si `reload` échouait ensuite, l'écran
 * affichait successivement « Activation HTTPS ✔ » puis « Activation HTTPS ✘ »
 * sur la même ligne, et le rapport gardait les deux.
 *
 * Une étape composée n'est réussie qu'au dernier de ses gestes. L'ordre du
 * pipeline étant DÉCLARÉ (`PIPELINE_STEPS`), « le dernier » est une donnée, pas
 * une devinette.
 *
 * @param {string} rawId        le geste brut qui vient de se terminer
 * @param {string[]} rawOrder   l'ordre déclaré des gestes du pipeline
 * @returns {boolean} vrai si ce geste CLÔT l'étape visible correspondante
 */
export function isLastRawOfStep(rawId, rawOrder) {
  const canonical = toCanonical(rawId);
  const freres = rawOrder.filter((r) => toCanonical(r) === canonical);
  return freres.length === 0 || freres[freres.length - 1] === rawId;
}

export default {
  CANONICAL_STEPS,
  CANONICAL_ORDER,
  STEP_STATUS,
  STEP_STATUS_VALUES,
  STEP_GROUPS,
  RUN_MODES,
  RAW_TO_CANONICAL,
  toCanonical,
  isLastRawOfStep,
  publicationBoundaryStep,
  publicationVerdict,
  PUBLICATION,
  isBeforePublication,
  canonicalStep,
  isKnownStep,
  assertKnownStep,
  assertKnownStatus,
  stepsForMode,
  describeDeploymentSteps,
};
