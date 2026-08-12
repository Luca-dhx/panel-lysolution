import mongoose from 'mongoose';

/**
 * MOUVEMENT FINANCIER — le registre, et l'unique source du bénéfice.
 *
 * ══ CE QUE CET OBJET EST ════════════════════════════════════════════════════
 *
 * Un FAIT daté : de l'argent est entré, ou de l'argent est sorti. Ni un solde,
 * ni une facture, ni un abonnement, ni un paiement Stripe. Ces choses-là
 * PRODUIRONT des mouvements ; elles ne sont pas des mouvements.
 *
 * ══ IL N'Y A PAS DE CHAMP `profit` — ET IL NE POURRA PAS Y EN AVOIR ═════════
 *
 * Le bénéfice se CALCULE depuis les mouvements actifs, à la demande, pour une
 * période donnée (`financialSummary.service.js`). Un champ modifiable qui
 * porterait le résultat serait une seconde vérité : le jour où il diverge de la
 * somme des lignes — et il diverge toujours — plus personne ne sait laquelle
 * croire. Ici, la question ne se pose pas : il n'y a qu'une vérité, et elle est
 * dérivée.
 *
 * ══ POURQUOI CE N'EST PAS UN « StripeTransaction » ══════════════════════════
 *
 * Stripe est une SOURCE possible, au même titre qu'une saisie manuelle, un coût
 * récurrent ou une facture. Le lot L10.1 n'implémente que le manuel, mais le
 * modèle ne doit interdire aucune des autres : un mouvement porte donc son
 * `origin` et une `provenance` volontairement MAIGRE, jamais une structure
 * fournisseur recopiée. Aucune classe Stripe n'est importée par ce fichier, ni
 * par aucun service financier — c'est un invariant vérifié par la recette.
 *
 * ══ LA TAXONOMIE : DEUX AXES, ET C'EST LA DÉCISION CENTRALE DU LOT ══════════
 *
 * La tentation était un seul axe : `direction = REVENUE | COST`. Il suffit
 * aujourd'hui, et il condamne le lot L10.4.
 *
 * Le cas qui le casse est le remboursement. Un paiement de 249 € remboursé de
 * 100 € doit produire un net de +149 €, donc le remboursement doit peser
 * négativement. Avec un seul axe, il faudrait l'enregistrer en `COST` — et
 * alors le tableau « coûts d'exploitation » afficherait 100 € de charges que
 * l'entreprise n'a jamais supportées. Rendre un acompte n'est pas une dépense :
 * c'est du chiffre d'affaires qui s'annule. Un modèle qui confond les deux ne
 * ment pas sur le net ; il ment sur la marge, sur le compte de résultat, et sur
 * tout ce qu'on voudra en tirer.
 *
 * D'où deux axes ORTHOGONAUX :
 *
 *   `flow`     INFLOW | OUTFLOW      — le sens de la TRÉSORERIE.
 *                                      C'est lui, et lui seul, qui décide du
 *                                      signe dans le net.
 *
 *   `category` REVENUE | COST |      — la NATURE COMPTABLE du mouvement.
 *              REFUND | ADJUSTMENT     C'est elle qui décide dans quel total
 *                                      la ligne est comptée.
 *
 * Les combinaisons qui ont un sens :
 *
 *   REVENUE    + INFLOW    une vente, un abonnement encaissé
 *   COST       + OUTFLOW   un hébergement, une licence, un prestataire
 *   REFUND     + OUTFLOW   un remboursement — sort du compte, n'est PAS un coût
 *   ADJUSTMENT + les deux  une correction assumée, jamais une réécriture
 *
 * Un couple incohérent (`REVENUE` + `OUTFLOW`) est refusé à l'écriture par le
 * service : le schéma seul ne sait pas exprimer la contrainte croisée.
 *
 * ══ L'UTILISATEUR, LUI, NE VOIT QUE DEUX CHOIX ══════════════════════════════
 *
 * L'écran de L10.1 propose « Revenu » et « Coût ». Le second axe n'apparaît
 * nulle part : il n'a rien à demander tant qu'aucune source automatique
 * n'écrit dans le registre. La robustesse est dans le modèle, la simplicité
 * dans la saisie — et l'un n'a jamais empêché l'autre.
 *
 * ══ LE MONTANT EST TOUJOURS POSITIF ═════════════════════════════════════════
 *
 * `amountCents > 0`, sans exception. Le sens est porté par `flow`, jamais par
 * un signe. Deux porteurs du même sens finissent toujours par se contredire —
 * un `-50` en `OUTFLOW` produirait un double négatif, donc un coût qui
 * augmente le bénéfice.
 */

