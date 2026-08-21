// L'ÉTAT DES LIAISONS DE WEBHOOK — lecture seule, secrets exclus.
//
//   node tools/opensign/etatWebhooks.mjs
import { createRequire } from 'node:module';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';

const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const mongoose = requireBackend('mongoose');

await connectDatabase();
const docs = await mongoose.connection.db
  .collection('panelintegratedapiwebhookbindings').find({}).toArray();
console.log(`${docs.length} liaison(s)`);
for (const d of docs) {
  console.log(JSON.stringify({
    provider: d.provider,
    environment: d.environment,
    status: d.status,
    desiredUrl: d.desiredUrl,
    observedUrl: d.observedUrl,
    remoteWebhookId: d.remoteWebhookId,
    lastEventAt: d.lastEventAt,
    lastEventType: d.lastEventType,
    lastErrorCode: d.lastErrorCode,
  }, null, 1));
}
await disconnectDatabase();
