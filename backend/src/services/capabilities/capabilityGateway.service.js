// LA PASSERELLE — une seule porte, un seul ordre (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md.
//
// ── L'ORDRE, ET POURQUOI IL EST CELUI-LÀ ────────────────────────────────────
//
//   1. la capacité existe-t-elle ?            registre code-first, fail closed
//   2. qui parle ?                            jeton de pont, jamais la charge utile
//   3. quel monde ?                           runtime de l'instance (L2)
//   4. l'entrée est-elle conforme ?           schéma strict
//   5. a-t-on des identifiants ?              coffre L1
//   6. exécuter                               adaptateur, qui prouve l'appartenance
//
// · L'ENTRÉE est validée AVANT les identifiants. Un corps malformé ne doit pas
//   faire déchiffrer une clé : le coffre ne s'ouvre que pour un appel qui va
//   réellement partir.
//
// · L'ENVIRONNEMENT est résolu AVANT tout le reste. Une instance sert UN monde,
//   celui de son runtime, et personne ne le choisit — surtout pas le projet.
//
// ── CE QUI A DISPARU DE CETTE LISTE, ET POURQUOI ────────────────────────────
//
// Trois étapes ont été retirées. Aucune ne protégeait une ressource :
//
//   · L'OCTROI (`capabilityGrants`) demandait « a-t-on coché cette case pour ce
//     projet ? ». Une case cochée à la main n'établit rien : elle ne dit pas à
//     qui appartient le contrat qu'on va facturer. C'était une configuration
//     déguisée en autorisation — un projet légitime restait bloqué tant qu'un
//     opérateur n'avait pas deviné quelle case il lui manquait.
//
//   · L'OUVERTURE COMMERCIALE refusait les écritures financières et légales
//     tant qu'un opérateur n'avait pas basculé la fiche en LIVE. Décision
//     assumée de la mission de simplification : un projet appairé et configuré
//     agit sans geste supplémentaire.
//
//   · « EST-ELLE SERVIE ? » (`migrated`) n'a plus d'objet : une capacité figure
//     au registre ou n'y figure pas, et l'alignement exige un adaptateur pour
//     chacune.
//
// ── CE QUI PROTÈGE RÉELLEMENT, ET QUI N'A PAS BOUGÉ ─────────────────────────
//
// L'authentification du pont, l'accord des mondes, le contrat d'entrée strict,
// la présence des identifiants dans le coffre — et surtout l'APPARTENANCE,
// vérifiée par chaque adaptateur sur la ressource qu'il touche. C'est elle, et
// elle seule, qui empêche un projet de rembourser le paiement d'un autre : une
// case cochée ne l'a jamais fait.
//
// ── CE QUE LE PROJET NE PEUT PAS FAIRE ──────────────────────────────────────
//
// Choisir un fournisseur, un environnement, un jeu d'identifiants, une URL.
// Il choisit un VERBE et son entrée métier. Tout le reste est déduit de son
// jeton d'appairage et de l'instance qui répond.
import logger from '../../utils/logger.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import { getCapabilityDefinition, IDEMPOTENCY } from './capabilityRegistry.js';
import {
  CLAIM, DEFAULT_CONVERGENCE, claimOperation, settleSucceeded, settleFailure,
} from './operationRegistry.js';
import {
  INVOCATION_SOURCES, buildInvocationContext, buildPanelSelfContext,
  describeContext, partitionKey,
} from './invocationContext.js';
import { resolveCredentialsForCapability } from './credentialResolver.js';
/** Le registre dit, entre autres, si un fournisseur a été RETIRÉ. */
import { getProviderDefinition } from '../integratedApi/providerRegistry.js';
import { executeCapability } from './providerAdapters.js';
import {
  CAPABILITY_OUTCOMES,
  CapabilityError,
  capabilityUnknown,
  capabilityNotAvailable,
  capabilityInputInvalid,
  capabilityOperationInFlight,
  capabilityOperationUnresolved,
} from './capabilityErrors.js';

