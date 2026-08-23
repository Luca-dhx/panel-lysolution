// LE REJEU D'UNE ÉCRITURE GARÉE — la causalité, conservée côté autorité.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Rejeu d'une lettre morte ».
//
// ── POURQUOI LA CAUSALITÉ VIT ICI, ET PAS DANS L'ÉCRITURE REJOUÉE ───────────
//
// Le rejeu republie le MÊME fait canonique, sous un NOUVEAU `writeId`. C'est ce
// qui lui permet de traverser le pipeline NORMAL : le projet le consomme sans
// savoir qu'il s'agit d'un rejeu, par le même tirage, les mêmes applicateurs,
// la même idempotence. Un chemin spécial qui contournerait les applicateurs
// prouverait quelque chose d'autre que ce qu'on veut prouver.
//
// Le contrat de pont est `.strict()` des deux côtés : y glisser un
// `replayOfWriteId` exigerait une version de contrat, sur les deux dépôts, pour
// une information dont le projet n'a aucun usage. Elle reste donc chez celui
// qui décide du rejeu — le Panel.
//
// ── CE QUE CE MODÈLE N'EST PAS ──────────────────────────────────────────────
//
// Ce n'est pas la lettre morte. La lettre morte vit chez le PROJET, qui seul
// sait ce qu'il n'a pas su appliquer. Ce document dit : « on a demandé un
// rejeu, le voici, et voilà ce qu'il a produit ».
import mongoose from 'mongoose';

/** États d'une demande de rejeu. Fermé. */
export const REPLAY_STATUS = Object.freeze({
  /** Republié : une nouvelle écriture est au journal, en attente de consommation. */
  REPUBLISHED: 'REPUBLISHED',
  /** Le projet l'a consommée — son curseur a dépassé la nouvelle séquence. */
  ACKNOWLEDGED: 'ACKNOWLEDGED',
});

export const REPLAY_STATUS_VALUES = Object.freeze(Object.values(REPLAY_STATUS));

const replaySchema = new mongoose.Schema(
  {
    replayId: { type: String, required: true, unique: true },
    projectId: { type: String, required: true },

    /** L'écriture d'ORIGINE — celle que le projet a garée. */
    replayOfWriteId: { type: String, required: true },
    /** Sa séquence d'origine au journal : ce qui permet de la retrouver. */
    replayOfSeq: { type: Number, default: null },

    /** L'écriture REPUBLIÉE — nouvelle identité technique, même fait métier. */
    newWriteId: { type: String, required: true },
    newSeq: { type: Number, required: true },

    /** Ce que le fait désigne — pour l'écran, sans jamais la charge utile. */
    entityType: { type: String, default: null },
    entityId: { type: String, default: null },

    /**
     * COMBIEN DE FOIS ON A DÉJÀ REJOUÉ CETTE ÉCRITURE.
     *
     * Un rejeu peut échouer à son tour et se garer de nouveau. Le compte dit
     * qu'on s'acharne — et un opérateur qui le voit monter sait qu'il ne s'agit
     * plus d'un incident passager mais d'un défaut à corriger.
     */
    attempt: { type: Number, default: 1 },

    status: { type: String, enum: REPLAY_STATUS_VALUES, default: REPLAY_STATUS.REPUBLISHED },
    requestedAt: { type: String, required: true },
    requestedBy: { type: String, default: null },
    acknowledgedAt: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * ══ UN SEUL REJEU EN VOL PAR ÉCRITURE GARÉE ═════════════════════════════════
 *
 * Deux clics sur « Rejouer » ne doivent pas produire deux republications : le
 * projet appliquerait deux fois le même fait, et l'opérateur verrait deux
 * lignes pour un seul geste. L'index partiel ne contraint que les rejeux
 * ENCORE en vol — une fois acquitté, on peut légitimement rejouer à nouveau si
 * l'écriture s'est garée une seconde fois.
 *
 * C'est l'index qui tranche, pas une lecture préalable : deux requêtes
 * simultanées passeraient toutes deux un test d'existence.
 */
replaySchema.index(
  { projectId: 1, replayOfWriteId: 1 },
  {
    unique: true,
    name: 'uniq_replay_en_vol',
    partialFilterExpression: { status: REPLAY_STATUS.REPUBLISHED },
  },
);

/** Lecture d'exploitation : « qu'a-t-on rejoué pour ce projet, récemment ? ». */
replaySchema.index({ projectId: 1, requestedAt: -1 }, { name: 'projet_recent' });

export const PanelDeadLetterReplay = mongoose.model('PanelDeadLetterReplay', replaySchema);

export default PanelDeadLetterReplay;
