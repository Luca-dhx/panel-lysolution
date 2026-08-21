// INVENTAIRE DES LIENS D'APPARTENANCE DE SIGNATURE — un fait, pas une hypothèse.
//
//   node tools/opensign/inventaireLiens.mjs
//
// Avant de retirer le chemin d'exécution de l'ancien fournisseur, il faut
// savoir s'il reste une demande VIVANTE chez lui. Le retirer « parce que c'est
// fini » sans regarder abandonnerait un engagement en cours, chez de vraies
// personnes, sans que rien ne le signale.
import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import Binding from '../../backend/src/models/PanelSignatureBinding.model.js';

await connectDatabase();
const total = await Binding.countDocuments();
const lignes = await Binding.aggregate([
  {
    $group: {
      _id: { provider: '$provider', vivante: { $eq: ['$closedAt', null] } },
      n: { $sum: 1 },
    },
  },
  { $sort: { n: -1 } },
]);
/** Un lien écrit avant l'existence du champ est HISTORIQUE — donc Yousign. */
const sansFournisseurVivants = await Binding.countDocuments({
  $or: [{ provider: null }, { provider: { $exists: false } }],
  closedAt: null,
});
const yousignVivants = await Binding.countDocuments({ provider: 'YOUSIGN', closedAt: null });

console.log(JSON.stringify({
  total,
  lignes: lignes.map((l) => ({
    fournisseur: l._id.provider ?? '(absent)',
    vivante: l._id.vivante,
    nombre: l.n,
  })),
  yousignVivants,
  sansFournisseurVivants,
  retraitSansRisque: yousignVivants === 0 && sansFournisseurVivants === 0,
}, null, 1));
await disconnectDatabase();
