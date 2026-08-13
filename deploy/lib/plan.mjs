/**
 * LA SIMULATION — et elle décrit le MOTEUR, pas une seconde idée du déploiement.
 *
 * ══ CE QUE CE FICHIER A CESSÉ D'ÊTRE (R10.1) ════════════════════════════════
 *
 * Il portait une liste d'étapes et de commandes shell écrites À LA MAIN :
 * `releases/<id>`, un lien `current`, une purge `releases.prune`. Rien de tout
 * cela n'existe côté exécution. `deploy.mjs` ne s'en sert que pour AFFICHER un
 * plan ; l'exécution réelle (`--execute`) délègue intégralement au
 * `DeploymentEngine`, dont le pipeline uploade dans un `backend/` STABLE et
 * publie les SPA par bascule `.next` → `.prev`.
 *
 * Les deux descriptions avaient donc divergé, et la simulation montrait une
 * fiction à qui s'apprêtait à déployer. Ce n'est pas une inexactitude
 * cosmétique : un audit pré-déploiement s'est appuyé dessus et a conclu à une
 * perte de données inexistante (voir POST_MIGRATION_PRE_DEPLOYMENT_AUDIT §AH).
 *
 * ══ LA RÈGLE MAINTENANT ═════════════════════════════════════════════════════
 *
 * Ce module ne DÉCRIT plus le déploiement : il le LIT. Les étapes viennent de
 * `PIPELINE_STEPS`, les chemins de `planTopology()` — les deux autorités que
 * l'exécution emploie réellement. Une étape ajoutée au moteur apparaît ici sans
 * qu'on y touche ; une étape retirée en disparaît. La divergence n'est plus
 * possible, parce qu'il n'y a plus deux sources.
 *
 * Ce module n'invente donc AUCUNE commande shell. Il ne les possède pas : elles
 * vivent dans le pipeline, qui les compose à partir du transport et de la
 * topologie. Prétendre les recopier ici recréerait exactement le défaut qu'on
 * vient de fermer.
 */
import { PIPELINE_STEPS } from '../../backend/src/deployment-engine/pipeline.js';
import { planTopology } from '../../backend/src/deployment-engine/topology.js';

/**
 * Ce que chaque étape du moteur fait, en une phrase.
 *
 * Un libellé MANQUANT n'est pas une erreur : l'étape s'affiche quand même, avec
 * son identifiant. Un moteur qui gagne une étape ne doit pas casser sa propre
 * simulation — il doit la montrer, fût-ce sans commentaire.
 */
const STEP_LABELS = Object.freeze({
  upload: 'Uploader l’artefact — SPA vers `.next`, backend vers son dossier stable',
  dirs: 'Lier `uploads` et `storage` au partagé persistant, écrire puis RELIRE le `.env`',
  uploads_migrate: 'Reprendre les médias de l’ancienne destination, s’il y en a',
  project_media_adopt: 'Adopter les médias déjà présents sur la destination',
  nginx: 'Installer la configuration Nginx',
  certbot: 'Obtenir ou renouveler les certificats Let’s Encrypt',
  reload: 'Recharger Nginx',
  pm2: 'Démarrer ou recharger le backend sous PM2',
  health: 'Contrôler la santé locale puis publique',
  media_publish: 'Publier les médias publics sur la destination',
  validate: 'Constater l’état réellement servi',
  runtime_config: 'Écrire le domaine choisi dans la configuration système',
});

/**
 * Les étapes LOCALES, bloquantes, exécutées avant toute action distante : on ne
 * déploie jamais un artefact qui n'a pas passé la chaîne complète.
 */
export const LOCAL_QUALITY_COMMANDS = Object.freeze({
  'quality.lint': { cwd: 'frontend', command: 'npm run lint' },
  'quality.typecheck': { cwd: 'frontend', command: 'npm run typecheck' },
  'quality.tests': { cwd: 'backend', command: 'npm test' },
  'artifact.build': { cwd: 'frontend', command: 'npm run build' },
});

/**
 * L'ORDRE COMPLET, dérivé — jamais recopié.
 *
 * Les étapes locales d'abord (elles n'appartiennent qu'au CLI), puis celles du
 * moteur, dans SON ordre.
 */
export const STEPS = Object.freeze([
  ...Object.keys(LOCAL_QUALITY_COMMANDS),
  ...PIPELINE_STEPS,
]);

