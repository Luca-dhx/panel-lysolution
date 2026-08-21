// MIGRATION — RETIRER LES IDENTIFIANTS ET LA LIAISON DE WEBHOOK DE YOUSIGN.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md, lot 9.
//
//   node src/scripts/migrations/2026-08-21-retire-yousign-credentials.js [--apply]
//   ENV=PROD node src/scripts/migrations/2026-08-21-retire-yousign-credentials.js [--apply]
//
// ══ POURQUOI SUPPRIMER, ET NON LAISSER DORMIR ═══════════════════════════════
//
// Un jeu de credentials qui ne sert plus n'est pas neutre. Il est chiffré, mais
// il existe : il figure dans les sauvegardes, il s'exporte avec la base, et il
// donne au prochain lecteur l'impression qu'un chemin reste ouvert. La seule
// clé qu'on ne peut pas perdre est celle qui n'est plus là.
//
// Le registre ne déclare plus aucun rôle pour ce fournisseur : ces documents
// sont donc DÉJÀ inutilisables — plus rien ne sait les déchiffrer utilement.
// Ce qui reste est un résidu, et un résidu de secret se supprime.
//
// ══ CE QUI A ÉTÉ MESURÉ AVANT D'ÉCRIRE CE SCRIPT ════════════════════════════
//
// `tools/opensign/peekYousignRecords.mjs`, sur les DEUX bases :
//
//   TEST   2 jeux de credentials (un VALID, un vide), 1 liaison de webhook
//          portant `remoteWebhookId: null` — le bac à sable du fournisseur
//          refuse la création d'un webhook par API, elle n'a jamais abouti.
//   PROD   2 jeux VIDES (jamais renseignés), 1 liaison `remoteWebhookId: null`
//          avec `WEBHOOK_CREDENTIALS_MISSING`.
//
// Conséquence, et elle change tout : AUCUN endpoint n'a jamais été enregistré
// chez ce fournisseur. Il n'y a rien à débrancher de son côté, aucun appel à
// lui passer — ce qui tombe bien, puisque son transport n'existe plus.
//
// Si ce compte avait été différent — un `remoteWebhookId` non nul — cette
// migration aurait dû REFUSER de s'exécuter : supprimer la liaison aurait
// effacé la seule trace de l'endpoint qu'il aurait fallu retirer à la main.
// C'est exactement ce que fait la garde ci-dessous.
//
// ══ SANS `--apply`, ELLE NE FAIT QUE COMPTER ════════════════════════════════
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../../config/db.js';

const APPLIQUER = process.argv.includes('--apply');
const PROVIDER = 'YOUSIGN';

await connectDatabase();
const db = mongoose.connection.db;
const base = mongoose.connection.name;

const credentials = db.collection('panelintegratedapicredentialsets');
const liaisons = db.collection('panelintegratedapiwebhookbindings');

const jeux = await credentials.find({ provider: PROVIDER }).toArray();
const bindings = await liaisons.find({ provider: PROVIDER }).toArray();

console.log(`\n=== RETRAIT DE ${PROVIDER} — base « ${base} » ===`);
console.log(`jeux d’identifiants        : ${jeux.length}`);
for (const j of jeux) {
  console.log(`   · ${j.environment ?? '(sans monde)'} — statut ${j.status}`);
}
console.log(`liaisons de webhook        : ${bindings.length}`);
for (const b of bindings) {
  console.log(`   · ${b.environment ?? '(sans monde)'} — statut ${b.status}`
    + ` — endpoint distant ${b.remoteWebhookId ?? '(aucun)'}`);
}

/**
 * LA GARDE — elle vaut mieux qu'un commentaire d'avertissement.
 *
 * Un endpoint enregistré chez le fournisseur SURVIT à la suppression de notre
 * trace : il continuerait d'appeler le Panel, qui ne saurait plus d'où ça
 * vient. Et l'identifiant nécessaire pour le retirer à la main serait perdu
 * avec le document qu'on vient d'effacer.
 *
 * Dans ce cas, on refuse et on affiche ce qu'il faut débrancher.
 */
const orphelins = bindings.filter((b) => b.remoteWebhookId);
if (orphelins.length) {
  console.error('\n⚠ REFUS — un endpoint existe encore chez le fournisseur :');
  for (const b of orphelins) {
    console.error(`   · ${b.environment} — webhook ${b.remoteWebhookId} → ${b.desiredUrl || b.observedUrl}`);
  }
  console.error(
    '\nRetirez-le depuis la console du fournisseur AVANT de relancer : supprimer '
    + 'la liaison ici effacerait la seule trace de ce qu’il faut débrancher.',
  );
  await disconnectDatabase();
  process.exit(2);
}

if (!APPLIQUER) {
  console.log('\n(simulation — relancer avec --apply pour écrire)');
} else if (jeux.length === 0 && bindings.length === 0) {
  console.log('\nRien à faire.');
} else {
  const c = await credentials.deleteMany({ provider: PROVIDER });
  const l = await liaisons.deleteMany({ provider: PROVIDER });
  console.log(`\n${c.deletedCount} jeu(x) d’identifiants supprimé(s).`);
  console.log(`${l.deletedCount} liaison(s) de webhook supprimée(s).`);
  console.log(
    '\nCe fournisseur reste NOMMÉ au registre, marqué « retiré » : c’est ce qui '
    + 'permet à une demande historique d’obtenir une phrase plutôt qu’un '
    + '« fournisseur inconnu ». Il n’a plus ni rôle, ni clé, ni webhook.',
  );
}

await disconnectDatabase();
