// Configuration système du Panel — document SINGLETON, même principe que le
// `SystemConfiguration` des Managers vitrines : les URLs publiques vivent en
// base (modifiables sans redéploiement), le `.env` ne porte qu'un repli.
// Voir docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md §3 (règle de priorité).
import mongoose from 'mongoose';

// Un champ non renseigné vaut null — « non configuré » doit rester
// distinguable de « configuré sur une valeur locale », sans quoi la règle
// de priorité du résolveur n'aurait plus de sens.
const networkSchema = new mongoose.Schema(
  {
    // URL publique du backend du Panel (API + pont) — c'est l'adresse que
    // les projets appellent.
    backendUrl: { type: String, default: null },
    // URL publique de l'interface du Panel — origine CORS de référence.
    frontendUrl: { type: String, default: null },
  },
  { _id: false },
);

const systemConfigurationSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'SINGLETON', unique: true },
    network: { type: networkSchema, default: () => ({}) },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

export default mongoose.model('SystemConfiguration', systemConfigurationSchema);