/**
 * LES CHEMINS RÉELS de la destination, lus dans la topologie du moteur.
 *
 * ══ POURQUOI `storage` FIGURE EXPLICITEMENT ═══════════════════════════════
 *
 * Parce que c'est la question qu'un opérateur se pose avant de redéployer :
 * « mes justificatifs survivent-ils ? ». La réponse est un lien, et un lien
 * s'affiche. Le laisser implicite est précisément ce qui a permis de croire
 * qu'il n'existait pas.
 */
export function describeRemoteLayout(deployConfig) {
  const topo = planTopology({
    host: deployConfig.host,
    remoteRoot: deployConfig.remoteRoot,
  });
  return {
    siteRoot: topo.siteRoot,
    backendDir: topo.backendDir,
    sharedRoot: topo.sharedRoot,
    sharedUploads: topo.sharedUploads,
    /** Le partagé privé — cible du lien `backend/storage` posé à chaque déploiement. */
    sharedStorage: `${topo.sharedRoot}/storage`,
    /** Les liens que le pipeline (re)pose à chaque passage, étape `dirs`. */
    links: [
      { from: `${topo.backendDir}/uploads`, to: topo.sharedUploads },
      { from: `${topo.backendDir}/storage`, to: `${topo.sharedRoot}/storage` },
    ],
    /** Les SPA publiées par bascule atomique — aucune release, aucun `current`. */
    publications: topo.publishable.map((app) => ({
      id: app.id,
      host: app.host,
      target: app.remoteRoot,
      next: `${app.remoteRoot}.next`,
      prev: `${app.remoteRoot}.prev`,
    })),
  };
}

/**
 * LE PLAN AFFICHÉ — une lecture du moteur, pas une seconde implémentation.
 *
 * `releaseId` reste accepté pour ne pas casser l'appelant, et n'est utilisé que
 * comme ÉTIQUETTE de version : le pipeline ne crée aucun dossier de release.
 */
export function buildPlan(deployConfig, { releaseId } = {}) {
  const layout = describeRemoteLayout(deployConfig);

  return PIPELINE_STEPS.map((step) => ({
    step,
    description: STEP_LABELS[step] ?? `Étape « ${step} » du moteur de déploiement`,
    /**
     * VIDE, ET C'EST EXACT. Les commandes appartiennent au pipeline, qui les
     * compose au moment de l'exécution à partir du transport. En afficher une
     * recopie serait réintroduire la fiction que ce lot a supprimée.
     */
    commands: [],
    /** L'étiquette de version affichée — pas un dossier, pas une release. */
    version: releaseId ?? null,
    ...(step === 'dirs' ? { links: layout.links } : {}),
    ...(step === 'upload' ? { publications: layout.publications } : {}),
    ...(step === 'health'
      ? { healthCheck: { url: `${deployConfig.urls.backendUrl}/health`, expectEnv: deployConfig.environment } }
      : {}),
  }));
}

/**
 * LE ROLLBACK — l'échange des `.prev`, décrit tel qu'il est (R10.2).
 *
 * Chaque emplacement déployé garde UNE génération précédente sous
 * `<dossier>.prev`. Revenir en arrière consiste à les échanger — le backend
 * comme les SPA. L'échange est son propre inverse : un rollback raté se défait
 * par la même opération, et rejouer un rollback ramène au point de départ.
 *
 * Les données ne bougent pas : `uploads` et `storage` sont des liens vers le
 * partagé persistant et suivent le dossier échangé.
 */
export function buildRollbackPlan(deployConfig, { targetReleaseId } = {}) {
  const layout = describeRemoteLayout(deployConfig);
  const emplacements = [
    ...layout.publications.map((p) => `${p.target} ⇄ ${p.prev}`),
    `${layout.backendDir} ⇄ ${layout.backendDir}.prev`,
  ];
  return [
    {
      step: 'rollback.delegate',
      description: 'Déléguer au moteur : engine.rollback() — échange de chaque emplacement avec son `.prev`',
      commands: [],
      swaps: emplacements,
      caveats: [
        'Une seule génération précédente est conservée : `--to` est ignoré.',
        'Le retour arrière est REFUSÉ si un seul emplacement n’a pas son `.prev`, '
        + 'ou si la version de secours est incomplète (dépendances absentes).',
        'Les médias et justificatifs ne bougent pas : `uploads` et `storage` sont '
        + 'des liens vers le partagé persistant.',
        ...(targetReleaseId ? [`\`--to ${targetReleaseId}\` sera ignoré.`] : []),
      ],
    },
  ];
}
