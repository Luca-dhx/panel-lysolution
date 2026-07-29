// COMPTE DE DÉVELOPPEMENT — crée ou réinitialise, puis affiche comment se
// connecter. Réservé à ENV=TEST.
//
//   npm run dev:account
//   npm run dev:account -- moi@exemple.test monMotDePasse
//
// Sert au cas que le seed ne couvre pas : la base contient déjà des
// utilisateurs — donc `seedFromEnv()` ne fait rien — et le mot de passe est
// perdu. Sans cette commande, la seule issue serait de vider la collection à
// la main.
import config from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { ensureDevAccount } from '../services/auth/panelUsers.service.js';
import { resolveBackendUrl } from '../services/network/networkConfig.service.js';
import logger from '../utils/logger.js';

const [emailArg, passwordArg] = process.argv.slice(2);

try {
  await connectDatabase();
  const result = await ensureDevAccount({ email: emailArg, password: passwordArg });
  const backend = await resolveBackendUrl();

  const password = passwordArg ?? config.seedDevPassword;
  // L'URL vient du RÉSOLVEUR, jamais d'une chaîne fabriquée ici : c'est la
  // règle de 24_ENVIRONMENT_AND_DOMAINS. Non résolue, on affiche le port —
  // un fait local, pas une adresse inventée.
  const target = backend.url ?? `(non configurée — port local ${config.port})`;

  logger.success(
    result.created
      ? `Compte DEV créé : ${result.email}`
      : `Mot de passe réinitialisé pour : ${result.email}`,
  );
  console.log('');
  console.log('  Se connecter');
  console.log(`    Backend      ${target}`);
  console.log(`    E-mail       ${result.email}`);
  console.log(`    Mot de passe ${password}`);
  console.log('');
  console.log('  Vérifier :');
  console.log(`    curl -X POST <backend>/api/auth/login \\`);
  console.log('      -H "content-type: application/json" \\');
  console.log(`      -d '{"email":"${result.email}","password":"${password}"}'`);
  console.log('');
} catch (err) {
  logger.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectDatabase().catch(() => {});
}