/**
 * Invoque une capacité pour le compte d'un projet AUTHENTIFIÉ.
 *
 * @param {object} args
 * @param {string} args.code           code de capacité demandé
 * @param {object} args.panelProject   fiche rendue par `requireBridgeAuth`
 * @param {object} [args.payload]      corps de la requête — NON fiable
 * @param {string} [args.requestId]
 * @param {Function} [args.fetchImpl]  injectable : les tests ne sortent pas
 * @returns {Promise<{capability, provider, environment, outcome, result, requestId, durationMs}>}
 * @throws {CapabilityError}
 */
export async function invokeCapability({
  code, panelProject, payload = {}, requestId, fetchImpl,
  /**
   * QUI DEMANDE — et c'est la seule chose que L10.4 ajoute à cette passerelle.
   *
   * `PROJECT_BRIDGE` par défaut : toute la logique de ce fichier a été écrite
   * pour un projet qui parle par le pont, et ce défaut garantit qu'aucun
   * appelant existant ne change de comportement.
   *
   * `PANEL_INTERNAL` est le Panel agissant POUR un projet sans que le projet
   * demande rien — le remboursement depuis l'onglet Finances. Le projet reste
   * le périmètre entier : appartenance, monde, identifiants et journal en
   * dépendent.
   *
   * Cette source relâchait autrefois UNE étape, l'octroi de capacité. Les
   * octrois ayant disparu, elle ne relâche plus rien : les trois sources
   * traversent désormais exactement les mêmes contrôles, et ne se distinguent
   * que par le périmètre qu'elles désignent et par ce que le journal en dit.
   */
  source = INVOCATION_SOURCES.PROJECT_BRIDGE,
}) {
  // ── 1. LA CAPACITÉ EXISTE-T-ELLE ? ────────────────────────────────────────
  // Avant même de savoir qui parle : un code inconnu ne mérite ni contexte, ni
  // lecture de fiche, ni journal d'invocation.
  const definition = getCapabilityDefinition(code);
  if (!definition) throw capabilityUnknown(code);

  /**
   * ── 1 bis. CE VERBE EST-IL OFFERT AU PONT ? (L13) ────────────────────────
   *
   * Quelques capacités ne lisent pas une ressource de projet mais le registre
   * de solde de L.Y Solution — ce que le fournisseur a prélevé. Elles n'ont
   * aucun lien d'appartenance à vérifier, parce que leur objet n'appartient à
   * aucun projet : lui en inventer un aurait produit une garde décorative.
   *
   * Le refus vit donc ici, avant tout contexte, et il est INDISTINCT d'un code
   * inconnu. Répondre « existe mais interdit » ferait du pont un oracle sur la
   * surface interne du Panel — la même raison qui fait refuser une facture
   * étrangère comme une facture inexistante (L6.3B).
   *
   * Aucun journal non plus : il n'y a rien à auditer dans un code que le pont
   * n'a jamais eu le droit de connaître, et journaliser ferait de la tentative
   * une trace utile à qui la répète.
   */
  if (definition.panelOnly && source === INVOCATION_SOURCES.PROJECT_BRIDGE) {
    throw capabilityUnknown(code);
  }

  // ── 2. QUI PARLE, ET 3. DANS QUEL MONDE ? ─────────────────────────────────
  /**
   * LA CONSTRUCTION DU CONTEXTE PEUT ELLE-MÊME REFUSER — et ce refus-là est
   * précisément celui qu'on veut lire.
   *
   * Une usurpation (`projectId` étranger) et un désaccord de monde échouent
   * ICI, avant tout le reste. Les laisser remonter sans trace serait perdre le
   * seul signal qui distingue un client mal écrit d'une tentative délibérée —
   * et c'est la ligne qu'un opérateur viendra chercher en premier.
   *
   * On journalise donc avec un contexte MINIMAL, bâti sur la seule autorité
   * dont on dispose à coup sûr : le projet que le jeton a authentifié.
   */
  let context;
  try {
    /**
     * LE PANEL POUR LUI-MÊME N'A PAS DE FICHE À AUTHENTIFIER (R10.4).
     *
     * `buildInvocationContext` exige un `panelProject` — et c'est bien : pour
     * un projet, l'absence de fiche signifie que la garde d'authentification a
     * été contournée. Le Panel écrivant à ses propres exploitants n'a pas de
     * fiche du tout, et lui en fabriquer une ferait porter son envoi par le
     * périmètre — donc par les ressources — d'un projet arbitraire.
     *
     * Le contexte est donc construit par une fonction DISTINCTE, atteignable
     * uniquement par cette source. Aucun chemin projet ne peut y arriver : la
     * source est un paramètre d'appel interne, jamais une donnée de requête.
     */
    context = source === INVOCATION_SOURCES.PANEL_SELF
      ? buildPanelSelfContext({ requestId })
      : buildInvocationContext({ panelProject, payload, requestId, source });
  } catch (error) {
    await audit(fallbackContext(panelProject, requestId), definition, {
      outcome: error instanceof CapabilityError ? error.outcome : CAPABILITY_OUTCOMES.FAILED,
      durationMs: 0,
      errorCode: error?.code ?? 'UNEXPECTED',
      operationId: typeof payload?.operationId === 'string' ? payload.operationId : null,
    });
    throw error;
  }

  try {
    // ── 4. L'ENTRÉE EST-ELLE CONFORME ? ─────────────────────────────────────
    /**
     * LA PREMIÈRE QUESTION EST DÉSORMAIS CELLE DU CONTRAT.
     *
     * Elle l'était déjà en pratique : les trois étapes qui la précédaient
     * n'interrogeaient que des états de configuration — une case cochée, un
     * booléen d'ouverture, un booléen de migration. Aucune ne regardait ce que
     * l'appel voulait faire, ni à quelle ressource il voulait le faire.
     *
     * Ce que le projet demande est validé ici ; À QUI cela appartient est
     * établi plus bas, par l'adaptateur, qui est le seul à savoir lire un
     * contrat, un client Stripe ou une zone DNS.
     */
    const input = parseInput(definition, payload);

    /**
     * ── 4 bis. QUI EXÉCUTE, RÉELLEMENT ? ────────────────────────────────────
     *
     * ══ POURQUOI CETTE ÉTAPE EXISTE ════════════════════════════════════════
     *
     * Presque toutes les capacités ont un exécutant unique et définitif : le
     * registre le déclare, et c'est fini. La signature fait exception, et
     * durablement — les nouvelles demandes partent chez le fournisseur actif,
     * les demandes historiques restent chez celui qui les détient, aussi
     * longtemps que le contrat a une valeur juridique.
     *
     * ══ POURQUOI ICI, ET PAS DANS L'ADAPTATEUR ═════════════════════════════
     *
     * Parce que le fournisseur décide QUELS IDENTIFIANTS ouvrir. Un adaptateur
     * qui découvrirait l'exécutant après coup devrait rouvrir le coffre
     * lui-même — c'est-à-dire créer une seconde porte, exactement celle que
     * `credentialResolver` existe pour empêcher.
     *
     * ══ CE QUE CETTE DÉFINITION EFFECTIVE CHANGE, ET CE QU'ELLE NE CHANGE PAS
     *
     * Elle change le fournisseur, donc le coffre, l'adaptateur, le journal et
     * l'événement d'audit — tous parlent désormais de l'exécutant RÉEL, ce qui
     * est la seule chose honnête à écrire. Elle ne change ni le code de la
     * capacité, ni ses schémas, ni ses permissions : le CONTRAT reste celui du
     * registre.
     */
    const effectiveProvider = definition.resolveProvider
      ? await definition.resolveProvider(context, input, definition.provider)
      : definition.provider;
    const executed = effectiveProvider === definition.provider
      ? definition
      : Object.freeze({ ...definition, provider: effectiveProvider });

    // ── 5. A-T-ON DES IDENTIFIANTS ? ────────────────────────────────────────
    // Les valeurs déchiffrées sont obtenues et consommées dans la même
    // expression : elles ne sont jamais liées à une variable de portée large,
    // jamais journalisées, jamais attachées à une erreur.
    /**
     * ══ UN FOURNISSEUR RETIRÉ N'A PLUS D'IDENTIFIANTS À RÉSOUDRE ══════════
     *
     * C'est ce qui fait de son retrait un retrait, et non un sursis : ses
     * rôles de credential ont disparu du registre, et ses jeux ont été
     * supprimés de la base.
     *
     * Lui demander ses identifiants produirait `CAPABILITY_CREDENTIALS_MISSING`
     * — un message qui envoie l'exploitant en saisir, c'est-à-dire exactement
     * ce que le retrait interdit, et pour une demande qui ne partira pas.
     *
     * On saute donc l'étape et on laisse l'adaptateur répondre. Il refuse en
     * nommant l'acte et en disant où regarder — la seule information utile à
     * qui cherche un contrat de l'année dernière.
     */
    const fournisseurRetire = Boolean(getProviderDefinition(executed.provider)?.retired);
    const resolved = fournisseurRetire
      ? { values: null, environment: null, credentialSetId: null }
      : await resolveCredentialsForCapability(context, executed);

    /**
     * ── 6. RÉSERVER L'OPÉRATION — LE DERNIER GESTE AVANT LE FOURNISSEUR ─────
     *
     * ══ POURQUOI ICI, ET NULLE PART AILLEURS ═══════════════════════════════
     *
     * Plus tôt, on écrirait une réservation pour des appels qui vont être
     * refusés : un projet sans octroi laisserait la trace d'un envoi qui n'a
     * jamais eu lieu, et le registre deviendrait un journal de refus. Plus
     * tard, il n'y a plus de « plus tard » — l'appel est parti.
     *
     * ══ ELLE NE CONCERNE PAS TOUTES LES CAPACITÉS ══════════════════════════
     *
     * Une lecture pure se rejoue sans conséquence, et un fournisseur qui
     * déduplique lui-même n'a pas besoin de nous. Seules les capacités dont
     * l'issue devient INDÉCIDABLE en cas de silence méritent ce coût — c'est
     * exactement ce que déclare `UNKNOWN_ON_TIMEOUT`.
     */
    /**
     * L'IDENTITÉ DE L'ACTE — fournie par le projet, ou DÉRIVÉE par le Panel.
     *
     * Presque toutes les capacités laissent le projet nommer son acte : lui
     * seul sait que deux clics sont la même intention. Quelques verbes n'ont
     * pourtant qu'une réponse correcte — « garantir que ce contrat a un
     * client » — et pour ceux-là, laisser nommer l'acte permettrait d'en
     * obtenir deux. Le registre déclare alors une dérivation, évaluée ici,
     * avant toute réservation.
     *
     * ── ELLE PEUT DÉSORMAIS ÊTRE ASYNCHRONE ────────────────────────────────
     *
     * Elle était forcément PURE, donc limitée à ce que la charge utile porte.
     * Depuis que l’autorité du client Stripe est l’ENTREPRISE CLIENTE, la
     * bonne identité d’acte se lit en base — le projet ne l’envoie pas, et il
     * ne DOIT pas l’envoyer : ce serait lui laisser nommer l’acte, donc lui
     * permettre d’en obtenir deux.
     *
     * Une dérivation synchrone aurait rendu `…:company:undefined` pour tout le
     * parc : une seule identité d’acte partagée par tous les projets. On
     * attend donc la valeur, et l’on refuse plus bas si elle manque.
     */
    const actId = definition.deriveOperationId
      ? await definition.deriveOperationId(context, input)
      : input.operationId;

    const reservation = requiresReservation(definition)
      ? await reserve(context, definition, input, actId)
      : null;

    // Déjà exécutée : on rend ce qui avait été mémorisé, et RIEN ne part.
    if (reservation?.memoized) {
      const durationMs = Date.now() - context.startedAt;
      await audit(context, executed, {
        outcome: CAPABILITY_OUTCOMES.SUCCEEDED,
        durationMs,
        operationId: actId,
        errorCode: 'REPLAYED',
      });
      return {
        capability: definition.code,
        provider: executed.provider,
        environment: context.environment,
        outcome: CAPABILITY_OUTCOMES.SUCCEEDED,
        operationId: actId,
        requestId: context.requestId,
        durationMs,
        result: reservation.memoized,
      };
    }

    // ── 7. EXÉCUTER ─────────────────────────────────────────────────────────
    let raw;
    try {
      raw = await executeCapability({
        /**
         * L'ADAPTATEUR REÇOIT LA DÉFINITION EFFECTIVE.
         *
         * Il y lit `provider` pour savoir lequel des exécutants d'un domaine
         * doit agir. Lui passer la définition du registre lui ferait servir une
         * demande historique avec le code du fournisseur actif — et les
         * identifiants, eux, seraient déjà ceux du bon. Deux vérités dans le
         * même appel : la pire configuration possible.
         */
        definition: executed,
        context,
        credentials: resolved.values,
        input,
        fetchImpl,
      });
    } catch (error) {
      /**
       * L'ÉCHEC EST CLASSÉ AVANT D'ÊTRE RELANCÉ.
       *
       * `replaySafe` distingue « il a dit non » (rien n'est parti, rejouable)
       * de « il n'a rien dit » (l'action a PEUT-ÊTRE eu lieu). Ranger le second
       * dans le premier ferait rejouer, donc doubler un envoi réel.
       */
      if (reservation) {
        await settleFailure(reservation.operation, {
          resolved: error instanceof CapabilityError ? error.replaySafe : false,
          errorCode: error?.code ?? 'UNEXPECTED',
          errorMessage: error?.message ?? '',
          httpStatus: error?.details?.httpStatus ?? null,
          durationMs: Date.now() - context.startedAt,
        }).catch(() => {});
      }
      throw error;
    }

    const result = parseOutput(definition, raw);
    const durationMs = Date.now() - context.startedAt;

    /**
     * FENÊTRE DE CRASH ASSUMÉE : entre l'acceptation par le fournisseur et
     * cette écriture, un processus tué laisse l'opération en PENDING. Le
     * passage suivant la verra « en cours » et REFUSERA de doubler plutôt que
     * de renvoyer — le bon arbitrage quand on ne sait pas.
     */
    if (reservation) {
      await settleSucceeded(reservation.operation, {
        /**
         * LA POIGNÉE DE CORRÉLATION EST DÉCLARÉE, PAS DEVINÉE.
         *
         * Chaque fournisseur nomme différemment ce qui identifie l'objet
         * produit — `providerMessageId` pour un envoi, `checkoutSessionId`
         * pour un paiement. Lire l'un puis l'autre « au cas où » ferait
         * entrer un vocabulaire fournisseur dans la passerelle ; le registre
         * dit lequel lire, et la passerelle n'en connaît aucun.
         */
        providerMessageId: (definition.correlationField
          ? result[definition.correlationField]
          : result.providerMessageId) ?? null,
        durationMs,
        /** Les coordonnées du document rendu, quand il y en a un (L11.1). */
        artefact: describeArtefact(result),
      });
    }

    await audit(context, executed, {
      outcome: CAPABILITY_OUTCOMES.SUCCEEDED,
      durationMs,
      operationId: actId ?? null,
      artefact: describeArtefact(result),
    });

    return {
      capability: definition.code,
      provider: executed.provider,
      environment: context.environment,
      outcome: CAPABILITY_OUTCOMES.SUCCEEDED,
      operationId: actId ?? null,
      requestId: context.requestId,
      durationMs,
      result,
    };
  } catch (error) {
    const durationMs = Date.now() - context.startedAt;
    const outcome = error instanceof CapabilityError ? error.outcome : CAPABILITY_OUTCOMES.FAILED;
    await audit(context, definition, {
      outcome,
      durationMs,
      errorCode: error?.code ?? 'UNEXPECTED',
      // La clé d'idempotence du projet, si elle était lisible. Elle lui permet
      // de rapprocher son propre journal du nôtre quand il vient nous demander
      // ce qui s'est passé.
      operationId: typeof payload?.operationId === 'string' ? payload.operationId : null,
    });
    throw error;
  }
}

