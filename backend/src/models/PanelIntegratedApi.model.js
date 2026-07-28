// INTEGRATED API — Phase 4, LOT 4.
//
// Une IntegratedAPI est un accès à un service tiers (paiement, e-mail,
// cartographie, IA…) que l'ENTREPRISE détient et que les PROJETS consomment.
// Le Panel en est le coffre : il détient les identifiants, les projets ne
// reçoivent que ce à quoi ils sont autorisés.
//
// ── DEUX RÈGLES DE SÉCURITÉ, NON NÉGOCIABLES ────────────────────────────────
//
//  1. Le SECRET n'est jamais stocké en clair. Il est chiffré AES-256-GCM par
//     `panelCrypto` avec la clé du Panel, comme les bridgeTokens.
//
//  2. Le secret ne sort JAMAIS par la surface /api. Une API d'administration
//     montre le fournisseur, le mode, les autorisations — jamais la valeur.
//     Le seul canal de sortie est le pont, vers un projet explicitement
//     autorisé, et seulement pour les secrets qu'il a le droit de recevoir.
//
// Ces deux règles sont vérifiées par test.
//
// ── MODE TEST / PROD ────────────────────────────────────────────────────────
// Une même API porte deux jeux d'identifiants. Un projet en TEST ne doit
// jamais recevoir la clé de production — c'est exactement le genre de fuite
// qui coûte cher, et c'est le mode du PROJET qui décide, pas une préférence
// du Panel.
import mongoose from 'mongoose';

/** Un jeu d'identifiants pour un mode donné. Valeurs toujours chiffrées. */
const credentialSetSchema = new mongoose.Schema(
  {
    // { nom: chiffré } — le NOM reste lisible (« publishableKey »,
    // « secretKey ») pour que l'écran d'administration soit compréhensible
    // sans jamais révéler les valeurs.
    values: { type: Map, of: String, default: () => new Map() },
    // Empreinte courte de chaque valeur, pour vérifier qu'on a bien changé
    // quelque chose sans jamais afficher le secret.
    fingerprints: { type: Map, of: String, default: () => new Map() },
    updatedAt: { type: String, default: null },
  },
  { _id: false },
);

/** Autorisation d'un projet à consommer cette API. */
const grantSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    projectName: { type: String, default: null },
    // Sous-ensemble des clés que ce projet reçoit. Vide = toutes celles du
    // mode. Permet de donner la clé publique sans la clé secrète.
    keys: { type: [String], default: [] },
    grantedAt: { type: String, required: true },
    grantedBy: { type: String, default: null },
  },
  { _id: false },
);

const integratedApiSchema = new mongoose.Schema(
  {
    apiId: { type: String, required: true, unique: true },
    companyId: { type: String, required: true },
    // Identifiant stable et lisible — c'est lui qui voyage vers les projets.
    key: { type: String, required: true },
    label: { type: String, required: true },
    provider: { type: String, required: true },
    description: { type: String, default: null },
    // Catégorie d'usage, purement descriptive (PAYMENT, EMAIL, MAPS, AI…).
    category: { type: String, default: 'OTHER' },

    // Mode ACTIF de l'API côté Panel. Un projet en TEST reçoit toujours les
    // identifiants TEST, quel que soit ce champ ; ce mode décide de ce que
    // reçoit un projet en PROD.
    mode: { type: String, enum: ['TEST', 'PROD'], default: 'TEST' },
    enabled: { type: Boolean, default: true },

    credentials: {
      TEST: { type: credentialSetSchema, default: () => ({}) },
      PROD: { type: credentialSetSchema, default: () => ({}) },
    },

    // Paramètres non secrets (URL de base, région, identifiant de compte…).
    // Distincts des identifiants : ils sont lisibles par l'administration.
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },

    grants: { type: [grantSchema], default: [] },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

integratedApiSchema.index({ companyId: 1, key: 1 }, { unique: true });
integratedApiSchema.index({ 'grants.projectId': 1 });

export default mongoose.model('PanelIntegratedApi', integratedApiSchema);
