// LE PROSPECT — quelqu'un à qui l'on n'a encore rien vendu.
//
// ══ CE QU'IL N'EST PAS, ET IL FAUT COMMENCER PAR LÀ ═════════════════════════
//
// Le Panel connaît déjà deux voisins immédiats, et les confondre coûte cher :
//
//   PanelProject        une INSTANCE technique appairée. Elle existe, elle
//                       tourne, elle a une adresse et un pont.
//   PanelClientCompany  une PERSONNE MORALE à qui l'on facture. Elle a un
//                       SIREN, une adresse, un signataire.
//
// Un prospect n'est ni l'un ni l'autre : il n'a pas de site, pas de contrat,
// souvent pas même de raison sociale vérifiée. Le ranger dans l'une de ces deux
// collections aurait obligé à inventer des champs vides — un SIREN qu'on ne
// connaît pas, un projet qui n'existe pas — puis à filtrer partout pour ne pas
// facturer quelqu'un qui n'a jamais rien signé.
//
// ══ LE STATUT EST MANUEL, ET C'EST UNE DÉCISION ════════════════════════════
//
// Aucune règle ne fait avancer un prospect toute seule. Ni le temps, ni une
// réunion tenue, ni un e-mail envoyé : c'est un jugement commercial, et il
// appartient à la personne qui suit l'affaire. Un automatisme se tromperait
// silencieusement, et pire, ferait croire l'affaire vivante alors qu'elle est
// morte depuis six semaines.
//
// Ce qui est conservé, en revanche, c'est l'HISTOIRE des changements : qui a
// bougé le curseur, quand, et depuis quel état. Un pipeline sans historique ne
// permet pas de dire pourquoi une affaire a stagné.
//
// ══ CE QUI SORT D'ICI ══════════════════════════════════════════════════════
//
// Rien. Aucune route du pont n'expose les prospects, et la synchronisation ne
// les transporte pas. Ce sont nos notes commerciales : les publier chez un
// client reviendrait à lui montrer notre carnet d'adresses.
import mongoose from 'mongoose';

/**
 * LES CINQ ÉTATS, ET RIEN D'AUTRE.
 *
 * Une liste fermée plutôt qu'un texte libre : c'est ce qui rend le pipeline
 * agrégeable. « en cours » et « En Cours » saisis à la main auraient produit
 * deux colonnes dans le même tableau.
 */
export const PROSPECT_STATUS = Object.freeze({
  WAITING: 'WAITING',
  IN_PROGRESS: 'IN_PROGRESS',
  PLANNED: 'PLANNED',
  LOST: 'LOST',
  SIGNED: 'SIGNED',
});

export const PROSPECT_STATUS_VALUES = Object.freeze(Object.values(PROSPECT_STATUS));

/**
 * LA NATURE DE L'AFFAIRE — et pourquoi ce n'est pas un statut de plus.
 *
 * ══ DEUX AXES, PARCE QUE DEUX QUESTIONS ═════════════════════════════════════
 *
 *   `status`  OÙ EN EST-ON ?   il bouge, c'est tout son intérêt.
 *   `type`    QUE FAIT-ON ?    il ne bouge presque jamais : soit le prospect a
 *                              déjà un site, soit il n'en a pas.
 *
 * Les fondre dans une seule liste aurait produit dix états (« refonte en
 * cours », « conception en cours », …) : le pipeline serait devenu illisible,
 * et compter « combien d'affaires en cours » aurait demandé d'additionner deux
 * colonnes.
 *
 * ── CE QUE LE TYPE CHANGE POUR L'ÉQUIPE ─────────────────────────────────────
 * Tout, en réalité : une REFONTE part d'un existant — il y a un contenu à
 * reprendre, un référencement à ne pas casser, un domaine déjà en service. Une
 * CONCEPTION part de rien. Ce ne sont ni le même devis, ni les mêmes questions
 * au premier rendez-vous.
 *
 * ── LE DÉFAUT EST « CONCEPTION », ET LES LECTURES NE S'Y FIENT PAS ─────────
 * Les fiches créées avant ce champ ne le portent pas du tout, et `.lean()`
 * n'applique aucun défaut de schéma : l'interface reçoit alors `undefined`.
 * Elle retombe donc explicitement sur `CREATION` — même précaution que
 * `subjectType` sur les réunions, pour la même raison : pas de migration.
 */
export const PROSPECT_TYPE = Object.freeze({
  /** Il n'a pas de site : on en crée un. */
  CREATION: 'CREATION',
  /** Il en a déjà un : on le refait. */
  REDESIGN: 'REDESIGN',
});

export const PROSPECT_TYPE_VALUES = Object.freeze(Object.values(PROSPECT_TYPE));

/**
 * TOUTES LES TRANSITIONS SONT PERMISES — y compris les retours en arrière.
 *
 * Une affaire perdue se rouvre, un « signé » cliqué par erreur se corrige, un
 * rendez-vous planifié qui tombe à l'eau redevient « en cours ». Une machine à
 * états qui l'interdirait ne rendrait pas le pipeline plus vrai : elle
 * pousserait à créer un doublon pour dire le contraire.
 *
 * Ce qui protège l'information n'est donc pas l'interdiction, mais la TRACE.
 */
const statusChangeSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    from: { type: String, default: null },
    to: { type: String, required: true },
    actorEmail: { type: String, default: null },
    note: { type: String, default: null },
  },
  { _id: false },
);

