// MIGRATION — inscrire le FOURNISSEUR sur les liens de signature existants.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md.
//
//   node src/scripts/migrations/2026-08-20-signature-binding-provider.js [--apply]
//
// ══ POURQUOI CETTE MIGRATION EXISTE ═════════════════════════════════════════
//
// `PanelSignatureBinding` ne portait pas de fournisseur : il n'y en avait
// qu'un. Depuis la bascule, chaque demande doit dire QUI la détient — sans quoi
// relire un contrat historique obligerait à essayer les fournisseurs l'un après
// l'autre, c'est-à-dire à envoyer l'identifiant d'un contrat chez un
// fournisseur qui ne le connaît pas.
//
// ══ POURQUOI YOUSIGN, ET POURQUOI C'EST UN FAIT ET NON UNE SUPPOSITION ══════
//
// Tout lien écrit AVANT l'introduction du champ l'a été par l'unique
// fournisseur de signature qu'ait connu le parc. Ce n'est pas une déduction
// probable : aucun autre code n'a jamais écrit dans cette collection.
//
// Le code sait déjà se rabattre sur cette valeur (`LEGACY_SIGNATURE_PROVIDER`).
// Cette migration rend le fait EXPLICITE EN BASE, pour trois raisons :
// une requête d'exploitation peut filtrer par fournisseur ; un index sur
// `provider` sert à quelque chose ; et le repli, un jour, pourra disparaître
// sans que personne ait à se demander ce qu'il couvrait.
//
// ══ SANS `--apply`, ELLE NE FAIT QUE COMPTER ════════════════════════════════
import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import PanelSignatureBinding from '../../models/PanelSignatureBinding.model.js';
import { LEGACY_SIGNATURE_PROVIDER } from '../../services/integratedApi/signature/signatureProviderRouting.js';

const APPLIQUER = process.argv.includes('--apply');

await connectDatabase();

const sansFournisseur = await PanelSignatureBinding.countDocuments({
  $or: [{ provider: { $exists: false } }, { provider: null }],
});
const total = await PanelSignatureBinding.countDocuments({});

console.log(`\n=== LIENS DE SIGNATURE ===`);
console.log(`total                     : ${total}`);
console.log(`sans fournisseur inscrit  : ${sansFournisseur}`);

const parFournisseur = await PanelSignatureBinding.aggregate([
  { $group: { _id: '$provider', n: { $sum: 1 } } },
]);
console.log(`répartition               : ${JSON.stringify(parFournisseur)}`);

if (!APPLIQUER) {
  console.log('\n(simulation — relancer avec --apply pour écrire)');
} else if (sansFournisseur === 0) {
  console.log('\nRien à faire : tous les liens portent déjà leur fournisseur.');
} else {
  const resultat = await PanelSignatureBinding.updateMany(
    { $or: [{ provider: { $exists: false } }, { provider: null }] },
    { $set: { provider: LEGACY_SIGNATURE_PROVIDER } },
  );
  console.log(`\n${resultat.modifiedCount} lien(s) marqué(s) « ${LEGACY_SIGNATURE_PROVIDER} ».`);
}

await disconnectDatabase();
