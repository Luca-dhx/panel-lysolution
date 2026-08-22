import mongoose from 'mongoose';

/**
 * LES TENTATIVES D'AUTHENTIFICATION — un compteur, pas un journal.
 *
 * ══ POURQUOI EN BASE, ET NON DANS UNE `Map` ═════════════════════════════════
 *
 * Un compteur en mémoire a trois défauts, et les trois se paient :
 *
 *   · il MEURT au redémarrage. Un attaquant qui provoque un redémarrage — ou
 *     qui attend simplement le prochain déploiement — repart de zéro ;
 *   · il est LOCAL au processus. Le jour où deux instances servent le même
 *     domaine, chacune compte pour elle et la limite réelle double ;
 *   · il est INVISIBLE. Personne ne peut constater qu'un compte est martelé.
 *
 * La base est déjà là, elle est partagée, et une fenêtre de quinze minutes ne
 * pèse rien. Ajouter Redis pour ce seul besoin coûterait une dépendance
 * d'infrastructure que rien d'autre ne réclame.
 *
 * ══ CE QUE CE DOCUMENT NE PORTE PAS ═════════════════════════════════════════
 *
 * Ni mot de passe, ni e-mail en clair, ni jeton. L'identité est HACHÉE : le
 * compteur doit pouvoir dire « cette identité a trop essayé » sans constituer,
 * au passage, la liste des adresses que l'on tente de forcer.
 *
 * ══ LA PURGE EST FAITE PAR LA BASE ══════════════════════════════════════════
 *
 * Un index TTL sur `expiresAt`. Aucune tâche de nettoyage à écrire, à armer, à
 * surveiller — et aucune fenêtre où le ménage n'aurait pas été fait.
 */
const authAttemptSchema = new mongoose.Schema(
  {
    /**
     * LA CLÉ DU SEAU — `<portée>:<dimension>:<valeur>`.
     *
     * La DIMENSION en fait partie et c'est le cœur du dispositif : un seau
     * « ip » et un seau « identité » cohabitent sans se confondre. Limiter sur
     * une seule des deux serait contournable —
     *
     *   par IP seule       : une attaque distribuée passe sous le radar, et un
     *                        bureau derrière un NAT se bloque tout seul ;
     *   par identité seule : un attaquant balaie mille adresses différentes
     *                        sans jamais remplir un seul seau.
     */
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    /** Fin de la fenêtre. La limite se lit « N tentatives d'ici là ». */
    expiresAt: { type: Date, required: true },
    /** Pour un exploitant qui regarde : quand ce seau a-t-il été touché ? */
    lastAttemptAt: { type: Date, default: null },
  },
  { collection: 'panelauthattempts', versionKey: false },
);

/** La base fait le ménage. `expireAfterSeconds: 0` = « à la date portée ». */
authAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PanelAuthAttempt = mongoose.model('PanelAuthAttempt', authAttemptSchema);

export default PanelAuthAttempt;