/**
 * Contexte de SECOURS — juste assez pour tracer un refus survenu avant qu'un
 * vrai contexte ait pu exister.
 *
 * `environment` y est `null` : c'est un aveu, pas une valeur par défaut. Écrire
 * « TEST » ferait croire qu'on a résolu un monde alors que le refus porte
 * précisément sur cette résolution.
 */
function fallbackContext(panelProject, requestId) {
  return {
    projectId: panelProject?.projectId ?? null,
    environment: null,
    requestId: requestId ?? null,
    source: INVOCATION_SOURCES.PROJECT_BRIDGE,
  };
}

/* -------------------------------------------------------------------------- */
/*  RÉSERVATION D'OPÉRATION                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cette capacité doit-elle être protégée contre le doublon ?
 *
 * `SAFE_RETRY` et `NONE` se rejouent sans conséquence : rien à réserver.
 *
 * Les deux autres réservent, pour des raisons OPPOSÉES :
 *
 *   `UNKNOWN_ON_TIMEOUT`   le fournisseur n'offre aucune clé d'idempotence.
 *                          Le registre EST la garantie de non-doublon ; sans
 *                          lui, deux clics envoient deux fois.
 *
 *   `PROVIDER_IDEMPOTENT`  le fournisseur déduplique déjà — mais seulement
 *                          pendant sa fenêtre, et seulement s'il reçoit deux
 *                          fois la même clé. Le registre n'y sert pas à
 *                          dédupliquer : il sert à empêcher huit appels
 *                          concurrents de partir ensemble, et à savoir si une
 *                          reprise est encore couverte par cette fenêtre.
 *
 * ── CE QUI A CHANGÉ EN L6.2B, ET POURQUOI ───────────────────────────────────
 *
 * `PROVIDER_IDEMPOTENT` ne réservait pas : « le fournisseur s'en charge ».
 * C'était vrai de la DÉDUPLICATION, et faux de la REPRISE. Un Panel tué entre
 * l'acceptation par Stripe et l'écriture de sa propre trace ne laissait aucune
 * trace du tout — et le passage suivant, n'ayant rien à relire, repartait
 * comme si l'acte n'avait jamais eu lieu.
 */
