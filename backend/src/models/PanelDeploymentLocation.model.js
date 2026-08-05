import mongoose from 'mongoose';

/**
 * OÙ UN PROJET A DÉJÀ VÉCU — la mémoire de ses emplacements.
 *
 * ── POURQUOI CE JOURNAL EXISTE ──────────────────────────────────────────────
 * Quand un projet change de domaine, ses médias persistants restent dans le
 * `shared/uploads` de l'ancienne destination. Pour les retrouver sans deviner,
 * il faut savoir où le projet a été déployé auparavant — et le savoir de façon
 * certaine, pas en inspectant `/var/www`.
 *
 * Chaque déploiement écrit ici son emplacement exact. C'est la SEULE source
 * autorisée pour décider d'où migrer des fichiers.
 *
 * ── CE QU'ON NE FAIT JAMAIS ─────────────────────────────────────────────────
 * On ne supprime pas une entrée. Une destination retirée est marquée `retiredAt`
 * et conserve son emplacement : c'est ce qui permet de constater, des mois plus
 * tard, d'où venait un fichier — et d'expliquer une migration.
 */
const locationSchema = new mongoose.Schema(
  {
    // Le lien qui autorise une migration. Sans identité commune, aucune copie.
    projectIdentityId: { type: String, required: true, index: true },
    targetId: { type: String, required: true, index: true },

    // Emplacement RÉEL sur le serveur, tel que la topologie l'a calculé.
    host: { type: String, required: true, lowercase: true },
    siteRoot: { type: String, required: true },
    sharedUploadsPath: { type: String, required: true },
    sharedStoragePath: { type: String, default: null },
    sshHost: { type: String, default: null },

    environment: { type: String, enum: ['TEST', 'PROD'], required: true },
    deploymentRunId: { type: String, default: null },
    commit: { type: String, default: null },

    /**
     * `HEALTHY` n'est posé qu'après une vérification publique complète : c'est
     * ce qui fait d'un emplacement une source de migration digne de confiance.
     * Un emplacement `FAILED` a pu ne recevoir aucun fichier.
     */
    status: {
      type: String,
      enum: ['DEPLOYING', 'HEALTHY', 'FAILED', 'RETIRED'],
      default: 'DEPLOYING',
      index: true,
    },

    deployedAt: { type: String, required: true },
    // Renseigné au retrait. L'entrée reste, la destination n'existe plus.
    retiredAt: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

// Retrouver les emplacements sains d'un projet, du plus récent au plus ancien —
// c'est exactement la requête que fait la résolution de source.
locationSchema.index({ projectIdentityId: 1, status: 1, deployedAt: -1 });

export const PanelDeploymentLocation = mongoose.model('PanelDeploymentLocation', locationSchema);
export default PanelDeploymentLocation;
