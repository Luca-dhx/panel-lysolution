// RÉCONCILIATION RÉELLE DU WEBHOOK OPENSIGN.
//
// Campagne de migration Yousign → OpenSign, lot 1 point 4, lot 3 points 1-2.
//
//   node tools/opensign/reconcileWebhook.js [--observe]
//
// ══ CE QU'ELLE FAIT ════════════════════════════════════════════════════════
//
// Elle appelle le VRAI réconciliateur du Panel — pas une imitation — sur le
// compte OpenSign de bac à sable. C'est ce qui écrit le BINDING, et sans
// binding la réception refuse tout : « le Panel n'a jamais enregistré
// d'endpoint pour ce couple » est un refus, pas un détail.
//
// ── `--observe` ────────────────────────────────────────────────────────────
//
// Interdit toute création et toute suppression. Le réconciliateur regarde,
// compare, et rend son verdict sans rien changer. C'est le mode à employer
// quand on veut savoir où l'on en est sans en décider.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import {
  reconcileProviderWebhook,
  describeWebhookState,
  ensureWebhookBindingIndexes,
} from '../../backend/src/services/webhooks/webhookReconciler.js';

const OBSERVER = process.argv.includes('--observe');
const journal = (...a) => console.log(...a);

await connectDatabase();
await ensureWebhookBindingIndexes();

journal(`\n=== RÉCONCILIATION WEBHOOK OPENSIGN ${OBSERVER ? '(OBSERVATION SEULE)' : ''} ===\n`);

const avant = await describeWebhookState('OPENSIGN');
journal('état AVANT :');
journal(JSON.stringify({
  status: avant.status, callbackUrl: avant.callbackUrl, observedUrl: avant.observedUrl,
  remoteWebhookId: avant.remoteWebhookId, secretConfigured: avant.secretConfigured,
  drift: avant.drift, lastErrorCode: avant.lastErrorCode,
}, null, 1));

const resultat = await reconcileProviderWebhook({
  provider: 'OPENSIGN',
  allowCreate: !OBSERVER,
  allowDelete: !OBSERVER,
});

journal('\nrésultat :');
journal(JSON.stringify({
  status: resultat.status, code: resultat.code ?? null, message: resultat.message ?? null,
  created: resultat.created, updated: resultat.updated, deleted: resultat.deleted,
  secretCaptured: resultat.secretCaptured, drift: resultat.drift,
  peersLeftAlone: resultat.peersLeftAlone, foreignLeftAlone: resultat.foreignLeftAlone,
}, null, 1));

const apres = await describeWebhookState('OPENSIGN');
journal('\nétat APRÈS :');
journal(JSON.stringify({
  status: apres.status, callbackUrl: apres.callbackUrl, observedUrl: apres.observedUrl,
  remoteWebhookId: apres.remoteWebhookId, secretConfigured: apres.secretConfigured,
  drift: apres.drift, lastErrorCode: apres.lastErrorCode, lastErrorMessage: apres.lastErrorMessage,
}, null, 1));

journal(`\nVERDICT : ${apres.status === 'READY'
  ? 'le Panel est prêt à recevoir et à vérifier les événements OpenSign.'
  : `NON PRÊT (${apres.status}) — ${apres.lastErrorMessage ?? apres.drift?.join(', ') ?? 'motif inconnu'}`}`);

const dossier = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(dossier, { recursive: true });
writeFileSync(path.join(dossier, 'opensign-webhook-reconciliation.json'),
  JSON.stringify({ avant, resultat, apres }, null, 1), 'utf8');

await disconnectDatabase();