function requiresReservation(definition) {
  return definition.idempotency === IDEMPOTENCY.UNKNOWN_ON_TIMEOUT
    || convergenceFor(definition) !== null;
}

/**
 * La politique de reprise d'une capacité, ou `null` si le doute ne se lève pas
 * tout seul. Déduite de la stratégie d'idempotence — jamais du fournisseur :
 * la passerelle ne connaît aucun nom de fournisseur, et ne doit pas commencer.
 */
function convergenceFor(definition) {
  return definition.idempotency === IDEMPOTENCY.PROVIDER_IDEMPOTENT
    ? DEFAULT_CONVERGENCE
    : null;
}

/**
 * Réclame l'opération, ou refuse.
 *
 * @returns {Promise<{operation: object, memoized: object|null}>}
 * @throws {CapabilityError} si une autre exécution la détient, ou si l'issue
 *   d'une tentative antérieure reste inconnue.
 */
async function reserve(context, definition, input, actId) {
  const outcome = await claimOperation({
    /**
     * La clé de PARTITION, pas l'identifiant d'un projet : le Panel agissant
     * pour lui-même n'en a pas, et deux actes de même nom dans deux périmètres
     * différents ne doivent pas se réserver l'un l'autre.
     */
    projectId: partitionKey(context),
    capability: definition.code,
    operationId: actId,
    environment: context.environment,
    provider: definition.provider,
    templateCode: input.templateRef ?? null,
    recipientEmail: input.recipient?.email ?? null,
    convergence: convergenceFor(definition),
  });

  switch (outcome.claim) {
    case CLAIM.EXECUTE:
      return { operation: outcome.operation, memoized: null };

    case CLAIM.CONVERGE:
      /**
       * REPRENDRE N'EST PAS REJOUER.
       *
       * L'adaptateur est réexécuté avec la MÊME entrée, et il commence par
       * chercher ce que l'acte a déjà produit. S'il trouve, il le rend sans
       * parler au fournisseur ; s'il ne trouve pas, il refait le même appel
       * avec la même clé, que le fournisseur reconnaît.
       *
       * Cette branche exige donc de l'adaptateur une propriété que le registre
       * ne peut pas vérifier : être idempotent PAR CONSTRUCTION. Elle n'est
       * ouverte qu'aux capacités `PROVIDER_IDEMPOTENT`, et l'alignement du
       * registre refuse qu'une capacité s'y déclare sans en être une.
       */
      return { operation: outcome.operation, memoized: null, converging: true };

    case CLAIM.ALREADY_SUCCEEDED:
      /**
       * ══ UN REJEU DOIT RENDRE CE QUE LA CAPACITÉ PROMET ═══════════════════
       *
       * Le rejeu rendait une forme GÉNÉRIQUE —
       * `{status, providerMessageId, operationId}` — sans passer par le schéma
       * de sortie. C'est le contrat d'`email.send_template`, et de lui seul.
       *
       * Pour une ouverture de signature, dont le contrat promet
       * `signatureRequestId`, `documentId` et les liens des signataires, cette
       * forme est un mensonge : l'appelant reçoit un objet auquel il manque
       * tout ce dont il a besoin. SB Auto y lirait `signatureRequestId:
       * undefined` et PERDRAIT la demande qu'il vient d'ouvrir — sans erreur,
       * sans journal, avec un contrat bloqué et une demande orpheline chez le
       * fournisseur.
       *
       * Le défaut ne s'était jamais vu parce que le projet se garde lui-même
       * avant d'appeler. Une garantie de la passerelle qui repose sur la
       * prudence de son appelant n'est pas une garantie.
       *
       * ── DEUX RÉPONSES POSSIBLES, ET LE REGISTRE CHOISIT ──────────────────
       *
       * Certaines capacités ne PEUVENT pas reconstituer leur sortie : un envoi
       * d'e-mail rejoué ne peut pas rendre un message qu'on n'a pas conservé,
       * et le stocker serait garder une donnée personnelle pour rien. Elles
       * gardent la mémoïsation générique — c'est leur contrat.
       *
       * D'autres SAVENT se relire. `signature.request.open` interroge d'abord
       * le lien d'appartenance : si une demande vivante existe pour ce contrat,
       * elle la rend SANS parler au fournisseur. Réexécuter l'adaptateur est
       * alors strictement plus juste que mémoïser — et strictement aussi sûr,
       * puisque l'index « une demande vivante par contrat » est ce qui l'en
       * empêche, pas la chance.
       */
      if (definition.replayByReexecution) {
        return { operation: outcome.operation, memoized: null, converging: true };
      }
      /**
       * LE REJEU NE RENVOIE RIEN, ET LE DIT.
       *
       * `ALREADY_SENT` plutôt que `ACCEPTED` : le projet doit distinguer « je
       * viens de l'envoyer » de « il était déjà parti ». Les confondre lui
       * ferait afficher deux fois un envoi qui n'a eu lieu qu'une.
       */
      return {
        operation: outcome.operation,
        memoized: {
          status: 'ALREADY_SENT',
          providerMessageId: outcome.operation.providerMessageId ?? null,
          operationId: actId,
        },
      };

    case CLAIM.UNRESOLVED:
      throw capabilityOperationUnresolved(definition.code, actId);

    default:
      throw capabilityOperationInFlight(definition.code, actId);
  }
}