/** Sens de la trésorerie. Décide du SIGNE dans le net, et de rien d'autre. */
export const FLOWS = Object.freeze({ INFLOW: 'INFLOW', OUTFLOW: 'OUTFLOW' });
export const FLOW_VALUES = Object.freeze(Object.values(FLOWS));

/** Nature comptable. Décide du TOTAL dans lequel la ligne est comptée. */
export const CATEGORIES = Object.freeze({
  REVENUE: 'REVENUE',
  COST: 'COST',
  REFUND: 'REFUND',
  ADJUSTMENT: 'ADJUSTMENT',
});
export const CATEGORY_VALUES = Object.freeze(Object.values(CATEGORIES));

/**
 * Le sens IMPOSÉ par une catégorie, ou `null` quand les deux se défendent.
 *
 * `ADJUSTMENT` est le seul cas libre : une correction peut aller dans les deux
 * sens, c'est même sa raison d'être. Tout le reste est contraint, et la
 * contrainte est vérifiée à l'écriture — pas laissée à la vigilance de
 * l'appelant.
 */
export const FLOW_IMPOSED_BY_CATEGORY = Object.freeze({
  REVENUE: FLOWS.INFLOW,
  COST: FLOWS.OUTFLOW,
  REFUND: FLOWS.OUTFLOW,
  ADJUSTMENT: null,
});

/**
 * D'OÙ VIENT LE MOUVEMENT. Pas « quel fournisseur », mais « quel mécanisme
 * l'a produit » — la différence compte : `MANUAL` n'a pas de fournisseur, et
 * `RECURRING_COST` n'en aura pas davantage.
 *
 * Seul `MANUAL` est produit par le lot L10.1. Les autres valeurs sont
 * déclarées maintenant parce qu'un `enum` qui s'élargit est une migration,
 * alors qu'une valeur inutilisée ne coûte rien. Le service refuse d'ailleurs
 * d'écrire autre chose que `MANUAL` (voir `financialTransactions.service.js`).
 */
export const ORIGINS = Object.freeze({
  /** Saisi par un humain depuis le Panel. La seule origine ÉCRITE en L10.1. */
  MANUAL: 'MANUAL',
  /** Produit par un événement Stripe reçu par le plan de contrôle (L10.3). */
  STRIPE: 'STRIPE',
  /** Occurrence d'un coût récurrent, engendrée par l'ordonnanceur (L10.2). */
  RECURRING_COST: 'RECURRING_COST',
  /** Émis en regard d'une facture émise ou reçue (L10.5). */
  INVOICE: 'INVOICE',
  /** Reprise d'un historique existant, jamais un flux vivant. */
  IMPORT: 'IMPORT',
});
export const ORIGIN_VALUES = Object.freeze(Object.values(ORIGINS));

/**
 * ÉTAT DU MOUVEMENT — « ce fait est-il acquis ? ».
 *
 * `RECORDED` est le seul état que L10.1 produit : une saisie manuelle constate
 * quelque chose qui a déjà eu lieu. Les autres existent pour les sources
 * automatiques, où l'écart entre « annoncé » et « encaissé » est réel — un
 * paiement Stripe autorisé mais non capturé ne doit pas gonfler un bénéfice.
 *
 * Les agrégats ne comptent QUE `RECORDED`. C'est écrit une fois, dans
 * l'agrégateur, pour que le branchement d'une source à états n'oblige à
 * relire aucun écran.
 */
