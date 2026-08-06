// REGISTRE DES PORTS APPLICATIFS — LOT 9.
//
// ══ POURQUOI UN REGISTRE, ET PAS UN CHAMP SUR LA DESTINATION ════════════════
//
// Le port vivait sur la fiche de la destination, et son attribution suivait
// une règle purement locale : « le plus haut déjà attribué en base, plus un ».
// Cette règle ne regarde que les fiches que le Panel connaît. Elle ignore les
// process encore en ligne dont la fiche a disparu, les sockets ouvertes par
// d'autres programmes, et les services système.
//
// C'est exactement ce qui a cassé la production : la fiche de
// `panel.lycarz.com` supprimée, le port 5100 est redescendu dans la plage
// libre et a été réattribué — alors que l'ancien backend le DÉTENAIT toujours.
// Le nouveau service a bouclé sur EADDRINUSE plus de 7 000 fois.
//
// Un registre change la nature de l'objet : le port n'est plus un attribut
// d'une fiche, c'est une RESSOURCE avec un propriétaire, un état et une
// histoire. On peut alors dire « ce port est réservé mais pas encore actif »,
// « il est en cours de libération », « il a été vérifié à telle heure » —
// autant de phrases qu'un simple entier ne pouvait pas porter.
//
// ══ LA PORTÉE EST LE SERVEUR ════════════════════════════════════════════════
//
// Deux destinations sur DEUX serveurs différents peuvent porter le même port
// sans se gêner : un port est une ressource du serveur, pas du Panel. Le
// registre est donc indexé par `serverKey` — ignorer cette portée reviendrait
// à interdire des configurations parfaitement saines, et à donner une fausse
// impression de rigueur.
import mongoose from 'mongoose';

const reservationSchema = new mongoose.Schema(
  {
    /** Le serveur qui possède ce port (hôte SSH, normalisé). */
    serverKey: { type: String, required: true, lowercase: true, trim: true },
    port: { type: Number, required: true, min: 1, max: 65535 },

    /** À QUI ce port appartient — déclaré, jamais deviné. */
    deploymentTargetId: { type: String, default: null, index: true },
    projectIdentityId: { type: String, default: null },
    /** Hôte de la destination — pour lire le registre sans jointure. */
    host: { type: String, default: null, lowercase: true },
    environment: { type: String, enum: ['TEST', 'PROD'], required: true },

    /**
     * QUOI écoute sur ce port. Aujourd'hui le backend applicatif ; demain un
     * worker ou un service annexe. Le nommer évite d'avoir à le deviner.
     */
    serviceType: { type: String, default: 'backend' },

    /**
     * ÉTAT DE LA RÉSERVATION.
     *
     *   RESERVED  le port est retenu, aucun process ne le détient encore ;
     *   ACTIVE    un PID connu détient RÉELLEMENT le port — prouvé ;
     *   RELEASING la libération est engagée, la preuve n'est pas faite ;
     *   RELEASED  le port est rendu à la plage libre.
     *
     * `RELEASING` mérite son existence : entre l'arrêt d'un service et la
     * constatation que le port est libre, il existe un intervalle où le
     * déclarer libre serait un mensonge — et où l'attribuer à une autre
     * destination reproduirait l'incident.
     */
    status: {
      type: String,
      enum: ['RESERVED', 'ACTIVE', 'RELEASING', 'RELEASED'],
      default: 'RESERVED',
      index: true,
    },

    reservedAt: { type: String, required: true },
    activatedAt: { type: String, default: null },
    releasedAt: { type: String, default: null },

    /** Ce que le serveur a montré la dernière fois qu'on a regardé. */
    processName: { type: String, default: null },
    pid: { type: Number, default: null },
    lastVerifiedAt: { type: String, default: null },
    /** Dernier constat contradictoire (port détenu par un inconnu, etc.). */
    lastConflict: { type: mongoose.Schema.Types.Mixed, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * UN SEUL PROPRIÉTAIRE VIVANT PAR PORT ET PAR SERVEUR.
 *
 * L'index est PARTIEL : une réservation `RELEASED` conserve sa ligne — c'est
 * l'histoire du port, et elle sert à répondre « qui l'avait avant ? » — mais
 * ne réserve plus rien.
 *
 * C'est cet index qui rend la réservation TRANSACTIONNELLE : deux créations
 * simultanées visant le même port ne peuvent pas réussir toutes les deux. La
 * seconde reçoit une erreur de doublon et recommence sur le port suivant, au
 * lieu d'écrire par-dessus la première.
 */
// Le filtre s'énonce en `$in` et non en `$ne` : MongoDB refuse une négation
// dans un index partiel. Énumérer les états VIVANTS dit d'ailleurs mieux ce
// qu'on veut — « ces trois états retiennent le port » — qu'une exclusion.
reservationSchema.index(
  { serverKey: 1, port: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['RESERVED', 'ACTIVE', 'RELEASING'] } },
  },
);

reservationSchema.index({ serverKey: 1, status: 1 });

export default mongoose.model('PanelPortReservation', reservationSchema);
