/**
 * DESTINATION D'UN PROJET — l'autorité du Panel sur « où vit ce projet ».
 *
 * ══ LE DÉFAUT CORRIGÉ ═══════════════════════════════════════════════════════
 *
 * Le Panel n'avait AUCUN modèle de destination pour un projet. Il connaissait
 * trois adresses, écrites à trois moments différents, et personne n'arbitrait :
 *
 *   · `PanelProject.runtime.publicBackendUrl` — posée au BOOTSTRAP, et jamais
 *     revue ensuite : le battement de cœur ne transporte pas d'URL ;
 *   · `PanelProject.manifest.network.*`       — photographie prise à
 *     l'appairage, rafraîchie seulement sur action manuelle ;
 *   · la projection `PROJECT_PRESENTATION.network.*` — poussée, elle, à chaque
 *     modification métier.
 *
 * Quand un projet change de domaine SANS se réappairer — même base, donc même
 * jeton — seule la troisième suit. Les deux premières restent figées sur
 * l'ancien domaine. Le Panel affiche alors deux vérités simultanées : la
 * vitrine sur la nouvelle adresse, le backend et le domaine principal sur
 * l'ancienne. Pire, il APPELLE l'ancienne pour les contrats, la santé et les
 * opérations.
 *
 * Constaté en base le 2026-08-06 sur « Demo SB Auto » : présentation sur
 * `demo-sbauto06.ly-solution.com`, runtime et manifeste sur
 * `demo-sbauto.lycarz.com`.
 *
 * ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
 *
 * Pour un PROJET et un ENVIRONNEMENT, il ne peut exister qu'UNE destination
 * ACTIVE. C'est elle, et elle seule, que toutes les vues lisent.
 *
 *   ACTIVE ──► RETIRED ──► EMPTY ──► DELETED
 *      ▲          │
 *      └──────────┘   (une migration inachevée revient à l'état précédent)
 *
 * Une destination annoncée mais dont la photographie n'est pas complète reste
 * en `PENDING` : elle n'est jamais lue. Basculer avant d'avoir tout reçu
 * ferait afficher un projet à moitié décrit — exactement ce qu'on corrige.
 *
 * ══ CE QUE LE PANEL NE FAIT PAS ═════════════════════════════════════════════
 *
 * Il ne déploie rien, ne migre rien, ne redéploie rien. Le déploiement est
 * piloté depuis le poste du projet ; le Panel ENREGISTRE ce que le projet lui
 * annonce et arbitre les états. Aucune écriture ici ne part vers un serveur.
 */
import mongoose from 'mongoose';

/** États du cycle de vie d'une destination de projet. */
export const DESTINATION_STATUS = Object.freeze({
  /** Annoncée, photographie incomplète : jamais lue par les vues. */
  PENDING: 'PENDING',
  /** La destination courante du projet pour cet environnement. */
  ACTIVE: 'ACTIVE',
  /** Remplacée par une autre. Conservée : c'est la mémoire de la migration. */
  RETIRED: 'RETIRED',
  /** L'opérateur a constaté qu'il n'y a plus rien sur le serveur. */
  EMPTY: 'EMPTY',
  /** Fiche retirée des listes ; audit et historique conservés. */
  DELETED: 'DELETED',
});

/** Les états qui OCCUPENT encore la place d'ACTIVE — au plus un à la fois. */
export const LIVE_STATUSES = Object.freeze([DESTINATION_STATUS.ACTIVE]);

const urlsSchema = new mongoose.Schema(
  {
    website: { type: String, default: null },
    manager: { type: String, default: null },
    backend: { type: String, default: null },
  },
  { _id: false },
);

const destinationSchema = new mongoose.Schema(
  {
    destinationId: { type: String, required: true, unique: true },

    /**
     * L'IDENTITÉ DU PROJET. `projectId` est opaque et survit aux changements
     * de domaine — c'est précisément ce qui a permis de constater la migration
     * de Demo SB Auto : la fiche n'avait pas bougé, seule l'adresse.
     */
    projectId: { type: String, required: true, index: true },
    environment: { type: String, enum: ['TEST', 'PROD'], required: true },

    /** Hôte CANONIQUE de la destination — dérivé de l'URL du backend. */
    host: { type: String, required: true, lowercase: true },
    /** Les trois adresses, telles que le PROJET les annonce. Jamais recomposées. */
    urls: { type: urlsSchema, default: () => ({}) },

    status: {
      type: String,
      enum: Object.values(DESTINATION_STATUS),
      default: DESTINATION_STATUS.PENDING,
      index: true,
    },

    /**
     * GÉNÉRATION du projet au moment de l'annonce. C'est elle qui permet de
     * dire qu'une projection reçue avant la migration ne décrit plus rien.
     */
    generation: { type: String, default: null },

    /** D'où vient l'annonce : le projet parle par plusieurs canaux. */
    announcedBy: {
      type: String,
      enum: ['BOOTSTRAP', 'PRESENTATION', 'MANIFEST', 'REPAIR', null],
      default: null,
    },

    /**
     * CE QUI MANQUE ENCORE pour que la photographie soit complète. Tant que
     * cette liste n'est pas vide, la destination reste `PENDING`.
     */
    missing: { type: [String], default: [] },

    announcedAt: { type: String, required: true },
    activatedAt: { type: String, default: null },
    retiredAt: { type: String, default: null },
    emptiedAt: { type: String, default: null },
    deletedAt: { type: String, default: null },
    /** Dernière fois que le projet a confirmé vivre ici. */
    lastSeenAt: { type: String, default: null },

    /** Destination que celle-ci remplace — la chaîne des déménagements. */
    previousDestinationId: { type: String, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * UNE SEULE DESTINATION ACTIVE PAR PROJET ET PAR ENVIRONNEMENT.
 *
 * L'index est PARTIEL et porte sur le seul état `ACTIVE` : un projet peut
 * avoir autant de destinations `RETIRED` que de déménagements — c'est son
 * histoire — et une destination `PENDING` par migration en cours. Ce que la
 * base interdit, c'est deux vérités simultanées.
 *
 * TEST et PROD sont indépendants : chacun a droit à SA destination active.
 *
 * Le filtre s'énonce en `$in` et non en `$ne` : MongoDB refuse une négation
 * dans un index partiel, et la construction échouerait en silence.
 */
destinationSchema.index(
  { projectId: 1, environment: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['ACTIVE'] } } },
);

destinationSchema.index({ projectId: 1, environment: 1, status: 1 });
destinationSchema.index({ host: 1 });

export const PanelProjectDestination = mongoose.model(
  'PanelProjectDestination',
  destinationSchema,
);
export default PanelProjectDestination;
