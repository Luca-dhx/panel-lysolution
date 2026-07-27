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
  seedDevEmail: 'SEED_DEV_EMAIL',
  seedDevPassword: 'SEED_DEV_PASSWORD',
});

export default { SECRETS_TO_GENERATE, ENV_KEYS };
