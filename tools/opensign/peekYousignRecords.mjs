// CE QUE LA BASE GARDE ENCORE DE L'ANCIEN FOURNISSEUR — secrets masqués.
//
//   node tools/opensign/peekYousignRecords.mjs
//   ENV=PROD node tools/opensign/peekYousignRecords.mjs
//
// On regarde AVANT de retirer. Un webhook enregistré chez le fournisseur
// continue d'exister même quand notre trace disparaît : effacer la trace sans
// avoir noté l'adresse, c'est perdre le seul moyen de savoir quoi débrancher.
import { createRequire } from 'node:module';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';

const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const mongoose = requireBackend('mongoose');

/** Rien de secret ne sort d'ici — ni chiffré, ni en clair. */
const masque = (o) => JSON.parse(JSON.stringify(o, (cle, valeur) => (
  /secret|token|key|encrypted|cipher|iv|tag|signature/i.test(cle) ? '«masqué»' : valeur
)));

await connectDatabase();
const db = mongoose.connection.db;
for (const collection of ['panelintegratedapicredentialsets', 'panelintegratedapiwebhookbindings']) {
  const docs = await db.collection(collection).find({ provider: 'YOUSIGN' }).toArray();
  console.log(`\n== ${collection} (${docs.length})`);
  for (const d of docs) console.log(JSON.stringify(masque(d), null, 1).slice(0, 1500));
}
await disconnectDatabase();