export const STATUSES = Object.freeze({
  RECORDED: 'RECORDED',
  PENDING: 'PENDING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
export const STATUS_VALUES = Object.freeze(Object.values(STATUSES));

/**
 * PROVENANCE — l'espace réservé aux sources externes, tenu volontairement
 * MAIGRE.
 *
 * Quatre champs plats, tous nuls pour un mouvement manuel. On n'y stocke ni
 * charge utile fournisseur, ni objet Stripe recopié, ni secret : une structure
 * non validée qui s'installe dans un modèle métier devient, en deux lots, le
 * schéma de fait — avec les champs du fournisseur, son vocabulaire et ses
 * ruptures de compatibilité.
 *
 * ── `environment` EST ICI, ET C'EST DÉLIBÉRÉ ────────────────────────────────
 * Une instance de Panel ne sert qu'un monde, mais un registre financier se
 * relit des années plus tard, parfois après une reprise de base. Un mouvement
 * qui ne dit pas s'il vient d'une recette ou de la production est un mouvement
 * qu'on ne peut plus auditer. Il reste `null` pour une saisie manuelle : elle
 * n'appartient à aucun monde fournisseur.
 *
 * ── CE QUI N'EST PAS ICI ────────────────────────────────────────────────────
 * Aucun modèle d'appartenance n'est dupliqué. Le lien « cette ressource Stripe
 * appartient à ce projet » existe déjà, ailleurs, et il appartient au chantier
 * Stripe (L6.2A). Ce registre porte une RÉFÉRENCE opaque, pas une autorité.
 */
const provenanceSchema = new mongoose.Schema(
  {
    /** `STRIPE`, `HOSTINGER`… — jamais renseigné pour une saisie manuelle. */
    provider: { type: String, default: null },
    /** Le monde fournisseur d'où vient le fait. `null` si aucun. */
    environment: { type: String, enum: ['TEST', 'PROD', null], default: null },
    /** L'identifiant chez le fournisseur — opaque, jamais interprété ici. */
    externalId: { type: String, default: null },
    /** Ce que cet identifiant DÉSIGNE (`payment_intent`, `invoice`, `charge`…). */
    externalKind: { type: String, default: null },
  },
  { _id: false },
);

const financialTransactionSchema = new mongoose.Schema(
  {
    /**
     * IDENTITÉ PUBLIQUE STABLE — c'est elle qui voyage dans les URL, les
     * journaux d'activité et les futures références croisées. `_id` reste
     * l'identité de stockage : les confondre lierait des documents métier à un
     * détail de MongoDB, et rendrait toute reprise de base destructrice.
     */
    transactionId: { type: String, required: true, unique: true },

    /**
     * À QUI CE MOUVEMENT APPARTIENT.
     *
     *   `projectId` renseigné  →  mouvement d'un projet client.
     *   `projectId` à `null`   →  mouvement propre à L.Y Solution.
     *
     * `null` n'est PAS un défaut ni un oubli : c'est le rattachement à
     * l'entreprise elle-même. Les frais de structure, les abonnements outils,
     * les revenus hors projet vivent là — et il fallait qu'ils vivent dans le
     * MÊME registre, sinon le bénéfice global exigerait d'additionner deux
     * moteurs, ce qui est précisément la fabrique des écarts inexpliqués.
     */
    projectId: { type: String, default: null },

    /**
     * LE NOM DU PROJET AU MOMENT DE LA SAISIE — pour l'audit, jamais pour la
     * jointure.
     *
     * ── POURQUOI IL EXISTE ──────────────────────────────────────────────────
     * Un registre financier se relit longtemps après. Un projet est renommé,
     * ou retiré du registre (`DELETE /api/projects/:id` existe et supprime la
     * fiche). Sans instantané, une ligne de 2 400 € désignerait un identifiant
     * dont plus rien ne dit à qui il correspondait : un export comptable
     * illisible, et une écriture qu'on ne sait plus justifier.
     *
     * Le précédent existe dans le Panel : `PanelProjectEvent.projectName` et
     * `PanelContractAction.projectName` portent le même instantané, pour la
     * même raison.
     *
     * ── CE QU'IL N'EST JAMAIS ───────────────────────────────────────────────
     * L'AUTORITÉ. Aucun filtre, aucun agrégat, aucune permission ne s'appuie
     * dessus. `projectId` reste la seule référence ; l'affichage préfère
     * toujours le nom VIVANT du registre quand la fiche existe encore, et ne
     * retombe sur l'instantané que lorsqu'elle a disparu.
     */
    projectNameSnapshot: { type: String, default: null },

    // ── TAXONOMIE — deux axes, voir l'en-tête de ce fichier ─────────────────
    flow: { type: String, enum: FLOW_VALUES, required: true },
    category: { type: String, enum: CATEGORY_VALUES, required: true },
    origin: { type: String, enum: ORIGIN_VALUES, required: true, default: ORIGINS.MANUAL },
    status: { type: String, enum: STATUS_VALUES, required: true, default: STATUSES.RECORDED },

    /** Ce que la ligne dit en un coup d'œil. Obligatoire : « (sans nom) » n'audite rien. */
    label: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    /**
     * LE MONTANT, EN CENTIMES ENTIERS ET TOUJOURS POSITIF.
     * Convention et refus de saisie : `services/finance/money.js`.
     */
    amountCents: { type: Number, required: true },
    currency: { type: String, required: true, default: 'EUR' },

    /**
     * LA DATE DU FAIT — celle qui compte pour la comptabilité, saisie par
     * l'utilisateur. Distincte de `createdAt` (quand on l'a enregistrée), qui
     * peut être des semaines plus tard. Toutes les périodes bornent
     * `effectiveDate` ; aucune ne borne `createdAt`.
     */
    effectiveDate: { type: Date, required: true },

    /**
     * LE MOUVEMENT DONT CELUI-CI DÉCOULE — vide en L10.1.
     *
     * C'est le champ qui rend la doctrine de remboursement possible sans
     * réécrire l'histoire : le paiement reste `+249 €` pour toujours, et le
     * remboursement est une ligne SÉPARÉE de `100 €` qui le désigne. Le net
     * tombe à 149 € par addition, jamais par mutation.
     *
     * Il porte un `transactionId`, jamais un `_id` : une reprise de base ne
     * doit pas casser le lien.
     */
    parentTransactionId: { type: String, default: null },

    provenance: { type: provenanceSchema, default: () => ({}) },

    /* ── L10.2 — CE QUI RELIE UNE OCCURRENCE À SA RÈGLE ──────────────────── */

    /**
     * LA DÉFINITION QUI A PRODUIT CE MOUVEMENT — `null` pour une saisie.
     *
     * `origin` dit DE QUEL GENRE de source il vient (`RECURRING_COST`) ;
     * `sourceId` dit LAQUELLE. Les deux sont nécessaires : le genre seul ne
     * permet pas de remonter à la règle, et l'identifiant seul ne dirait pas
     * dans quelle collection le chercher.
     */
    sourceId: { type: String, default: null },

    /**
     * LE CYCLE QUE CE MOUVEMENT MATÉRIALISE — `AAAA-MM-JJ`, ou `null`.
     *
     * ══ C'EST LA MOITIÉ DE LA CLÉ D'IDEMPOTENCE ═══════════════════════════
     *
     * Avec `sourceId`, il forme l'identité métier d'une occurrence. L'index
     * unique posé plus bas rend structurellement impossible d'écrire deux fois
     * « Brevo, cycle 2026-09 » — quel que soit ce qui l'a tenté : un
     * redémarrage, deux ouvertures d'écran simultanées, un second worker, une
     * reprise après coupure, un redéploiement.
     *
     * Une vérification `findOne` suivie d'un `create` n'aurait rien garanti :
     * deux requêtes concurrentes passent toutes deux le `findOne` avant que
     * l'une n'écrive. La garantie doit vivre dans la base.
     */
    cycleKey: { type: String, default: null },

    /**
     * LA RÉVISION APPLIQUÉE LORS DE LA MATÉRIALISATION.
     *
     * Ce n'est pas une relation vivante : les valeurs financières de ce
     * mouvement (`label`, `description`, `amountCents`) sont un INSTANTANÉ pris
     * au moment où il a été créé ou révisé. Ce numéro dit seulement laquelle
     * des révisions de la règle a produit cet instantané — de quoi expliquer
     * un écart sans avoir à le recalculer.
     */
    sourceRevision: { type: Number, default: null },

    /**
     * LE JUSTIFICATIF — une RÉFÉRENCE au protocole Media, jamais un chemin.
     *
     * ══ POURQUOI SEULEMENT UN `mediaId` ══════════════════════════════════
     *
     * Le nom du fichier, son type, son poids et son empreinte vivent dans
     * `PanelMedia` : les recopier ici en ferait une seconde vérité, qui
     * divergerait au premier remplacement de pièce. La transaction dit QUEL
     * document la justifie ; le protocole Media dit ce QU'EST ce document.
     *
     * Il n'y a délibérément AUCUN champ d'URL, de chemin ni de nom de fichier.
     * Un `receiptUrl` en `/uploads/…` rendrait la facture publique — c'est
     * exactement la réserve qui a fait reporter les justificatifs au lot L10.1,
     * et un contrôle de recette interdit désormais d'en réintroduire un.
     *
     * `attachedAt`/`attachedBy` sont ici, et non dans le média : ils datent
     * l'ACTE de rattachement à CETTE ligne, qui n'est pas l'import du fichier.
     */
    receipt: {
      mediaId: { type: String, default: null },
      attachedAt: { type: Date, default: null },
      attachedBy: { type: String, default: null },
    },

    /**
     * SUPPRESSION LOGIQUE — un fait financier ne s'efface pas.
     *
     * `deletedAt` renseigné retire la ligne des listes ET des agrégats, sans
     * toucher au document. Une pièce comptable supprimée reste une pièce
     * comptable : la question « pourquoi ce mois a-t-il changé ? » doit rester
     * répondable, et un `deleteOne` ne répond jamais.
     */
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
    deletionReason: { type: String, default: null },

    /** Qui a saisi, qui a corrigé. Jamais « le système » pour un acte manuel. */
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

/**
 * INDEX — trois, et chacun sert une requête RÉELLEMENT écrite dans ce lot.
 *
 * L'ordre des clés n'est pas cosmétique : égalités d'abord, tri ensuite. C'est
 * ce qui permet à MongoDB de servir le filtre ET le tri sans passer par une
 * étape de tri en mémoire — la limite des 32 Mo qu'on ne découvre jamais en
 * recette, toujours en production.
 *
 * `deletedAt` figure dans les deux index composés parce qu'il est présent dans
 * CHAQUE lecture par défaut : l'omettre obligerait à relire des documents
 * supprimés pour les écarter ensuite.
 *
 * Ce qui n'est PAS indexé, et pourquoi :
 *   · `parentTransactionId` — aucune requête ne le lit en L10.1. L'index
 *     viendra avec le lot qui remonte les remboursements d'un paiement (L10.4).
 *   · `category` / `origin` — filtres résiduels appliqués sur un ensemble déjà
 *     réduit par le projet et la période. Les indexer maintenant coûterait à
 *     chaque écriture pour un gain nul à cette échelle.
 */

// La fiche projet : « les mouvements de CE client, sur cette période ».
financialTransactionSchema.index({ projectId: 1, deletedAt: 1, effectiveDate: -1 });
// La page globale : « tous les mouvements, sur cette période ».
financialTransactionSchema.index({ deletedAt: 1, effectiveDate: -1 });

/**
 * L'INDEX QUI REND UN DOUBLON IMPOSSIBLE (L10.2).
 *
 * ══ CE QU'IL GARANTIT, ET POURQUOI IL FALLAIT LA BASE POUR LE FAIRE ═════════
 *
 * Une occurrence est identifiée par sa règle et son cycle. Cet index rend
 * l'écriture d'un second « Brevo · 2026-09-01 » structurellement impossible :
 * la base refuse, quelle que soit la course. Deux matérialiseurs simultanés,
 * un redémarrage au mauvais moment, un retry, deux onglets — tous se heurtent
 * au même mur, et le second reçoit une erreur de clé dupliquée que le service
 * traite comme « déjà fait ».
 *
 * ══ IL COUVRE AUSSI LES OCCURRENCES SUPPRIMÉES, ET C'EST ESSENTIEL ══════════
 *
 * Aucun `deletedAt: null` dans le filtre partiel. Un cycle annulé par un
 * « arrêt actuel » garde donc sa clé occupée : le matérialiseur ne peut pas le
 * recréer au passage suivant. Filtrer sur les vivants aurait fait ressusciter,
 * à la première relecture, exactement le coût que l'utilisateur venait de
 * retirer de ses totaux.
 *
 * Le filtre partiel ne retient que les documents qui portent RÉELLEMENT les
 * deux champs : les saisies manuelles, qui les ont à `null`, sont hors index —
 * sans quoi elles entreraient toutes en collision sur `(null, null)`.
 */
financialTransactionSchema.index(
  { sourceId: 1, cycleKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceId: { $type: 'string' },
      cycleKey: { $type: 'string' },
    },
  },
);

export const PanelFinancialTransaction = mongoose.model(
  'PanelFinancialTransaction',
  financialTransactionSchema,
);

export default PanelFinancialTransaction;
