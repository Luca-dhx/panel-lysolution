// LE MODÈLE D'ACCROCHE — ce qu'on écrit AVANT de connaître le destinataire.
//
// ══ CE QU'IL N'EST PAS ══════════════════════════════════════════════════════
//
// Ce n'est pas un message. Un message (`prospect.messages`) est adressé à
// QUELQU'UN, à une date, sur un canal donné ; un modèle n'est adressé à
// personne. Les ranger ensemble aurait obligé à inventer un prospect « aucun »
// pour porter les modèles, puis à l'exclure de tous les comptes.
//
// La parenté reste visible : mêmes champs — un canal, un titre, un corps — plus
// une DESCRIPTION, qui n'a de sens que sur un modèle. Elle répond à « quand
// s'en sert-on ? », question qu'un message envoyé ne pose pas.
//
// ══ RIEN N'ENVOIE ══════════════════════════════════════════════════════════
//
// Le Panel n'expédie aucun message. Un modèle se copie, se colle, et part par
// l'outil de son choix.
import mongoose from 'mongoose';

const templateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    /** Texte libre : « e-mail », « LinkedIn », « au téléphone ». Voir le modèle
     *  de message : une liste fermée forcerait « Autre » une fois sur deux. */
    channel: { type: String, default: '', trim: true },
    /** À QUOI SERT CE MODÈLE — pas son contenu, son usage. */
    description: { type: String, default: '', trim: true },
    body: { type: String, default: '' },
    /** `null` = à la racine. Un modèle sans dossier reste un modèle. */
    folderId: { type: String, default: null, index: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

templateSchema.index({ folderId: 1, title: 1 });

export const PanelProspectTemplate = mongoose.model('PanelProspectTemplate', templateSchema);
export default PanelProspectTemplate;
