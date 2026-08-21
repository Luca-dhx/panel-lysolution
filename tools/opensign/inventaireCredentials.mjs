// QUE RESTE-T-IL DE L'ANCIEN FOURNISSEUR EN BASE ? — avant de retirer sa place.
//
//   node tools/opensign/inventaireCredentials.mjs        (TEST)
//   ENV=PROD node tools/opensign/inventaireCredentials.mjs
//
// Retirer une définition de fournisseur du registre rend ses documents
// orphelins : plus personne ne sait les décrire, ni les purger. On regarde donc
// AVANT — un credential vivant, un webhook déclaré, un événement en attente.
import { createRequire } from 'node:module';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';

/**
 * `mongoose` vit dans les dépendances du backend, pas à la racine : l'outillage
 * de campagne emprunte donc SA résolution. Un `npm i` à la racine pour un
 * script de mesure ajouterait une deuxième copie du pilote, et deux pilotes
 * pour une seule base finissent toujours par diverger sur une version.
 */
const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const mongoose = requireBackend('mongoose');

await connectDatabase();
const db = mongoose.connection.db;

const compter = async (collection, filtre) => {
  try { return await db.collection(collection).countDocuments(filtre); }
  catch { return 'collection absente'; }
};

const nomsDeCollections = (await db.listCollections().toArray()).map((c) => c.name);

const rapport = {
  base: mongoose.connection.name,
  collections: nomsDeCollections.filter((n) => /credential|provider|webhook|integrat/i.test(n)),
  credentials: {},
  webhooks: {},
  evenements: {},
};

for (const nom of nomsDeCollections) {
  if (/credential|integrat/i.test(nom)) {
    rapport.credentials[nom] = await compter(nom, { provider: 'YOUSIGN' });
  }
  if (/webhook/i.test(nom)) {
    rapport.webhooks[nom] = await compter(nom, { provider: 'YOUSIGN' });
  }
}

console.log(JSON.stringify(rapport, null, 1));
await disconnectDatabase();