/**
 * UN LIEN — autant qu'on veut, et chacun porte son propre nom.
 *
 * ── POURQUOI UNE LISTE D'OBJETS, ET NON UN CHAMP TEXTE ──────────────────────
 * Un prospect arrive avec son site, sa page Google, son Instagram, le devis
 * d'un concurrent, un dossier partagé. Les empiler dans une zone de texte les
 * rendrait non cliquables et impossibles à retirer un par un.
 *
 * `id` est ce qui permet de corriger ou de supprimer UN lien sans réécrire la
 * liste entière — la même raison qui a fait de `participants` une liste.
 */
const linkSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, default: '', trim: true },
    url: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/**
 * UNE IMAGE — la devanture, une capture, une carte de visite photographiée.
 *
 * On conserve le CHEMIN RELATIF (`/uploads/…`) rendu par l'autorité média,
 * jamais une adresse absolue : l'identité d'un média ne dépend pas du domaine
 * depuis lequel on le regarde. C'est la règle déjà appliquée à la fiche
 * d'entreprise, et la raison pour laquelle un logo importé depuis un poste de
 * développement reste visible sur le Panel déployé.
 */
const imageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    url: { type: String, required: true, trim: true },
    filename: { type: String, default: null },
    caption: { type: String, default: '', trim: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * UN CHAMP D'INFORMATION LIBRE — un nom, un contenu.
 *
 * ══ POURQUOI PAS DES COLONNES EN DUR ═══════════════════════════════════════
 *
 * Parce qu'on ne sait pas d'avance ce qu'on notera. « Budget annoncé »,
 * « hébergeur actuel », « qui décide », « rendez-vous pris par » : chaque
 * affaire apporte ses propres questions, et figer une liste obligerait à
 * migrer le modèle chaque fois qu'une nouvelle apparaît. Le prix payé est
 * qu'aucun de ces champs n'est interrogeable finement — ce sont des NOTES
 * structurées, pas des critères de recherche.
 *
 * L'ordre est celui du tableau, comme pour les liens : réordonner, c'est
 * renvoyer la liste dans le nouvel ordre.
 */
const infoFieldSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    value: { type: String, default: '', trim: true },
  },
  { _id: false },
);

/**
 * UN MESSAGE — envoyé, ou à envoyer.
 *
 * ══ LE CANAL EST DU TEXTE LIBRE, ET C'EST VOULU ════════════════════════════
 *
 * On écrit « e-mail », « LinkedIn », « SMS », « au téléphone », « via son
 * associé ». Une liste fermée aurait forcé à choisir « Autre » dans la moitié
 * des cas, et « Autre » ne dit rien à celui qui relit six mois plus tard.
 *
 * ══ LE TITRE EST INTERNE ═══════════════════════════════════════════════════
 *
 * « Premier contact », « relance 1 », « après le rendez-vous » : il sert à
 * retrouver le message dans la liste, jamais à être envoyé. Le contenu, lui,
 * est ce qui part vraiment.
 *
 * ══ `sentAt` PORTE L'ÉTAT, ET AUCUN AUTRE CHAMP NE LE DOUBLE ═══════════════
 *
 * `null` = prévu, une date = envoyé. Un booléen `sent` à côté d'une date aurait
 * permis les deux incohérences classiques — envoyé sans date, daté sans être
 * envoyé — et il aurait fallu décider laquelle des deux croire.
 *
 * Rien ici n'ENVOIE quoi que ce soit : le Panel note ce qui a été fait ailleurs.
 */
const messageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    channel: { type: String, default: '', trim: true },
    title: { type: String, default: '', trim: true },
    body: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: String, default: null },
  },
  { _id: false },
);

const prospectSchema = new mongoose.Schema(
  {
    /** Le seul champ vraiment obligatoire : un prospect sans nom n'est rien. */
    name: { type: String, required: true, trim: true },

    /**
     * COORDONNÉES — facultatives, et délibérément.
     *
     * On note un prospect au moment où on l'apprend, pas quand le dossier est
     * complet. Exiger un e-mail valide dès la création aurait fait perdre
     * exactement les affaires qu'on veut suivre : celles dont on n'a encore
     * qu'un nom griffonné.
     */
    email: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },

    /** Notes INTERNES. Elles ne sortent jamais du Panel. */
    notes: { type: String, default: '' },

    links: { type: [linkSchema], default: [] },
    images: { type: [imageSchema], default: [] },
    infoFields: { type: [infoFieldSchema], default: [] },
    messages: { type: [messageSchema], default: [] },

    status: {
      type: String,
      enum: PROSPECT_STATUS_VALUES,
      default: PROSPECT_STATUS.WAITING,
      index: true,
    },

    /**
     * CONCEPTION ou REFONTE — voir `PROSPECT_TYPE` ci-dessus.
     *
     * Le champ s'appelle `type` et non `projectType` : sur un prospect, il n'y
     * a rien d'autre à typer.
     */
    type: {
      type: String,
      enum: PROSPECT_TYPE_VALUES,
      default: PROSPECT_TYPE.CREATION,
      index: true,
    },
    statusHistory: { type: [statusChangeSchema], default: [] },

    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

// Le tableau se lit par état, puis par fraîcheur : c'est l'ordre dans lequel
// on travaille un pipeline.
prospectSchema.index({ status: 1, updatedAt: -1 });
// La recherche par nom sert dès la deuxième dizaine de fiches.
prospectSchema.index({ name: 1 });

export const PanelProspect = mongoose.model('PanelProspect', prospectSchema);

export default PanelProspect;
