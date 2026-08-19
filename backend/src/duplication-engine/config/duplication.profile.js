/**
 * PROFIL DE DUPLICATION — le seul fichier du moteur de duplication qui
 * connaisse les secrets et les variables propres à CE projet.
 *
 * Règle de sécurité de l'écosystème (24_ENVIRONMENT_AND_DOMAINS.md §5) :
 *   « Ne JAMAIS réutiliser le secret d'un autre projet ou d'un autre
 *     déploiement : chaque déploiement possède le sien. »
 *
 * Le moteur de duplication l'applique littéralement : chaque secret listé ici
 * est REGÉNÉRÉ aléatoirement dans la copie. Un Panel dupliqué n'hérite donc
 * jamais des secrets de sa source — la compromission de l'un ne compromet
 * pas les autres.
 *
 * ── Différence assumée avec un projet vitrine ───────────────────────────────
 * Le Panel n'a pas d'IntegratedAPI : sa clé de chiffrement au repos est
 * `BRIDGE_ENCRYPTION_KEY` (bridgeTokens), et non
 * `INTEGRATED_API_ENCRYPTION_KEY`. Il exige en outre `JWT_EXPIRES_IN`.
 */

/**
 * Secrets régénérés dans toute copie.
 *  - `key`      nom de la variable dans le `.env` ;
 *  - `bytes`    nombre d'octets aléatoires (source cryptographique) ;
 *  - `encoding` `hex` ou `base64url` ;
 *  - `why`      raison, reprise dans la documentation et les rapports.
 */
export const SECRETS_TO_GENERATE = Object.freeze([
  Object.freeze({
    key: 'JWT_SECRET',
    bytes: 64,
    encoding: 'hex',
    why: 'signature des sessions du Panel — un secret partagé rendrait les sessions interchangeables entre Panels',
  }),
  Object.freeze({
    key: 'BRIDGE_ENCRYPTION_KEY',
    bytes: 32,
    encoding: 'hex',
    why: 'chiffrement AES-256-GCM au repos des bridgeTokens sortants',
  }),
]);

/**
 * Variables d'environnement dont la valeur est IMPOSÉE par l'assistant de
 * duplication (bases, identité du projet, compte DEV initial).
 */
export const ENV_KEYS = Object.freeze({
  dbTest: 'DB_TEST',
  dbProd: 'DB_PROD',
  projectName: 'PANEL_NAME',
  githubRepositoryUrl: 'PROJECT_GITHUB_REPOSITORY_URL',
  /**
   * L'IDENTITÉ du premier développeur local — jamais son secret (LOT 2C).
   *
   * Le cœur du moteur est MIROIR entre les projets ; seules ces valeurs lui
   * sont propres. `SEED_DEV_PASSWORD` a disparu du contrat : aucun mot de passe
   * n'est plus écrit dans le `.env` d'une copie, ici comme ailleurs.
   */
  firstDevEmail: 'FIRST_DEV_EMAIL',
  firstDevName: 'FIRST_DEV_NAME',
});

/**
 * VARIABLES SUPPRIMÉES DU `.env` D'UNE COPIE.
 *
 * Une installation antérieure au lot 2C porte encore ces secrets d'amorçage.
 * Le code ne les lit plus — mais un secret oublié dans un fichier n'est pas
 * inerte : il est lisible, il ressemble à une consigne, et quelqu'un finira par
 * le remettre en service en croyant réparer quelque chose.
 */
