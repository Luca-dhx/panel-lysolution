import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

/**
 * IDENTITÉ D'UN PROJET — explicite, opaque, immuable.
 *
 * ── POURQUOI ELLE EXISTE ────────────────────────────────────────────────────
 * Un projet a survécu à un changement de domaine : même base, mêmes médias,
 * nouvelle destination. Rien ne disait au moteur que les deux destinations
 * étaient le même projet, et les fichiers persistants de la première n'ont donc
 * pas suivi. La vitrine s'est retrouvée sans images.
 *
 * On aurait pu le deviner — même base, domaine ressemblant, même serveur. Ce
 * serait une erreur : deux projets distincts peuvent partager une base de
 * recette, un VPS, un préfixe de domaine. Deviner reviendrait, un jour, à
 * copier les médias d'un client chez un autre.
 *
 * L'identité est donc DÉCLARÉE, jamais dérivée. Elle ne contient volontairement
 * aucune donnée métier : ni domaine, ni base, ni nom. Rien qui puisse changer,
 * rien qui invite à la reconstruire.
 *
 * ── CE QU'ELLE N'EST PAS ────────────────────────────────────────────────────
 * Ce n'est pas un identifiant affiché. L'utilisateur voit des destinations et
 * un projet ; il ne voit jamais cet UUID.
 */
const identitySchema = new mongoose.Schema(
  {
    // Opaque et stable à vie : c'est la seule chose qui relie deux
    // destinations entre elles.
    identityId: { type: String, required: true, unique: true, immutable: true, default: () => randomUUID() },

    /**
     * Étiquette de confort, pour les écrans d'administration.
     *
     * Elle n'a AUCUNE valeur d'identité : deux projets peuvent porter le même
     * libellé sans être le même, et la renommer ne change rien. Elle n'entre
     * dans aucune décision du moteur.
     */
    label: { type: String, default: null, trim: true },

    /**
     * JOURNAL DES RATTACHEMENTS — append-only.
     *
     * Rattacher une destination à un projet autorise la copie de ses médias. Un
     * tel geste doit rester explicable des mois plus tard : qui l'a déclaré,
     * quand, pour quelle destination, et sur quel motif.
     *
     * Borné par nature : quelques destinations par projet.
     */
    links: [
      {
        _id: false,
        targetId: { type: String, required: true },
        host: { type: String, required: true, lowercase: true },
        // `MIGRATION` : attribution automatique d'une identité propre au parc
        // existant. `DECLARED` : un opérateur a désigné le projet parent.
        // `REPAIR` : script de réparation ponctuel.
        origin: { type: String, enum: ['MIGRATION', 'DECLARED', 'REPAIR'], required: true },
        actor: { type: String, default: null },
        reason: { type: String, default: null },
        at: { type: String, required: true },
      },
    ],

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

export const PanelProjectIdentity = mongoose.model('PanelProjectIdentity', identitySchema);
export default PanelProjectIdentity;
