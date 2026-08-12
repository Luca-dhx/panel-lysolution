// LE SECRET DE VÉRIFICATION D'UN PROJET (L6.3A).
//
// ══ POURQUOI UN MODÈLE À PART ═══════════════════════════════════════════════
//
// Le coffre du Panel (`PanelIntegratedApiCredentialSet`) range les identifiants
// PAR FOURNISSEUR ET PAR MONDE : une clé Stripe TEST, une clé Stripe PROD. Il
// n'a pas de dimension « projet », et c'est délibéré — les clés d'appel sont
// celles du Panel, pas celles des projets.
//
// Un secret de signature destiné à un projet n'entre donc pas dans ce coffre :
// il y aurait pour clé (STRIPE, TEST) comme celui du Panel, et l'un écraserait
// l'autre. La première réception d'un webhook Panel deviendrait impossible, ou
// pire, on servirait au projet le secret de l'endpoint du Panel.
//
// ══ CE QUE CE MODÈLE GARANTIT ═══════════════════════════════════════════════
//
// Une seule valeur par (projet, fournisseur, monde), chiffrée, et RIEN d'autre
// que des secrets de vérification : aucune clé d'appel ne peut y être rangée,
// parce qu'aucun code ne l'y écrit et que le seul écrivain valide la forme.
//
// C'est aussi ce qui rend l'isolation entre projets structurelle plutôt que
// procédurale : la lecture prend le `projectId` en paramètre obligatoire, et il
// vient du jeton de pont — jamais de la charge utile.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

const projectWebhookSecretSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    provider: { type: String, required: true, uppercase: true, trim: true },
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /** Le rôle de credential concerné — toujours `verificationOnly` au registre. */
    role: { type: String, required: true },

    /** Chiffré au repos, comme tout le reste du coffre. Jamais en clair. */
    encryptedValue: { type: String, required: true },

    /**
     * Les quatre derniers caractères, pour qu'un opérateur puisse dire « c'est
     * bien celui-là » sans jamais lire la valeur. Quatre caractères d'un secret
     * de 32+ ne permettent pas de le reconstituer.
     */
    lastFour: { type: String, default: '' },

    /**
     * QUAND il a été livré au projet pour la dernière fois.
     *
     * Sert au diagnostic — « le projet a-t-il bien reçu le secret courant ? » —
     * et rien d'autre. Un projet qui n'a jamais rien reçu se distingue ainsi
     * d'un projet dont la livraison a échoué.
     */
    deliveredAt: { type: String, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * UN SEUL secret courant par (projet, fournisseur, monde).
 *
 * L'index le rend vrai même sous concurrence : huit provisionnements
 * simultanés ne peuvent pas ranger huit secrets différents, donc le projet ne
 * peut pas se retrouver à vérifier avec un secret que Stripe n'utilise plus.
 */
projectWebhookSecretSchema.index(
  { projectId: 1, provider: 1, environment: 1 },
  { unique: true, name: 'uniq_project_provider_environment' },
);

export const PanelProjectWebhookSecret = mongoose.model(
  'PanelProjectWebhookSecret',
  projectWebhookSecretSchema,
);

export default PanelProjectWebhookSecret;
