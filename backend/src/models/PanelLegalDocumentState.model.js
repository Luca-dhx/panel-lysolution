// LE COMPTEUR DE PUBLICATION D'UN DOCUMENT LÉGAL — un par (projet, type).
//
// ══ POURQUOI CE MINUSCULE MODÈLE EXISTE ═════════════════════════════════════
//
// L'applicateur du projet écarte les écritures plus anciennes que celle qu'il
// applique déjà. Sans cette garde, un rattrapage désordonné — le journal se
// rejoue dans l'ordre du JOURNAL, jamais dans celui des décisions — ferait
// clignoter la page publique entre plusieurs versions avant de se stabiliser.
//
// La garde compare des NUMÉROS. Le numéro évident était `template.version`. Il
// est faux, et le défaut n'est pas théorique :
//
//     projet FJ  →  template A (version 4)      site affiche A
//     on assigne →  template B (version 1)      écriture « version 1 »
//                                               ← ÉCARTÉE : 1 <= 4
//     site affiche encore A, indéfiniment, sans message d'erreur nulle part.
//
// La version du template décrit LE TEMPLATE. Ce dont la garde a besoin décrit
// LA SUITE DES DOCUMENTS QU'UN PROJET A REÇUS — deux choses différentes, qui ne
// bougent pas aux mêmes moments.
//
// ══ POURQUOI PAS UN CHAMP SUR `PanelProject` ════════════════════════════════
//
// Parce qu'il en faudrait un PAR TYPE, donc deux, puis trois le jour d'un
// troisième document. Et surtout : un compteur s'incrémente par `$inc` atomique,
// et l'appliquer sur le document de projet ferait entrer une écriture de haute
// fréquence dans la fiche la plus lue du Panel.
//
// ══ CE N'EST PAS UNE PROJECTION ═════════════════════════════════════════════
//
// Ce modèle ne dit RIEN de ce que le projet a appliqué — seulement de ce que le
// Panel a émis. L'état d'application appartient au projet, qui le remonte par
// son identité. Confondre « envoyé » et « appliqué » est l'erreur qui fait
// croire un parc convergé.
import mongoose from 'mongoose';

import { LEGAL_DOCUMENT_TYPE_VALUES } from './PanelLegalTemplate.model.js';

const legalDocumentStateSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    type: { type: String, enum: LEGAL_DOCUMENT_TYPE_VALUES, required: true },

    /**
     * MONOTONE, jamais remis à zéro — pas même quand l'affectation est retirée
     * puis remise. Le remettre à zéro ferait émettre une « version 1 » que le
     * projet, qui en applique déjà une plus haute, écarterait pour toujours.
     */
    documentVersion: { type: Number, default: 0, min: 0 },

    createdAt: { type: String, default: null },
    updatedAt: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * UN SEUL COMPTEUR PAR COUPLE — et l'index est UNIQUE, ce qui n'est pas une
 * commodité de lecture.
 *
 * Deux publications concurrentes du même document (un enregistrement de fiche
 * cliente pendant la publication d'un template) exécuteraient deux `upsert`.
 * Sans unicité, Mongo créerait deux compteurs, chacun repartirait de 1, et la
 * garde de version du projet écarterait l'une des deux écritures au hasard.
 */
legalDocumentStateSchema.index(
  { projectId: 1, type: 1 },
  { unique: true, name: 'uniq_project_legal_document' },
);

export default mongoose.model('PanelLegalDocumentState', legalDocumentStateSchema);