export const ENV_KEYS_TO_STRIP = Object.freeze([
  'SEED_DEV_PASSWORD',
  'SEED_ADMIN_PASSWORD',
  /**
   * `SEED_DEV_EMAIL` — retirée AVEC son mot de passe, et pas seulement par
   * symétrie.
   *
   * ── CE QUE COÛTAIT SA SURVIE ────────────────────────────────────────────
   *
   * Elle n'était pas réécrite : une copie héritait donc de l'ADRESSE du
   * développeur de la source. Deux conséquences, chacune suffisante :
   *
   *   · une identité étrangère au projet neuf y était inscrite comme si elle
   *     lui appartenait ;
   *   · en `ENV=PROD`, la garde d'amorçage voyait une adresse seed SANS mot
   *     de passe — le contrat à demi rempli qu'elle refuse, à juste titre.
   *     La copie ne démarrait donc pas en production.
   *
   * L'identité du premier développeur vit désormais dans `FIRST_DEV_EMAIL`,
   * écrite par l'assistant à partir de ce qu'on lui a dit — et son secret
   * n'est écrit nulle part : il le choisit par son lien d'activation.
   */
  'SEED_DEV_EMAIL',
]);

/**
 * ══ LE PREMIER ADMINISTRATEUR — LA FORME DU COMPTE, PROPRE À CE PROJET ══════
 *
 * Le cœur du moteur sait POURQUOI créer ce compte, quand, et qu'il est
 * bloquant. Il ne peut pas savoir à quoi il ressemble : un projet vitrine écrit
 * un `User` (`password` haché par bcrypt) ; le Panel écrit un `PanelUser`
 * (`passwordHash` dérivé par scrypt, `userId`, `displayName`, `projectAccess`).
 * Ce ne sont pas des variantes d'un même document — ce sont deux modèles.
 *
 * ── CE QUI EST ARRIVÉ QUAND CE N'ÉTAIT PAS DIT ICI ──────────────────────────
 *
 * Le cœur hachait avec `bcryptjs`, importé tardivement « parce que le Panel ne
 * l'embarque pas ». L'import tardif déplaçait la panne, il ne l'évitait pas :
 * dupliquer un Panel échouait à la phase `first_admin`, sur un module
 * introuvable, après avoir créé les bases. Et même résolu, le compte aurait
 * été écrit dans la mauvaise collection, avec des champs qu'aucune connexion du
 * Panel ne relit.
 *
 * ── LA RÈGLE QUI EN DÉCOULE ─────────────────────────────────────────────────
 *
 * Le hachage n'est PAS réimplémenté ici : on emprunte celui du projet, à
 * l'endroit unique où il vit. Une seconde implémentation de scrypt dériverait
 * de la première au premier changement de paramètres, et la divergence ne se
 * verrait qu'à la connexion — sur le compte le plus neuf du parc.
 */
export const FIRST_ADMIN = Object.freeze({
  /** Le modèle Mongoose qui porte ce compte ; sa collection fait autorité. */
  modelName: 'PanelUser',
  /** Repli si le modèle n'est pas chargé dans le processus appelant. */
  collection: 'panelusers',
  /** Le champ d'identité, pour la recherche d'un doublon. */
  emailField: 'email',
  /** Le filtre « un administrateur existe-t-il déjà ? ». */
  existingAdminFilter: { role: 'ADMIN' },

  /**
   * Le document, tel que le projet l'écrirait lui-même.
   * @param {{email:string, password:string, name:string, now:Date}} entree
   */
  async buildDocument({ email, password, name, now }) {
    const { hashPassword, PROJECT_ACCESS_MODES } = await import('../../services/auth/panelUsers.service.js');
    const { newBridgeId } = await import('../../bridge/bridgeContract.js');
    return {
      userId: newBridgeId(),
      email,
      displayName: name,
      role: 'ADMIN',
      enabled: true,
      /**
       * AUCUN ACCÈS PROJET À LA CRÉATION — même règle que `createUser`.
       * L'accès au parc est un ACTE, jamais un effet de bord d'une duplication.
       */
      projectAccess: { mode: PROJECT_ACCESS_MODES.NONE, projectIds: [] },
      tokenVersion: 0,
      passwordHash: hashPassword(password),
      createdAt: now.toISOString(),
    };
  },
});

export default { SECRETS_TO_GENERATE, ENV_KEYS, ENV_KEYS_TO_STRIP, FIRST_ADMIN };
