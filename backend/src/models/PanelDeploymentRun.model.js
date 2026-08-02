// EXÉCUTION DE DÉPLOIEMENT — Phase 4.
//
// Un run est la source de vérité d'une tentative : sa checklist vivante, ses
// journaux, son résultat.
//
// ── POURQUOI TOUT EST PERSISTÉ, ET RIEN EN MÉMOIRE ──────────────────────────
// Le Panel peut se déployer LUI-MÊME. Le déploiement redémarre alors le
// processus qui l'exécute : un run tenu en RAM, ou diffusé par un flux HTTP
// ouvert, disparaîtrait au milieu — et l'opérateur ne saurait jamais si sa
// mise en ligne a abouti.
//
// Chaque étape et chaque ligne de journal sont donc écrites en base au fil de
// l'eau, par un processus DÉTACHÉ qui survit au redémarrage du backend.
// L'interface ne fait que LIRE ce document. C'est moins élégant qu'un flux
// temps réel, et c'est la seule façon d'être correct ici.
import mongoose from 'mongoose';

const stepSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, default: null },
    order: { type: Number, default: 0 },
    // pending · running · ok · warning · error · skipped
    status: { type: String, default: 'pending' },
    startedAt: { type: String, default: null },
    finishedAt: { type: String, default: null },
    durationMs: { type: Number, default: null },
    message: { type: String, default: null },
    errorCode: { type: String, default: null },
  },
  { _id: false },
);

const logSchema = new mongoose.Schema(
  {
    at: { type: String, required: true },
    level: { type: String, enum: ['INFO', 'WARNING', 'ERROR'], default: 'INFO' },
    message: { type: String, required: true },
  },
  { _id: false },
);

/**
 * JOURNAL ORDONNÉ des évènements du run — la pièce qui rend le suivi temps
 * réel REPRENABLE.
 *
 * `steps` porte l'ÉTAT COURANT (la checklist telle qu'elle doit s'afficher) ;
 * ce journal porte la SUITE DES CHANGEMENTS, chacun numéroté. Ce n'est pas un
 * doublon de stockage : on ne peut pas reprendre un flux à partir d'un état,
 * seulement à partir d'un journal. Un client déconnecté — c'est le cas NORMAL
 * quand le Panel se déploie lui-même et redémarre son backend — se reconnecte
 * avec le dernier `seq` reçu et reprend exactement où il en était : aucune
 * perte, aucun doublon, aucun réordonnancement.
 */
const eventSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true },
    at: { type: String, required: true },
    // step · log · status
    kind: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const runSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true },
    targetId: { type: String, required: true },
    targetName: { type: String, default: null },
    url: { type: String, default: null },
    host: { type: String, default: null },
    environment: { type: String, enum: ['TEST', 'PROD'], required: true },

    // CONNECTION_TEST · PRECHECK · SIMULATION · DEPLOYMENT · ROLLBACK
    operationType: { type: String, required: true },

    // running · ok · warning · error · interrupted
    //
    // `interrupted` mérite son existence : un run dont le processus est mort
    // sans écrire de conclusion n'est ni réussi ni échoué — il est de statut
    // INCONNU, et le dire est plus honnête que de trancher.
    status: { type: String, default: 'running' },

    steps: { type: [stepSchema], default: [] },
    log: { type: [logSchema], default: [] },

    // Journal reprenable + compteur monotone. `eventSeq` est incrémenté par
    // l'opération d'écriture elle-même : deux écritures concurrentes ne
    // peuvent donc pas obtenir le même numéro.
    events: { type: [eventSchema], default: [] },
    eventSeq: { type: Number, default: 0 },

    startedAt: { type: String, required: true },
    finishedAt: { type: String, default: null },
    durationMs: { type: Number, default: null },

    version: { type: String, default: null },
    releaseId: { type: String, default: null },
    deployedUrl: { type: String, default: null },

    summary: { type: String, default: null },
    error: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── LE RAPPORT ──────────────────────────────────────────────────────
    // Produit par le moteur lui-même (`report/RunRecorder` + `markdown`),
    // pas reconstruit ici : le Panel n'a aucune raison d'avoir sa propre
    // idée de ce qu'est un rapport de déploiement.
    //
    // Persisté avec le run pour rester relisible des mois plus tard, y
    // compris après un redémarrage du backend — c'est la pièce d'audit.
    structuredReport: { type: mongoose.Schema.Types.Mixed, default: null },
    markdownReport: { type: String, default: null },

    user: { type: String, default: null },

    // ── SURVEILLANCE DU PROCESSUS DÉTACHÉ ───────────────────────────────
    // Le worker bat la mesure. Un run `running` dont le battement date
    // permet de conclure que son processus est mort — sans quoi un run
    // resterait « en cours » indéfiniment après un plantage.
    workerPid: { type: Number, default: null },
    workerHeartbeatAt: { type: String, default: null },
    // Vrai quand ce run déploie le Panel qui l'a lancé : l'interface doit
    // prévenir que le backend va redémarrer sous les pieds de l'opérateur.
    selfDeployment: { type: Boolean, default: false },
  },
  { minimize: false, versionKey: false },
);

runSchema.index({ targetId: 1, startedAt: -1 });
runSchema.index({ status: 1 });

export default mongoose.model('PanelDeploymentRun', runSchema);