/* -------------------------------------------------------------------------- */
/*  CONTRATS D'ENTRÉE ET DE SORTIE                                            */
/* -------------------------------------------------------------------------- */

/**
 * Valide l'entrée contre le schéma STRICT de la capacité.
 *
 * ── POURQUOI AUCUN PASSAGE ARBITRAIRE ───────────────────────────────────────
 *
 * Le schéma refuse les clés inconnues. Un projet qui envoie
 * `{ recipient, environment: 'PROD' }` reçoit donc un refus explicite, et non
 * un silence. Le champ serait inerte aujourd'hui — mais sa présence tolérée
 * ferait croire, à qui relit le code du projet, qu'il agit ; et un jour
 * quelqu'un le brancherait pour « faire marcher ce qui était déjà envoyé ».
 *
 * Le diagnostic rendu NOMME les chemins fautifs, jamais leurs valeurs : une
 * entrée refusée peut contenir une adresse, et un message d'erreur voyage.
 */
function parseInput(definition, payload) {
  const result = definition.inputSchema.safeParse(payload ?? {});
  if (!result.success) {
    throw capabilityInputInvalid(
      definition.code,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(racine)',
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Valide la SORTIE avant de la rendre au projet.
 *
 * Un adaptateur est du code que nous écrivons : le contrôler peut sembler
 * superflu. Ce n'est pas une défiance envers l'adaptateur, c'est une garantie
 * sur ce qui SORT : le schéma est `strict()`, donc un champ ajouté par
 * inadvertance — un objet de réponse fournisseur laissé au passage, un
 * identifiant de compte — fait échouer l'appel au lieu de traverser le pont.
 */
function parseOutput(definition, raw) {
  const result = definition.outputSchema.safeParse(raw);
  if (!result.success) {
    // Le détail reste INTERNE : un défaut de notre adaptateur ne se diagnostique
    // pas depuis le projet, et sa description pourrait citer ce qui a fuité.
    logger.error(
      `[capabilities] sortie non conforme pour ${definition.code} : `
      + result.error.issues.map((i) => i.path.join('.')).join(', '),
    );
    throw capabilityNotAvailable(definition.code, 'OUTPUT_CONTRACT_VIOLATION');
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/*  OBSERVABILITÉ                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Journalise une invocation — succès comme refus.
 *
 * ── CE QUI EST ÉCRIT, ET RIEN D'AUTRE ───────────────────────────────────────
 *
 * capacité, fournisseur, projet, environnement, requête, opération, durée,
 * issue, code d'erreur. Aucune entrée métier, aucune adresse, aucune sortie,
 * aucun identifiant de credential, aucune clé. Ce journal doit pouvoir être lu
 * par n'importe quel opérateur du Panel sans précaution.
 *
 * ── POURQUOI BEST-EFFORT ────────────────────────────────────────────────────
 *
 * Une invocation réussie dont la trace échoue reste une invocation réussie :
 * l'action a eu lieu chez le fournisseur, et lever ici ferait croire au projet
 * qu'elle n'a pas eu lieu — c'est-à-dire l'inciterait à la rejouer.
 */
/**
 * L'ARTEFACT PRODUIT — juste assez pour dire QUOI est parti (L11.1).
 *
 * ── CE QU'ELLE RÉPARE ───────────────────────────────────────────────────────
 *
 * L'audit d'ownership avait relevé que le journal ne portait que le code du
 * modèle. On savait donc qu'un `PASSWORD_RESET_REQUEST` était parti — jamais
 * LEQUEL : celui du Panel, ou celui de SB Auto, et dans quelle version. La
 * question « quel document exact est parti, pour quel projet ? » n'avait pas de
 * réponse *a posteriori*, ce qui est la définition d'un journal insuffisant.
 *
 * ── POURQUOI UNE LISTE BLANCHE, ET PAS `...result` ──────────────────────────
 *
 * Une sortie de capacité peut contenir un identifiant de message, demain autre
 * chose. Recopier la sortie entière dans un journal lu sans précaution ferait
 * entrer, un jour, une donnée qui n'a rien à y faire. On nomme donc les champs,
 * un par un, et aucun d'eux n'est une donnée personnelle : ce sont des
 * coordonnées de DOCUMENT.
 */
function describeArtefact(result) {
  if (!result || typeof result !== 'object') return null;
  const artefact = {};
  for (const field of ['templateCode', 'templateScope', 'templateScopeId', 'templateVersion', 'templateSource']) {
    if (result[field] !== undefined) artefact[field] = result[field];
  }
  return Object.keys(artefact).length ? artefact : null;
}

async function audit(context, definition, {
  outcome, durationMs, errorCode = null, operationId = null, artefact = null,
}) {
  const observation = {
    capability: definition.code,
    provider: definition.provider,
    ...describeContext(context),
    operationId,
    durationMs,
    outcome,
    errorCode,
    ...(artefact ? { artefact } : {}),
  };

  logger.info(`[capabilities] ${JSON.stringify(observation)}`);

  await recordEvent({
    projectId: context.projectId,
    type: outcome === CAPABILITY_OUTCOMES.SUCCEEDED
      ? EVENT_TYPES.CAPABILITY_INVOKED
      : EVENT_TYPES.CAPABILITY_REFUSED,
    source: 'PANEL',
    severity: outcome === CAPABILITY_OUTCOMES.SUCCEEDED
      ? 'INFO'
      // Une issue INCONNUE est plus grave qu'un refus : quelqu'un doit trancher.
      : outcome === CAPABILITY_OUTCOMES.UNKNOWN ? 'ERROR' : 'WARNING',
    summary: outcome === CAPABILITY_OUTCOMES.SUCCEEDED
      ? `Capacité « ${definition.code} » exécutée (${definition.provider}, ${context.environment}).`
      : `Capacité « ${definition.code} » non exécutée — ${errorCode ?? outcome}.`,
    data: observation,
  }).catch(() => {});
}

export default { invokeCapability };
