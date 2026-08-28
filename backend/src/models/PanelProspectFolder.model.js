// LE DOSSIER — un rangement, et rien d'autre.
//
// ══ DEUX ARBRES DANS UNE SEULE COLLECTION ═══════════════════════════════════
//
// « Restaurants » range des prospects ; « Accroches froides » range des
// modèles. Ce ne sont pas les mêmes rayons, et les mélanger dans un seul arbre
// obligerait à filtrer partout — puis à expliquer, un jour, pourquoi un modèle
// est apparu dans le dossier d'un client.
//
// `kind` sépare donc les deux arbres. Une seule collection quand même : la
// mécanique est identique — un nom, un parent, un ordre — et la dupliquer
// aurait produit deux fois le même code de déplacement, de suppression et de
// détection de cycle.
//
// ══ SUPPRIMER UN DOSSIER NE SUPPRIME RIEN D'AUTRE ═══════════════════════════
//
// Ni ses sous-dossiers, ni ce qu'il contient. Tout REMONTE d'un cran. Un
// rangement n'est pas une corbeille : perdre douze prospects parce qu'on a
// retiré un intitulé de dossier serait une catastrophe silencieuse, et
// personne ne s'attend à ce qu'un classeur détruise ses feuilles.
//
// ══ CE QUI SORT D'ICI ═══════════════════════════════════════════════════════
//
// Rien. Comme la prospection dont ils organisent les notes, les dossiers ne
// passent jamais par le pont.
import mongoose from 'mongoose';

export const FOLDER_KIND = Object.freeze({
  PROSPECT: 'PROSPECT',
  TEMPLATE: 'TEMPLATE',
});
export const FOLDER_KIND_VALUES = Object.freeze(Object.values(FOLDER_KIND));

const folderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /**
     * LE PARENT, OU LA RACINE.
     *
     * `null` = à la racine de son arbre. On garde une CHAÎNE plutôt qu'un
     * `ObjectId` : l'écran manipule des identifiants sérialisés, et la
     * conversion aller-retour n'apporterait qu'une occasion de se tromper.
     */
    parentId: { type: String, default: null, index: true },
    kind: {
      type: String,
      enum: FOLDER_KIND_VALUES,
      required: true,
      index: true,
    },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

/* L'arbre se lit toujours en entier, par famille : c'est la seule requête. */
folderSchema.index({ kind: 1, parentId: 1, name: 1 });

export const PanelProspectFolder = mongoose.model('PanelProspectFolder', folderSchema);
export default PanelProspectFolder;
