// SONDE OPENSIGN — état du jeu d'identifiants, et test de connexion RÉEL.
//
// Campagne de migration Yousign → OpenSign, lot 1.
//
// ── CE QUE CE SCRIPT FAIT, ET CE QU'IL NE FERA JAMAIS ───────────────────────
//
// Il LIT : l'état du jeu TEST, les rôles présents (empreintes, jamais les
// valeurs), puis exécute le test de connexion du plan de contrôle — c'est-à-dire
// `GET /getuser`, `GET /webhook` et `GET /getcredits`.
//
// Il ne crée aucun document, n'envoie aucun e-mail et ne débite aucun crédit.
// C'est la seule sonde qu'un exploitant peut relancer autant de fois qu'il veut.
//
//   node src/scripts/opensign-probe.js
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import config from '../config/env.js';
import PanelIntegratedApiCredentialSet from '../models/PanelIntegratedApiCredentialSet.model.js';
import { getCredentialSet, validateCredentialSet } from '../services/integratedApi/controlPlane.service.js';

const ENVIRONNEMENT = 'TEST';

await connectDatabase();

console.log(`\n=== SONDE OPENSIGN (${ENVIRONNEMENT}) — runtime Panel : ${config.env} ===\n`);

const brut = await PanelIntegratedApiCredentialSet.findOne({
  provider: 'OPENSIGN', environment: ENVIRONNEMENT, projectId: null,
}).lean();

if (!brut) {
  console.log('AUCUN jeu OPENSIGN/TEST en base — le seed n’a pas tourné.');
  await disconnectDatabase();
  process.exit(1);
}

const roles = Object.entries(brut.credentialsEncrypted ?? {});
console.log(`statut : ${brut.status}`);
console.log('rôles renseignés :');
for (const [code, valeur] of roles) {
  // EMPREINTE ET QUATRE DERNIERS CARACTÈRES. Jamais la valeur : ce script
  // s'exécute dans un terminal dont la sortie survit à la session.
  console.log(`  · ${code.padEnd(24)} fingerprint=${valeur?.fingerprint ?? '—'} last4=${valeur?.lastFour || '(public)'}`);
}

const vue = await getCredentialSet('OPENSIGN', ENVIRONNEMENT);
console.log('\nvue publique du jeu :');
console.log(JSON.stringify(vue?.credentials ?? vue, null, 1).slice(0, 1500));

console.log('\n--- TEST DE CONNEXION RÉEL ---\n');
const verdict = await validateCredentialSet('OPENSIGN', ENVIRONNEMENT, {
  actor: { id: 'campagne-opensign', email: 'campagne@local' },
});
console.log(JSON.stringify(verdict, null, 1));

await disconnectDatabase();
