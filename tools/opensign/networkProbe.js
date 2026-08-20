// SONDE RÉSEAU — quelle adresse publique le Panel donnerait-il à OpenSign ?
//
// Campagne de migration Yousign → OpenSign, lot 1.
//
// Une callback est une adresse qu'on DONNE à un tiers. Avant de la poser chez
// OpenSign, on regarde ce que le Panel produirait — et d'où il le tient.
//
//   node src/scripts/opensign-network-probe.js
import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import config from '../../backend/src/config/env.js';
import { resolveBackendUrl, resolveFrontendUrl } from '../../backend/src/services/network/networkConfig.service.js';
import { resolveWebhookCallback } from '../../backend/src/services/webhooks/webhookCallback.js';
import { describeAllWebhookStates } from '../../backend/src/services/webhooks/webhookReconciler.js';

await connectDatabase();

console.log(`\n=== RÉSEAU (runtime ${config.env}) ===\n`);
console.log('PUBLIC_URL (.env) :', config.publicUrl ?? '(absent)');
console.log('backend  :', JSON.stringify(await resolveBackendUrl()));
console.log('frontend :', JSON.stringify(await resolveFrontendUrl()));

for (const provider of ['OPENSIGN', 'YOUSIGN']) {
  console.log(`\ncallback ${provider} :`, JSON.stringify(await resolveWebhookCallback(provider), null, 1));
}

console.log('\n=== ÉTAT DES WEBHOOKS CONNUS (aucun appel distant) ===\n');
const etats = await describeAllWebhookStates();
console.log(JSON.stringify(etats, null, 1).slice(0, 4000));

await disconnectDatabase();
