// ============================================================================
// MIROIR EXÉCUTABLE des contrats OpenAPI v1.4.0 des ponts.
//   docs/spec/PanelBridge.openapi.yaml   (le Panel SERT ce contrat)
//   docs/spec/ProjectBridge.openapi.yaml (le Panel CONSOMME ce contrat)
// Toute requête entrante sur /bridge/v1 est validée par ce fichier ; toute
// évolution passe d'abord par les specs (ratifiées dans le projet modèle) —
// tests/bridge-conformity.test.js verrouille l'accord specs ↔ miroir.
// Ce module ne dépend de rien d'autre que zod et node:crypto.
//
// Historique : 1.0.0 (Phase 1) — surface initiale ; 1.1.0 (Phase 2A, ADDITIF)
// — BootstrapRequest.manifest optionnel + GET /manifest côté ProjectBridge
// (schéma ProjectManifest identique aux deux specs) ; 1.2.0 (Phase 3A,
// ADDITIF) — supervision en LECTURE SEULE : Heartbeat.runtime (uptime,
// charge, composants), Heartbeat.engines, ProjectManifest.engines /
// .network / .descriptor. Tous OPTIONNELS ; 1.3.0 (Phase 4, ADDITIF) —
// DÉCOUVERTE DESCENDANTE : BootstrapResponse.company / .integratedApis /
// .syncCursor, et Identity.appliedConfiguration côté ProjectBridge (ce que le
// projet a réellement appliqué). Tous OPTIONNELS ; 1.4.0 (ADDITIF) — IDENTITÉ
// AU PING : PingResponse.projectKey / .projectName côté ProjectBridge. Le
// Panel reconnaît un projet AVANT l'appairage au lieu d'en faire ressaisir la
// clé — `/identity` exige un bridgeToken qui n'existe pas encore à ce moment.
// Tous OPTIONNELS.
// ============================================================================
import crypto from 'node:crypto';
import { z } from 'zod';

// 1.9.0 (ADDITIF, rétrocompatible) — LE PROJET DÉCLARE SON RÉSEAU COURANT.
//   `Heartbeat.runtime.network` : les adresses publiques que le projet SERT
//   RÉELLEMENT, à chaque battement. Voir `heartbeatSchema` pour la doctrine —
//   en particulier pourquoi ce n'était pas une entité de synchronisation, et
//   pourquoi l'appairage ne fige plus une URL.
// 1.10.0 (ADDITIF, rétrocompatible) — L'ENTREPRISE CLIENTE, LA VENTILATION
//   FISCALE, ET LA SANTÉ DE CONSOMMATION DU PONT. Trois ajouts, trois raisons :
//
//   · `CLIENT_COMPANY` — nouvel entityType, poussé par le Panel vers UN projet
//     nommé. Il porte l'identité JURIDIQUE du client (raison sociale, SIREN,
//     adresses, signataire contractuel). Distinct de `DEV_COMPANY`, qui porte
//     l'identité du PRESTATAIRE et se diffuse à tout le parc : les confondre
//     ferait afficher les mentions légales de L.Y Solution sur le site d'un
//     garage. Un projet antérieur à 1.10 écarte l'entité proprement — la perte
//     est bornée à elle, et elle se voit (`CHANGE_UNREADABLE`).
//
//   · `Contract.pricing.*.amountExcludingTax` / `.taxAmount` / `.taxRate` —
//     la ventilation HT / TVA que le projet CALCULE DÉJÀ et gardait pour lui.
//     Sans elle, le Panel ne connaissait que le TTC et ne pouvait produire
//     qu'une facture muette sur la taxe. Il aurait pu la DÉDUIRE ; déduire un
//     HT depuis un TTC et un taux introduit un arrondi que le contrat, lui, a
//     déjà tranché — et deux arrondis pour une même facture, c'est un centime
//     d'écart qu'aucun comptable ne saura expliquer. Optionnels : une
//     projection antérieure n'en porte pas, et le Panel refuse alors de
//     ventiler plutôt que de supposer.
//
//   · `Heartbeat.bridgeStats.consumption` — ce que le pont CONSOMME, et non
//     plus seulement ce qu'il émet. `outboxSize` décrivait la file SORTANTE ;
//     un projet dont le tirage est mort depuis 91 cycles avait une file
//     sortante parfaitement vide. Le Panel ne pouvait donc pas distinguer
//     « rien à recevoir » de « plus rien n'arrive », et la fiche restait verte.
//     Optionnel, et le silence se lit « ne sait pas dire », jamais « tout va
//     bien ».
//
//   ORDRE DE DÉPLOIEMENT : le Panel accepte ces champs AVANT que le projet ne
//   les émette — les schémas d'entrée des deux côtés sont `.strict()`, et un
//   champ inconnu fait refuser le message ENTIER. Le projet ne les publie donc
//   qu'à un Panel qui a ANNONCÉ savoir les lire (voir `panelSpeaks` côté
//   projet). Compatible 1.0.x à 1.9.x.
export const CONTRACT_VERSION = '1.11.0';
export const CONTRACT_VERSION_HEADER = 'x-bridge-contract-version';

// Version du FORMAT de manifeste (indépendante de la version du contrat).
export const MANIFEST_FORMAT_VERSION = '1.0.0';

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------- routes ----
// Chemins servis par le Panel (contrat PanelBridge).
export const PANEL_API_ROUTES = Object.freeze({
  ping: '/bridge/v1/ping',
  pairings: '/bridge/v1/pairings',
  pairingCurrent: '/bridge/v1/pairings/current',
  heartbeats: '/bridge/v1/heartbeats',
  syncPush: '/bridge/v1/sync/push',
  syncPull: '/bridge/v1/sync/pull',
  /**
   * PASSERELLE DE CAPACITÉS (1.5.0). `{code}` est un paramètre de chemin — le
   * seul de cette surface, et il porte un VERBE MÉTIER, jamais un fournisseur.
   * Un chemin par capacité serait plus « REST » et forcerait à modifier le
   * contrat à chaque migration ; ici, le registre du Panel décide seul de ce
   * qui existe, et le contrat n'a pas à le savoir.
   */
  capabilityInvoke: '/bridge/v1/capabilities/{code}/invoke',
  /**
   * LE SECRET DE VÉRIFICATION D'UN PROJET (L6.3A).
   *
   * Le seul chemin par lequel un secret descend vers un projet — et il ne
   * transporte que celui-là. Aucun identifiant de projet dans l'URL : celui qui
   * fait autorité vient du jeton de pont.
   */
  webhookVerificationSecret: '/bridge/v1/webhooks/{provider}/verification-secret',
  /**
   * L'INTROSPECTION D'IDENTITÉ FÉDÉRÉE (L12.B).
   *
   * Le seul moyen, pour un projet, d'apprendre qu'une session développeur
   * fédérée doit être fermée — sans quoi couper l'accès exigerait d'éditer sa
   * base à la main. Aucun identifiant de projet dans le chemin : celui qui
   * fait autorité est celui du jeton de pont.
   */
  federationIntrospect: '/bridge/v1/federation/introspect',
});

// Chemins exposés par chaque projet (contrat ProjectBridge), consommés par
// ProjectBridgeClient. `{operationId}` est un paramètre de chemin.
export const PROJECT_API_ROUTES = Object.freeze({
  ping: '/api/project-bridge/v1/ping',
  identity: '/api/project-bridge/v1/identity',
  health: '/api/project-bridge/v1/health',
  manifest: '/api/project-bridge/v1/manifest',
  syncPush: '/api/project-bridge/v1/sync/push',
  syncPull: '/api/project-bridge/v1/sync/pull',
  /**
   * LES COMPTES DU PROJET — lecture VIVANTE, jamais un instantané.
   *
   * Le Panel affichait « l'équipe » depuis sa propre projection
   * `PanelProjectMember`, alimentée par le flux de synchronisation. Une copie
   * qui vieillit, qui ne portait que les comptes locaux, et qui décrivait les
   * mêmes personnes avec d'autres champs que le Manager. Cette route remplace
   * les trois défauts par une question posée à celui qui fait autorité.
   */
  accounts: '/api/project-bridge/v1/accounts',
  operations: '/api/project-bridge/v1/operations',
  operationInvoke: '/api/project-bridge/v1/operations/{operationId}/invoke',
  unpair: '/api/project-bridge/v1/unpair',
});

// ---------------------------------------------------------------- erreurs ---
export const BRIDGE_ERROR_CODES = Object.freeze({
  UNAUTHORIZED: 'BRIDGE_UNAUTHORIZED',
  PAIRING_CODE_INVALID: 'BRIDGE_PAIRING_CODE_INVALID',
  ALREADY_PAIRED: 'BRIDGE_ALREADY_PAIRED',
  NOT_PAIRED: 'BRIDGE_NOT_PAIRED',
  CONTRACT_VERSION_UNSUPPORTED: 'BRIDGE_CONTRACT_VERSION_UNSUPPORTED',
  /**
   * L'environnement du PROJET ne correspond pas à celui de CETTE instance de
   * Panel. Le domaine choisit l'instance physique ; l'environnement déclaré
   * prouve qu'on parle du même monde. Voir `assertEnvironmentMatches`.
   */
  ENVIRONMENT_MISMATCH: 'BRIDGE_ENVIRONMENT_MISMATCH',
  INVALID_PAYLOAD: 'BRIDGE_INVALID_PAYLOAD',
  ENTITY_TYPE_UNSUPPORTED: 'BRIDGE_ENTITY_TYPE_UNSUPPORTED',
  OPERATION_UNKNOWN: 'BRIDGE_OPERATION_UNKNOWN',
  OPERATION_FAILED: 'BRIDGE_OPERATION_FAILED',
  RATE_LIMITED: 'BRIDGE_RATE_LIMITED',
  INTERNAL: 'BRIDGE_INTERNAL',
});

// Catalogues exacts des deux specs (le sens Panel n'inclut pas
// ENTITY_TYPE_UNSUPPORTED dans son enum d'ErrorResponse — il n'apparaît que
// comme code d'accusé REJECTED ; le sens Projet l'inclut).
export const PANEL_BRIDGE_ERROR_ENUM = Object.freeze([
  'BRIDGE_UNAUTHORIZED',
  'BRIDGE_ENVIRONMENT_MISMATCH',
  'BRIDGE_PAIRING_CODE_INVALID',
  'BRIDGE_ALREADY_PAIRED',
  'BRIDGE_NOT_PAIRED',
  'BRIDGE_CONTRACT_VERSION_UNSUPPORTED',
  'BRIDGE_INVALID_PAYLOAD',
  'BRIDGE_OPERATION_UNKNOWN',
  'BRIDGE_OPERATION_FAILED',
  'BRIDGE_RATE_LIMITED',
  'BRIDGE_INTERNAL',
]);

/**
 * Le sens PROJET ajoute `ENTITY_TYPE_UNSUPPORTED`, juste APRÈS `INVALID_PAYLOAD`.
 *
 * ── POURQUOI PLUS PAR INDICE ────────────────────────────────────────────────
 * L'insertion se faisait par position (`slice(0, 6)`). Ajouter un code au
 * catalogue parent déplaçait donc le point d'insertion sans que rien ne le
 * signale, et les deux énumérations cessaient de correspondre à leurs specs —
 * ce qui s'est produit au premier ajout. On insère désormais par NOM : le
 * catalogue peut grandir sans casser le dérivé.
 */
export const PROJECT_BRIDGE_ERROR_ENUM = Object.freeze(
  PANEL_BRIDGE_ERROR_ENUM.flatMap((code) => (
    code === BRIDGE_ERROR_CODES.INVALID_PAYLOAD
      ? [code, BRIDGE_ERROR_CODES.ENTITY_TYPE_UNSUPPORTED]
      : [code]
  )),
);

// Codes d'erreur locaux (jamais sur le réseau) : états constatés par le
// client sortant du Panel.
export const LOCAL_ERROR_CODES = Object.freeze({
  PROJECT_UNREACHABLE: 'PROJECT_UNREACHABLE',
});

const STATUS_BY_CODE = Object.freeze({
  [BRIDGE_ERROR_CODES.UNAUTHORIZED]: 401,
  [BRIDGE_ERROR_CODES.PAIRING_CODE_INVALID]: 401,
  [BRIDGE_ERROR_CODES.ALREADY_PAIRED]: 409,
  [BRIDGE_ERROR_CODES.NOT_PAIRED]: 503,
  [BRIDGE_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED]: 409,
  // Conflit : les deux cotes sont sains, mais ils ne parlent pas du meme monde.
  [BRIDGE_ERROR_CODES.ENVIRONMENT_MISMATCH]: 409,
  [BRIDGE_ERROR_CODES.INVALID_PAYLOAD]: 400,
  [BRIDGE_ERROR_CODES.ENTITY_TYPE_UNSUPPORTED]: 422,
  [BRIDGE_ERROR_CODES.OPERATION_UNKNOWN]: 404,
  [BRIDGE_ERROR_CODES.OPERATION_FAILED]: 422,
  [BRIDGE_ERROR_CODES.RATE_LIMITED]: 429,
  [BRIDGE_ERROR_CODES.INTERNAL]: 500,
  [LOCAL_ERROR_CODES.PROJECT_UNREACHABLE]: 503,
});

export class BridgeError extends Error {
  constructor(code, message, extra = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code] ?? 500;
    this.details = extra ? { code, ...extra } : { code };
  }
}

// ------------------------------------------------------------------- sync ---
export const SYNC_ENTITY_TYPES = Object.freeze([
  'DIAGNOSTIC',
  'CONTRACT',
  'INVOICE',
  'PAYMENT',
  'CONTRACT_DOCUMENT',
  'DEV_COMPANY',
  'TEAM_MEMBER',
  /*
   * `EMAIL_TEMPLATE` a ete RETIRE en 1.11.0.
   *
   * Il figurait ici depuis l'origine sans qu'aucun emetteur ne le produise ni
   * qu'aucun projecteur ne l'applique : une entite declaree que rien ne
   * synchronisait. La garder aurait fait croire, a la lecture du contrat, que
   * le contenu des modeles voyage entre le Panel et les projets. Il ne voyage
   * pas, et il ne doit pas : le Panel est la seule autorite de contenu, et le
   * projet ne consomme que la projection en lecture du pont.
   */
  'INTEGRATED_API_CONFIG',
  'INTEGRATED_API_MODE',
  'EVENT',
  'MEETING',
  // >= 1.4.x — IDENTITE COMMERCIALE poussee par le projet. Le manifeste
  // ne la porte qu'au (re)chargement ; cette entite la fait remonter a
  // CHAQUE modification, sans action humaine.
  'PROJECT_PRESENTATION',
  /**
   * >= 1.4.x — ETAT D'ACCESSIBILITE DU SITE, pousse par le projet.
   *
   * AGREGAT DISTINCT DE `CONTRACT`, et il doit le rester. Une suspension
   * TECHNIQUE (maintenance) n'a aucun rapport avec un contrat : la
   * transporter sous l'etiquette contractuelle ferait afficher « probleme de
   * contrat » devant une operation de maintenance, et inversement. Le statut
   * du site est DERIVE des deux causes, mais il n'appartient a aucune.
   */
  'PROJECT_SITE_STATUS',
  /**
   * >= 1.8.0 — CE QUE LE PROJET UTILISE COMME MODÈLES D'E-MAIL.
   *
   * ══ UNE DECLARATION D'ETAT, PAS UNE DEMANDE DE MUTATION ═══════════════════
   *
   * Le projet ne demande pas « provisionne-moi ces dix modeles » : il ANNONCE
   * les codes qu'il consomme. Le Panel en tire les consequences — poser une
   * instance manquante, retirer de la vue active un code qui n'est plus
   * annonce. C'est la difference entre un ordre, qu'il faudrait rejouer a
   * l'identique apres une coupure, et un etat, qui converge tout seul.
   *
   * Elle passe donc par la synchronisation d'entites, avec tout ce qu'elle
   * apporte gratuitement : LWW sur `modifiedAt`, anti-echo par `writeId`,
   * idempotence, file durable, rattrapage au pull. Une capacite imperative
   * n'aurait eu aucune de ces proprietes.
   *
   * UNE SEULE entite par projet — `entityId` stable — comme
   * `PROJECT_PRESENTATION` : c'est un etat, pas une collection.
   *
   * Le projet reste l'autorite de l'USAGE ; le Panel garde l'autorite du
   * CONTRAT (quels codes existent, leurs variables) et du CONTENU.
   */
  'PROJECT_EMAIL_TEMPLATE_USAGE',
  /**
   * >= 1.11.0 — UN INCIDENT TECHNIQUE DURABLE, poussé par le projet.
   *
   * ══ POURQUOI L'ALERTE REMONTE AU LIEU DE PARTIR DU PROJET ═════════════════
   *
   * Le projet envoyait lui-même cette alerte, avec le modèle
   * `PLATFORM_INCIDENT_DEV_ALERT`. Elle ne pouvait structurellement pas
   * aboutir : ce modèle est une communication de L.Y Solution — il nomme des
   * composants internes et ne porte jamais l'apparence d'un client — donc de
   * portée PANEL, et un projet ne peut pas demander une portée PANEL. Chaque
   * incident finissait en refus silencieux.
   *
   * Le corriger en basculant le modèle en portée PROJECT aurait fait entrer
   * une communication interne dans le catalogue éditable d'un client, pour la
   * seule raison que l'appel venait de là. L'ownership suit la communication,
   * pas l'origine des faits.
   *
   * Le projet RAPPORTE donc le fait ; le control plane décide s'il alerte, qui
   * il alerte, et avec quel contenu. Il gagne au passage la file durable et le
   * rejeu : un incident survenu pendant que le Panel était injoignable — le cas
   * le plus probable — n'est plus perdu.
   */
  'PLATFORM_INCIDENT',
  /**
   * >= 1.6.x — RETOUR DE LIVRAISON D'UN E-MAIL, poussé par le Panel (L8.4C).
   *
   * Depuis que les envois partent du compte Brevo du Panel, les webhooks de
   * livraison suivent le COMPTE et n'atteignent plus le projet. Cette entité
   * est le chemin de retour : elle porte un verbe métier déjà normalisé
   * (`EMAIL_DELIVERED` / `EMAIL_BOUNCED`), jamais un événement brut du
   * fournisseur — le projet n'a pas à connaître le vocabulaire de Brevo pour
   * savoir qu'un message est arrivé.
   */
  'EMAIL_DELIVERY_EVENT',
  /**
   * >= 1.7.x — LE RETOUR DE SIGNATURE, poussé par le Panel (R10.5C).
   *
   * Même raison d'être que `EMAIL_DELIVERY_EVENT`, et même leçon : après
   * cutover, les webhooks Yousign suivent le COMPTE, donc le Panel. Sans cette
   * entité, un contrat signé resterait « en cours » côté projet, et un projet
   * éteint au mauvais moment perdrait le fait définitivement.
   *
   * Elle porte un fait NORMALISÉ — `SIGNATURE_SIGNER_SIGNED`,
   * `SIGNATURE_COMPLETED`, `SIGNATURE_FAILED` — jamais l'événement brut du
   * fournisseur : le projet n'a pas à connaître le vocabulaire de Yousign pour
   * savoir qu'un contrat est signé.
   */
  'SIGNATURE_EVENT',
  /**
   * >= 1.7.x — UNE PRESTATION À PAYER, poussée par le Panel (L10.5).
   *
   * DISTINCTE de `INVOICE` et de `PAYMENT`, et elle doit le rester. Ces deux-là
   * décrivent ce qui a EU LIEU — une facture Stripe émise, un paiement encaissé.
   * Celle-ci décrit ce qui est RÉCLAMÉ : une somme due, qui n'a produit aucune
   * facture et aucun encaissement, et qui n'en produira peut-être jamais.
   *
   * Les confondre aurait fait apparaître, dans l'historique de facturation du
   * client, des factures qui n'existent pas.
   *
   * La charge utile est volontairement PAUVRE : un nom, un montant, un état, et
   * le document Stripe une fois payé. Aucun identifiant fournisseur, aucune URL
   * de session — celle-ci est périssable et se demande au moment du clic.
   */
  'PAYMENT_REQUEST',
  /**
   * >= 1.7.x — UNE CAUSE DE SUSPENSION, poussée par le Panel (L10.6).
   *
   * Elle transporte un FAIT COMMERCIAL — « le défaut de paiement est actif » —
   * jamais un état de site. Le Panel décide de la politique de grâce ; le projet
   * reste l'autorité de son accessibilité et combine cette cause avec les
   * siennes (maintenance technique, contrat éteint).
   *
   * Un ordre `status: SUSPENDED` aurait créé un second maître, et une
   * régularisation aurait pu rouvrir un site en maintenance.
   */
  'PAYMENT_DEFAULT_CAUSE',
  /**
   * >= 1.7.x — L'INCIDENT DE PAIEMENT LUI-MÊME, poussé par le Panel (L10.6B-3).
   *
   * ══ POURQUOI IL NE POUVAIT PAS EMPRUNTER `PAYMENT_DEFAULT_CAUSE` ══════════
   *
   * Parce que `active`, sur ce type-là, a une signification EXACTE et vérifiable
   * dans le code du projet : elle est écrite dans `siteStatus.paymentDefault`,
   * puis le moteur de réconciliation en tire l'accessibilité. C'est une ENTRÉE
   * DE MOTEUR.
   *
   * Or un incident EXISTE avant que la cause ne devienne active — c'est tout
   * l'objet du délai de grâce. Le transporter par la cause aurait imposé l'un
   * de ces deux mensonges :
   *
   *   `active: true` pendant la grâce   fermer le site pendant la grâce, soit
   *                                     exactement ce que la grâce empêche ;
   *
   *   `active: false` avec des données  l'applicateur de cause remet à néant
   *                                     tout le contexte quand la cause est
   *                                     inactive — l'incident arriverait et
   *                                     disparaîtrait dans la même écriture.
   *
   * Et, structurellement : `SiteStatus` est un SINGLETON avec UN sous-document
   * de cause, alors qu'un projet peut connaître plusieurs incidents successifs.
   * Un singleton n'héberge pas un historique.
   *
   * Les deux types sont donc ORTHOGONAUX, et le resteront :
   *
   *   CAUSE      « faut-il fermer ? »        → entrée du moteur, singleton
   *   INCIDENT   « que se passe-t-il ? »     → observation, collection
   *
   * L'incident porte `causeActive` en LECTURE — pour que l'écran puisse
   * expliquer ce qu'il montre — jamais comme autorité : l'accessibilité se lit
   * dans `SiteStatus`, et nulle part ailleurs.
   */
  'PAYMENT_DEFAULT_INCIDENT',
  /**
   * >= 1.10.0 — L'ENTREPRISE CLIENTE, poussée par le Panel vers UN projet.
   *
   * ══ POURQUOI ELLE NE PEUT PAS EMPRUNTER `DEV_COMPANY` ═════════════════════
   *
   * Ce sont DEUX personnes morales, et elles se font face :
   *
   *     DEV_COMPANY     L.Y Solution — le PRESTATAIRE. Diffusée à TOUT le parc
   *                     (`audience: null`), parce qu'elle n'est un secret pour
   *                     personne : elle s'affiche déjà en pied de chaque site.
   *
   *     CLIENT_COMPANY  le CLIENT de CE projet — l'ACHETEUR. NOMINATIVE
   *                     (`audience: <projectId>`), parce que le SIREN et
   *                     l'adresse de facturation d'un client n'ont aucune
   *                     raison d'atteindre les autres.
   *
   * Les faire voyager sous la même étiquette aurait obligé le projet à deviner,
   * à la lecture, laquelle des deux il reçoit — et un site aurait fini par
   * afficher les mentions légales de son prestataire à la place des siennes.
   * Surcharger `DEV_COMPANY` aurait de surcroît fait basculer une entité de
   * diffusion générale en entité nominative : la première fuite serait passée
   * par une écriture qu'on croyait publique.
   *
   * ══ CE QU'ELLE PORTE, ET CE QU'ELLE NE PORTERA JAMAIS ═════════════════════
   *
   * Porte : identité légale, adresses, coordonnées de facturation, signataire
   * contractuel, et le VERDICT de complétude calculé par le Panel.
   *
   * Ne porte jamais : les notes internes de gestion (une appréciation sur un
   * client, lue par ce client) ni les documents administratifs (un Kbis n'a
   * rien à faire dans la base d'un site vitrine).
   *
   * ══ SENS UNIQUE ══════════════════════════════════════════════════════════
   *
   * PANEL → PROJET, exclusivement. Le Panel est l'autorité de l'identité
   * juridique ; un projet qui pourrait l'écrire permettrait à un client de
   * choisir la raison sociale sur laquelle il est facturé.
   */
  'CLIENT_COMPANY',
]);

// Types réellement APPLIQUÉS par ce Panel — les autres répondent REJECTED
// (BRIDGE_ENTITY_TYPE_UNSUPPORTED), jamais un 500. Cette liste DOIT rester
// alignée sur la table de projecteurs (`services/sync/projectors.js`) : elle
// est ce que le Panel déclare, la table est ce qu'il sait faire. Un test de
// synchronisation vérifie qu'elles ne divergent pas.
export const APPLIED_ENTITY_TYPES = Object.freeze([
  'DIAGNOSTIC',
  'PROJECT_PRESENTATION',
  'CONTRACT',
  'TEAM_MEMBER',
  'PROJECT_SITE_STATUS',
  /**
   * >= 1.8.0 — la DECLARATION D'USAGE des modeles d'e-mail. Reellement
   * appliquee : son projecteur provisionne les instances manquantes du projet
   * a la reception, et retire de sa vue active celles qui ne sont plus
   * declarees. Declarer sans appliquer ferait accepter une ecriture dont rien
   * ne decoulerait — exactement le mensonge que ce couple de listes evite.
   */
  'PROJECT_EMAIL_TEMPLATE_USAGE',
  /**
   * >= 1.11.0 — l'incident technique du projet. Reellement applique : son
   * projecteur inscrit l'incident au suivi du projet et decide de l'alerte.
   */
  'PLATFORM_INCIDENT',
]);

export const EMITTERS = Object.freeze({ PANEL: 'PANEL', PROJECT: 'PROJECT' });

export const ACK_STATUS = Object.freeze({
  APPLIED: 'APPLIED',
  DUPLICATE: 'DUPLICATE',
  IGNORED: 'IGNORED',
  REJECTED: 'REJECTED',
});

// ---------------------------------------------------------------- schémas ---
const semver = z.string().regex(SEMVER_RE, 'version sémantique attendue (x.y.z)');
const isoDate = z.string().datetime({ offset: true });

// ProjectManifest (schéma IDENTIQUE dans les deux specs). Le Panel est un
// LECTEUR TOLÉRANT : les champs requis par la spec sont exigés, mais les
// propriétés additionnelles d'une mineure de format plus récente sont
// tolérées (pas de .strict() — l'OpenAPI ne déclare pas
// additionalProperties: false sur ces objets).
/**
 * DESCRIPTEUR MÉDIA CANONIQUE (>= 1.5.0, ADDITIF).
 *
 * ── CE QUE L'URL SEULE NE DISAIT PAS ────────────────────────────────────────
 * Le Bridge ne transportait qu'une adresse. Un projet qui la recevait ne
 * pouvait savoir ni si l'image avait changé (aucune empreinte), ni son type
 * réel, ni ses dimensions, ni si la projection reçue était plus récente que
 * celle qu'il appliquait déjà. Il ne pouvait que recharger l'adresse et
 * espérer — d'où des images remplacées qui restaient affichées depuis le
 * cache, et des liens morts qu'aucun écran ne savait qualifier.
 *
 * ── ADDITIF, DONC SANS RUPTURE ──────────────────────────────────────────────
 * Le descripteur ACCOMPAGNE `logoUrl` / `photoUrl` / `faviconUrl` ; il ne les
 * remplace pas. Un projet antérieur continue de fonctionner sans rien changer,
 * et la migration se fait projet par projet.
 *
 * `url` est TOUJOURS absolue et canonique : jamais une boucle locale, jamais
 * un chemin disque, jamais un `blob:`. Un projet affiche ce média depuis une
 * AUTRE origine que le Panel — une adresse locale y donne une image cassée.
 *
 * `null` est une valeur SIGNIFIANTE : elle publie la SUPPRESSION du média.
 * L'omettre laisserait l'ancien descripteur en place chez le projet.
 */
export const mediaDescriptorSchema = z
  .object({
    /**
     * QUI DÉTIENT CE MÉDIA — ADDITIF, déclaré, jamais déduit.
     *
     * ── LE DÉFAUT QUE CE CHAMP FERME ──────────────────────────────────────
     * Les deux côtés du pont décrivaient leurs médias de la même façon : clé
     * d'objet, empreinte, dimensions. Le lecteur concluait donc « média du
     * projet » sur la simple présence d'une clé, et recomposait l'adresse
     * contre le domaine du CLIENT. Le logo du développeur, servi par le Panel,
     * devenait `https://<client>/uploads/<clé du Panel>` — un 404.
     *
     * `PANEL` : le média reste sur le Panel et garde l'adresse qu'il publie.
     * `PROJECT` : le média suit la destination active du projet.
     *
     * Optionnel pour la LECTURE des projections antérieures — l'autorité leur
     * est alors donnée par le schéma du champ qui les porte. Toute émission
     * nouvelle le renseigne.
     */
    authority: z.enum(['PANEL', 'PROJECT']).nullable().optional(),
    /** Identité stable du média. `null` pour une URL externe non gérée. */
    mediaId: z.string().nullable().optional(),
    url: z.string().url(),
    mime: z.string().nullable().optional(),
    size: z.number().int().nonnegative().nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    /** Empreinte du CONTENU — ce qui distingue « même image » d'« autre ». */
    sha256: z.string().nullable().optional(),
    /** Monotone : un projet refuse une projection plus ancienne. */
    version: z.number().int().nonnegative().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    /**
     * Servi par une destination ACTIVE — relevé sur le serveur, jamais déduit.
     * Un descripteur `LOCAL_ONLY` décrit un média qui existe, mais que
     * personne d'autre ne peut encore atteindre.
     */
    publicationState: z.enum(['LOCAL_ONLY', 'PUBLISHED']).nullable().optional(),
    /** Vrai pour une URL externe dont le Panel n'a aucune métadonnée. */
    external: z.boolean().optional(),
  })
  .passthrough();

export const projectManifestSchema = z.object({
  manifestVersion: semver,
  project: z.object({
    key: z.string().min(3).max(120),
    name: z.string().min(1),
    environment: z.enum(['TEST', 'PROD']),
    softwareVersion: z.string().min(1),
  }),
  bridge: z.object({
    contractVersion: semver,
    projectBridgeBasePath: z.string().min(1),
  }),
  contracts: z.object({
    panelBridge: semver,
    projectBridge: semver,
  }),
  sync: z.object({
    supportedEntityTypes: z.array(z.enum(SYNC_ENTITY_TYPES)),
    operations: z.array(z.string()),
  }),
  modules: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      status: z.enum(['ACTIVE', 'OPTIONAL']),
    }),
  ),
  features: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(['AVAILABLE', 'RESERVED']),
    }),
  ),
  // Contrat >= 1.2.0 — supervision en lecture seule : tous optionnels.
  engines: z.object({ deployment: semver.optional(), duplication: semver.optional() }).optional(),
  network: z
    .object({
      primaryDomain: z.string().nullable().optional(),
      urls: z.record(z.string().min(1), z.string()).optional(),
    })
    .optional(),
  // PRÉSENTATION (>= 1.4.x, ADDITIF) — l'identité COMMERCIALE du projet.
  // Sans elle, le Panel affichait le nom technique du projet et l'URL de son
  // API comme s'il s'agissait du client et de son site. Tous les champs sont
  // optionnels : un projet qui ne publie rien reste pleinement conforme, et
  // l'absence se distingue d'une valeur vide.
  //
  // `logoUrl` / `faviconUrl` sont TOUJOURS des URL absolues joignables : le
  // projet résout lui-même ses chemins locaux contre son propre domaine public
  // — la convention est documentée côté projet modèle. Le Panel se contente de
  // pointer l'adresse distante : il ne copie ni ne stocke aucun média.
  presentation: z
    .object({
      companyName: z.string().min(1).optional(),
      tagline: z.string().min(1).optional(),
      logoUrl: z.string().url().optional(),
      faviconUrl: z.string().url().optional(),
      /**
       * ADDITIF — le descripteur complet annoncé par le PROJET.
       *
       * Le Panel en publiait déjà vers les projets ; il n'en recevait aucun.
       * Le Bridge était asymétrique : le même objet ne se décrivait pas de la
       * même façon selon le sens de circulation. Optionnel : un projet
       * antérieur reste pleinement conforme.
       */
      logo: mediaDescriptorSchema.optional(),
      favicon: mediaDescriptorSchema.optional(),
      contacts: z
        .object({
          email: z.string().min(1).optional(),
          phone: z.string().min(1).optional(),
          website: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  descriptor: z
    .object({
      // Nom LISIBLE du projet, tel qu'il se nomme (>= 1.4.x).
      name: z.string().min(1).optional(),
      type: z.string().optional(),
      description: z.string().optional(),
      layout: z.string().optional(),
    })
    .optional(),
});

export const bootstrapRequestSchema = z
  .object({
    contractVersion: semver,
    projectKey: z.string().min(3).max(120),
    projectName: z.string().min(1),
    environment: z.enum(['TEST', 'PROD']),
    softwareVersion: z.string().min(1),
    publicBackendUrl: z.string().url().nullable().optional(),
    pairingCode: z.string().min(1),
    // Contrat ≥ 1.1.0 : le projet se présente complètement dès l'appairage.
    manifest: projectManifestSchema.optional(),
  })
  .strict();

export const heartbeatSchema = z
  .object({
    sentAt: isoDate,
    softwareVersion: z.string().min(1),
    environment: z.enum(['TEST', 'PROD']),
    health: z
      .object({
        status: z.enum(['OK', 'DEGRADED']),
        details: z.string().nullable().optional(),
      })
      .strict(),
    bridgeStats: z
      .object({
        outboxSize: z.number().int().min(0).optional(),
        lastSyncAt: isoDate.nullable().optional(),
        /**
         * ── CE QUE « CONNECTÉ » NE DISAIT PAS (>= 1.4.x, ADDITIF) ───────────
         *
         * Une instance dont toutes les écritures métier sont REFUSÉES bat
         * parfaitement : le battement prouve qu'on répond, jamais qu'on livre.
         * La fiche restait verte devant une donnée figée depuis des semaines.
         *
         * Ces deux champs portent le fait manquant. Ni charge utile, ni
         * secret : un compte, un code, une date. Optionnels — le silence d'un
         * projet antérieur ne vaut pas « aucun refus », seulement « ne sait
         * pas dire », et l'écran doit faire la différence.
         */
        rejectedCount: z.number().int().min(0).optional(),
        oldestRejection: z
          .object({
            entityType: z.string().min(1),
            failureClass: z.string().min(1).nullable().optional(),
            code: z.string().min(1).nullable().optional(),
            since: isoDate.nullable().optional(),
            rejections: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        /**
         * ── CE QUE LE PONT CONSOMME (>= 1.10.0, ADDITIF) ───────────────────
         *
         * ══ LE DÉFAUT QUE CE BLOC FERME ═══════════════════════════════════
         *
         * Tout ce qui précède décrit la file SORTANTE. Un projet dont le
         * TIRAGE est mort a une file sortante parfaitement vide, un battement
         * régulier et aucune erreur : c'est le cas réel observé — 91 cycles
         * consécutifs, `applied: 0`, `lastError: null`, `state: DEGRADED` — et
         * rien, absolument rien, n'en parvenait au Panel.
         *
         * Le Panel ne pouvait donc pas distinguer « ce projet n'a rien à
         * recevoir » (le cas NORMAL et majoritaire) de « ce projet ne reçoit
         * plus rien » (une panne totale de la propagation descendante). Ces
         * champs portent cette différence, et rien d'autre.
         *
         * ══ POURQUOI CES SIGNAUX-LÀ ═══════════════════════════════════════
         *
         *   cursor                   ce que le projet a durablement consommé.
         *                            `null` chez un projet antérieur ; il
         *                            REPART DE ZÉRO à chaque redémarrage, et
         *                            c'est précisément la dette que ce lot
         *                            ferme.
         *   lastCursorAdvanceAt      la dernière fois que le tirage a
         *                            PROGRESSÉ. C'est le signal maître : un
         *                            curseur qui n'avance plus est un tirage
         *                            mort, qu'il y ait eu des erreurs ou non.
         *   lastSuccessfulApplyAt    la dernière écriture RÉELLEMENT appliquée.
         *                            Distinct du précédent : un projet à jour
         *                            avance son curseur sans rien appliquer.
         *   consecutivePullFailures  le transport échoue en boucle.
         *   consecutiveUnreadableChanges  des écritures sont ÉCARTÉES en
         *                            boucle — le curseur avance, et pourtant
         *                            la donnée se perd. La panne la plus
         *                            silencieuse des trois.
         *   state                    l'auto-diagnostic du pont, tel qu'il se
         *                            voit. Corroboratif : le Panel décide, il
         *                            ne délègue pas son verdict au patient.
         *
         * Aucune charge utile, aucun secret : des compteurs, des dates, un
         * curseur opaque déjà connu du Panel puisque c'est lui qui l'émet.
         */
        consumption: z
          .object({
            cursor: z.string().nullable().optional(),
            lastCursorAdvanceAt: isoDate.nullable().optional(),
            lastSuccessfulApplyAt: isoDate.nullable().optional(),
            consecutivePullFailures: z.number().int().min(0).optional(),
            consecutiveUnreadableChanges: z.number().int().min(0).optional(),
            appliedTotal: z.number().int().min(0).optional(),
            state: z.string().min(1).max(40).nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    // Contrat >= 1.2.0 — SUPERVISION EN LECTURE SEULE. Tous optionnels : un
    // projet qui ne les publie pas reste pleinement conforme.
    runtime: z
      .object({
        uptimeSeconds: z.number().int().min(0).optional(),
        startedAt: isoDate.nullable().optional(),
        load: z
          .object({
            cpuPercent: z.number().min(0).optional(),
            memoryUsedMb: z.number().min(0).optional(),
            memoryTotalMb: z.number().min(0).optional(),
          })
          .strict()
          .optional(),
        components: z.record(z.string().min(1), z.enum(['OK', 'WARNING', 'ERROR', 'UNKNOWN'])).optional(),
        /**
         * ══ >= 1.9.0, ADDITIF — LE RÉSEAU QUE CE PROJET SERT MAINTENANT ═════
         *
         * ── LE DÉFAUT QUE CE CHAMP FERME ──────────────────────────────────
         *
         * `runtime.publicBackendUrl` était posée UNE FOIS, au bootstrap, et
         * plus jamais revue. Un projet redéployé sur un autre domaine gardait
         * donc, côté Panel, l'adresse qu'il avait le jour de l'appairage —
         * observé en recette réelle : une fiche annonçait encore l'ancien
         * domaine d'un projet des semaines après sa migration, alors que le
         * projet déclarait correctement le nouveau.
         *
         * Le battement de cœur était le seul canal qui parle en permanence, et
         * il ne transportait AUCUNE adresse (`.strict()`). Rien ne pouvait donc
         * corriger la valeur sans un réappairage — c'est-à-dire en détruisant
         * une relation de confiance pour rafraîchir une donnée d'exploitation.
         *
         * ── POURQUOI ICI, ET PAS DANS UNE ENTITÉ DE SYNCHRONISATION ────────
         *
         * `PROJECT_PRESENTATION.network` porte déjà ces adresses, et reste
         * l'autorité ARBITRÉE : LWW sur `modifiedAt`, anti-écho, file durable.
         * Elle n'est pas remplacée, et rien n'est dupliqué.
         *
         * Mais une projection ne part que lorsque l'état CHANGE. Un projet dont
         * le réseau est stable n'émet plus rien — et si une projection a été
         * perdue, refusée par un Panel antérieur, ou émise avant que le Panel
         * ne sache la lire, plus RIEN ne la rejoue. L'état déclaré et l'état
         * réel divergent alors en silence, sans que personne ne puisse le voir.
         *
         * Le battement, lui, répète. C'est exactement ce qu'on attend d'une
         * donnée de LIVENESS : elle ne prouve pas ce qui a changé, elle prouve
         * ce qui est vrai maintenant. Les deux canaux ne disent donc pas la
         * même chose et se complètent :
         *
         *     PROJECT_PRESENTATION   « voici mon nouvel état »   (arbitré)
         *     Heartbeat.runtime.network « voici mon état actuel » (répété)
         *
         * ── ADDITIF, DONC SANS RUPTURE ────────────────────────────────────
         *
         * Entièrement optionnel. Un projet en 1.8 n'émet rien et reste
         * pleinement conforme : sa fiche continue de converger par la
         * projection de présentation, exactement comme avant.
         */
        network: z
          .object({
            /** L'API publique — celle que le Panel doit appeler. */
            publicBackendUrl: z.string().url().nullable().optional(),
            /** Le site public — celui que le client consulte. */
            publicSiteUrl: z.string().url().nullable().optional(),
            /** L'espace de gestion du client. */
            managerUrl: z.string().url().nullable().optional(),
            /**
             * QUAND LE PROJET A CONSTATÉ CET ÉTAT — son horloge, informative.
             * L'arbitrage reste au Panel, sur l'instant de RÉCEPTION : une
             * horloge de projet en dérive ne doit pas pouvoir figer une adresse.
             */
            declaredAt: isoDate.nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    engines: z
      .object({ deployment: semver.optional(), duplication: semver.optional() })
      .strict()
      .optional(),
  })
  .strict();

export const syncChangeSchema = z
  .object({
    writeId: z.string().uuid(),
    entityType: z.enum(SYNC_ENTITY_TYPES),
    entityId: z.string().uuid(),
    deleted: z.boolean(),
    payload: z.unknown().nullable().optional(),
    modifiedAt: isoDate,
    emitter: z.enum([EMITTERS.PANEL, EMITTERS.PROJECT]),
  })
  .strict();

/**
 * PAYLOADS MÉTIER — le transport reste générique (`payload: z.unknown()`),
 * mais chaque type appliqué valide STRICTEMENT son contenu avant projection.
 *
 * Sans cela, un projet plus récent — ou fautif — écrirait n'importe quoi dans
 * les collections du Panel, et l'erreur ne se verrait qu'à l'affichage. Un
 * payload non conforme est REJETÉ, sans écriture partielle.
 */
export const projectPresentationPayloadSchema = z
  .object({
    companyName: z.string().min(1).optional(),
    tagline: z.string().min(1).optional(),
    /**
     * ADRESSES HÉRITÉES — dérivées du descripteur, conservées pour un Panel
     * antérieur. Elles ne font PAS autorité : voir `logo` / `favicon`.
     *
     * Elles restent des URL ABSOLUES. Un média est affiché depuis une autre
     * origine que celle qui l'a produit ; un chemin relatif y donne une image
     * cassée, et l'émetteur ne le publie donc pas (il omet le champ).
     */
    logoUrl: z.string().url().optional(),
    faviconUrl: z.string().url().optional(),
    /**
     * ── LE DESCRIPTEUR EST LA SOURCE CANONIQUE, ET IL MANQUAIT ICI ──────────
     *
     * ══ LE DÉFAUT QUE CES DEUX LIGNES FERMENT ═══════════════════════════════
     *
     * Le descripteur média a été ajouté au Bridge dans le sens Panel → projet,
     * puis accepté sur le MANIFESTE d'un projet (`projectManifestSchema
     * .presentation.logo`). Il n'a jamais été ajouté ici, sur la PROJECTION —
     * le seul des trois chemins qui soit vivant.
     *
     * Or `describeProjectPresentation` le publie « en additif » depuis le même
     * moment. Ce schéma étant `.strict()`, toute instance disposant d'un logo
     * — c'est-à-dire toute instance de production — voyait sa présentation
     * REFUSÉE avec `ENTITY_PAYLOAD_INVALID`. L'écriture sortait de la file du
     * projet, rien ne la rejouait, et la fiche restait sur l'ancien nom
     * indéfiniment. Le symptôme observé était « la synchronisation n'est pas
     * live » ; la cause était un champ de trop dans un schéma fermé.
     *
     * ══ POURQUOI ON N'OUVRE PAS LE SCHÉMA ═══════════════════════════════════
     *
     * `.passthrough()` aurait fait passer ce payload — et tous les suivants,
     * y compris celui qui transporterait un jour un secret par mégarde. La
     * fermeture est la protection ; ce qui manquait n'était pas la souplesse,
     * c'était l'accord entre l'émetteur et le validateur sur un champ DÉJÀ
     * émis. On nomme donc le champ, on ne retire pas la garde.
     *
     * `authority` reste déclarée par l'émetteur (`PROJECT` ici) et n'est jamais
     * déduite : c'est elle qui décide contre quelle origine l'adresse se
     * résout.
     */
    logo: mediaDescriptorSchema.nullable().optional(),
    favicon: mediaDescriptorSchema.nullable().optional(),
    contacts: z
      .object({
        email: z.string().min(1).optional(),
        phone: z.string().min(1).optional(),
        website: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    project: z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    network: z
      .object({
        website: z.string().min(1).optional(),
        manager: z.string().min(1).optional(),
        backend: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * CONTRAT projeté — strictement ce que le Panel affiche. Pas de date
 * d'expiration : elle n'existe nulle part, et l'inventer serait pire que de
 * ne rien montrer.
 */
/**
 * TEAM_MEMBER — l'équipe du projet, telle que le projet la tient.
 *
 * Schéma FERMÉ, et c'est ici que se joue la protection : un projet qui
 * publierait par mégarde un mot de passe haché, un jeton ou un secret verrait
 * son écriture REFUSÉE. La liste blanche vaut mieux qu'une liste noire — on
 * n'a pas à deviner le nom du champ sensible de demain.
 *
 * Ni `lastLoginAt` ni statut actif : le modèle source ne les porte pas.
 */
/**
 * PROJECT_SITE_STATUS — « ce site est-il accessible, et sinon pourquoi ? »
 *
 * ══ POURQUOI CE N'EST PAS UN CHAMP DU CONTRAT ═══════════════════════════════
 *
 * L'accessibilité a DEUX causes indépendantes : une suspension TECHNIQUE
 * (maintenance, décidée par un opérateur) et une cause CONTRACTUELLE (aucun
 * contrat vivant alors que la protection est active). Ranger cela sous
 * `CONTRACT` ferait afficher « problème de contrat » devant une maintenance —
 * et rendrait la fiche incapable de dire pourquoi un site est coupé.
 *
 * ══ LE VERDICT ET SA CAUSE VOYAGENT ENSEMBLE ════════════════════════════════
 *
 * `accessible` résume ; `suspensionSource` explique. Publier le seul résumé
 * forcerait le Panel à deviner la cause, et il devinerait faux un jour sur
 * deux. `NONE` est une réponse à part entière : « rien ne suspend ce site ».
 *
 * `contractProtectionEnabled` est un RÉGLAGE, pas une conséquence : il reste
 * vrai même quand il ne produit aucun effet (site protégé, contrat honoré).
 * C'est lui que la carte du Panel donne à basculer.
 */
/**
 * CE QU'UN PROJET DECLARE UTILISER COMME MODELES D'E-MAIL (>= 1.8.0).
 *
 * Des CODES, et rien d'autre. Ni sujet, ni HTML, ni version : le contenu
 * appartient au Panel, et un projet qui pourrait le pousser par cette porte
 * contournerait l'editeur, le versionnement et la validation.
 *
 * `templateCodes` est borne : une declaration n'est pas un catalogue, et une
 * liste sans limite est une porte ouverte a un payload de plusieurs mega-octets
 * ecrit par erreur.
 */
export const emailTemplateUsagePayloadSchema = z
  .object({
    templateCodes: z.array(z.string().min(1).max(80)).max(200),
    /** Empreinte de la liste, calculee par le projet. Decide du non-evenement. */
    revision: z.string().min(1).max(128),
    /** Horloge du projet — informatif ; `modifiedAt` arbitre le LWW. */
    declaredAt: isoDate.optional(),
    /**
     * L'EMPREINTE DU CONTRAT DE VARIABLES QUE LE PROJET SAIT SERVIR (1.11.0).
     *
     * `{ [templateCode]: fingerprint }`. Le projet n'invente rien : il renvoie
     * l'empreinte que le Panel lui a servie. Elle rend detectable AVANT le
     * premier envoi rate le fait qu'une variable soit devenue obligatoire, ait
     * disparu ou ait change de type depuis que ce projet a lu son contrat.
     *
     * Optionnelle : un projet anterieur au lot n'en envoie pas, et ce n'est pas
     * une panne — c'est un contrat non declare, que le Panel sait nommer.
     */
    contractFingerprints: z.record(z.string().min(1).max(80), z.string().max(64)).optional(),
    softwareVersion: z.string().max(64).nullable().optional(),
  })
  .strict();

/**
 * L'INCIDENT TECHNIQUE D'UN PROJET (1.11.0) — des FAITS, jamais un ordre.
 *
 * Le projet ne nomme ni modele, ni destinataire, ni sujet : il decrit ce qui
 * est tombe. Lui laisser nommer le modele rouvrirait la porte que ce lot ferme
 * — un projet choisissant le contenu d'une communication de L.Y Solution.
 *
 * `kind` est un vocabulaire ferme : un message libre aurait fini par porter une
 * trace d'exception, donc potentiellement un secret, dans un e-mail.
 */
export const platformIncidentPayloadSchema = z
  .object({
    kind: z.enum([
      'CAPABILITY_FAILURE',
      'PANEL_PROJECTION_FAILURE',
      'DEPLOYMENT_FAILURE',
      'SERVICE_UNAVAILABLE',
    ]),
    /** Le composant precis : `billing.checkout.create`, `CONTRACT`, un run... */
    component: z.string().min(1).max(120),
    environment: z.enum(['TEST', 'PROD']),
    occurrences: z.number().int().positive(),
    firstSeenAt: z.string().min(1).max(40),
    /** Erreur DEJA rendue sure par le projet : code stable + message court. */
    error: z
      .object({
        code: z.string().max(80).default(''),
        message: z.string().max(400).default(''),
      })
      .strict(),
    /** L'evenement de domaine qui l'a produit, pour la correlation. */
    eventId: z.string().max(64).nullable().optional(),
  })
  .strict();

export const siteStatusPayloadSchema = z
  .object({
    accessible: z.boolean(),
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    suspensionSource: z.enum(['NONE', 'TECHNICAL', 'CONTRACT', 'PAYMENT_DEFAULT']),
    /** Motif LISIBLE, tel que le projet le formule. Jamais reconstruit ici. */
    reason: z.string().min(1).optional(),
    suspendedAt: isoDate.nullable().optional(),
    contractProtectionEnabled: z.boolean(),
    /** La cause technique, publiée à part : elle prime sur tout le reste. */
    technicalSuspension: z.boolean(),
    /**
     * L'INSTANTANÉ DES CAUSES ACTIVES (L10.6A) — toutes, pas la dominante.
     *
     * `suspensionSource` ne nomme que celle qui prime à l'affichage. Une
     * maintenance technique ET un impayé coexistent parfaitement, et c'est la
     * maintenance qui s'affiche : un Panel qui en conclurait que sa cause
     * financière n'a pas été appliquée se tromperait.
     *
     * OPTIONNEL — une projection antérieure à ce lot n'en porte pas, et l'on ne
     * périme pas ce qui a déjà été reçu. Son absence se lit « je ne sais pas »,
     * jamais « aucune cause ».
     */
    causes: z
      .object({
        technical: z.boolean(),
        contract: z.boolean(),
        paymentDefault: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const teamMemberPayloadSchema = z
  .object({
    sourceUserId: z.string().min(1),
    email: z.string().min(1),
    name: z.string().min(1).optional(),
    role: z.string().min(1),
    createdAt: z.string().nullable().optional(),
  })
  .strict();

/** Métadonnées d'un document contractuel — partagées par le courant et l'histoire. */
const contractDocumentSchema = z
    .object({
      available: z.boolean(),
      /**
       * L'état RÉEL du document, tel que le projet le constate en croisant
       * sa base et son stockage. `UNAVAILABLE` n'est pas `NONE` : le premier
       * dit « référencé mais introuvable », le second « jamais produit ».
       */
      status: z.enum(['NONE', 'GENERATED', 'PENDING_SIGNATURE', 'SIGNED', 'UNAVAILABLE']),
      downloadAvailable: z.boolean(),
      filename: z.string().min(1).optional(),
      contentType: z.string().min(1).optional(),
      pages: z.number().int().nonnegative().optional(),
      sha256: z.string().nullable().optional(),
      version: z.number().int().nonnegative().optional(),
      /** Le parcours EXIGE-t-il une signature ? Absent = ancienne projection. */
      signatureRequired: z.boolean().optional(),
      signatureStatus: z.string().min(1).optional(),
      signedAt: z.string().nullable().optional(),
      generatedAt: z.string().nullable().optional(),
      downloadPath: z.string().startsWith('/').optional(),
    })
    .strict();

/**
 * LA RÉCURRENCE D'UN ABONNEMENT — « tous les <interval> <unit> ».
 *
 * ══ POURQUOI ELLE EST OPTIONNELLE, ET LE RESTE ══════════════════════════════
 *
 * Un projet non encore redéployé ne l'émet pas. La rendre obligatoire ferait
 * REJETER sa projection entière — le Panel perdrait le contrat, son document et
 * son montant pour un champ absent. Absent se lit « projet antérieur au lot »,
 * et le Panel retombe alors sur `interval` seul, lu comme « tous les 1 ».
 *
 * ══ LA VALIDATION EST STRICTE MALGRÉ TOUT ═══════════════════════════════════
 *
 * Quand elle est là, elle doit être JUSTE : c'est cette valeur qui décide de la
 * période d'un Price Stripe. `int().min(1)` n'est pas une politesse — un `0`
 * accepté ici produirait un tarif que le fournisseur refuse, au clic sur
 * « souscrire », des semaines après la signature.
 */
const subscriptionRecurrenceSchema = z
  .object({
    unit: z.enum(['MONTH', 'YEAR']),
    interval: z.number().int().min(1),
  })
  .strict();

/**
 * LA VENTILATION FISCALE D'UNE LIGNE (>= 1.10.0, ADDITIVE).
 *
 * ══ POURQUOI ELLE MONTE, ALORS QUE LE TTC SUFFISAIT ═════════════════════════
 *
 * Le Panel est devenu l'émetteur des factures. Une facture française doit
 * porter le montant HORS TAXE, le TAUX, le MONTANT DE TVA et le TOTAL — et le
 * Panel ne connaissait que le dernier. Il ne pouvait donc produire qu'un
 * document muet sur la taxe : « 95,99 € » trois fois, sans jamais dire combien
 * de TVA il contenait.
 *
 * ══ POURQUOI ON NE LE DÉDUIT PAS ═══════════════════════════════════════════
 *
 * `HT = round(TTC / (1 + taux/100))` semble suffire. Elle produit un résultat
 * qui n'est pas toujours celui que le CONTRAT a calculé : le projet part du HT
 * et arrondit la TVA (`round(HT × taux / 100)`), la déduction part du TTC et
 * arrondit le HT. Sur 95,99 € à 20 %, les deux chemins peuvent différer d'un
 * centime — et cet écart-là apparaîtrait entre le contrat signé et la facture
 * émise, ce qui est exactement l'incohérence la plus coûteuse à expliquer.
 *
 * Le HT est donc TRANSPORTÉ, tel que le contrat le porte, et le Panel VÉRIFIE
 * que `HT + TVA = TTC` avant de facturer plutôt que de recalculer.
 *
 * ══ TOUT EST OPTIONNEL, ET L'ABSENCE NE VAUT PAS ZÉRO ══════════════════════
 *
 * Une projection antérieure à 1.10 ne porte rien de tout cela. Le Panel refuse
 * alors de ventiler — il ne facture pas « 0 % de TVA », ce qui serait une
 * fiscalité inventée.
 */
const pricingTaxFields = {
  /** Le montant HORS TAXE, en centimes, tel que le contrat le porte. */
  amountExcludingTax: z.number().nullable().optional(),
  /** Le montant de TVA, en centimes. `HT + celui-ci` doit valoir le TTC. */
  taxAmount: z.number().nullable().optional(),
  /** Le taux de CETTE ligne, en POURCENTAGE (20 vaut 20 %). */
  taxRate: z.number().min(0).max(100).nullable().optional(),
};

/** Montants d'un contrat — mêmes règles pour le courant et pour l'histoire. */
const contractPricingSchema = z
  .object({
    subscription: z
      .object({
        amountIncludingTax: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        recurrence: subscriptionRecurrenceSchema.nullable().optional(),
        /** Le libellé français, calculé par le projet — jamais ce qui fait foi. */
        recurrenceLabel: z.string().nullable().optional(),
        /** HÉRITAGE : l'UNITÉ seule, sous son ancien nom. */
        interval: z.string().nullable().optional(),
        ...pricingTaxFields,
      })
      .strict()
      .optional(),
    launchFee: z
      .object({
        amountIncludingTax: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        ...pricingTaxFields,
      })
      .strict()
      .optional(),
  })
  .strict();

export const contractPayloadSchema = z
  .object({
    /**
     * Y A-T-IL UN CONTRAT ACTUEL ? — dit franchement, jamais deviné.
     *
     * La projection ne transportait qu'un contrat « choisi ». Quand le projet
     * n'en avait plus aucun en cours, elle envoyait quand même le dernier
     * modifié — donc un contrat résilié — et le Panel l'affichait comme
     * l'engagement du moment, abonnement et document compris. Le contrat le
     * plus récent n'est pas forcément le contrat actuel.
     *
     * Absent des projections antérieures à cette notion : on ne périme pas ce
     * qui a été reçu avant, le champ est donc optionnel.
     */
    hasCurrentContract: z.boolean().optional(),
    /** Les champs suivants décrivent le contrat ACTUEL, quand il en existe un. */
    sourceContractId: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    reference: z.string().nullable().optional(),
    /**
     * MÉTADONNÉES du document contractuel — jamais le fichier.
     *
     * Le PDF reste chez le projet, dans son stockage privé. Le Panel en garde
     * de quoi DIRE ce qui existe et un chemin d'API pour aller le chercher.
     * `downloadPath` est une route du projet, pas un chemin disque : exposer
     * un chemin de fichier dans un espace métier serait une fuite, et
     * deviendrait faux au premier changement d'hébergement.
     */
    document: contractDocumentSchema.optional(),
    createdAt: z.string().nullable().optional(),
    activatedAt: z.string().nullable().optional(),
    pricing: contractPricingSchema.optional(),
    /**
     * LE TAUX DE TVA EFFECTIF — en POURCENTAGE (L10.5).
     *
     * `optional()` parce qu'une projection antérieure à ce lot n'en porte pas,
     * et `nullable()` parce qu'un contrat peut légitimement n'en avoir aucun.
     *
     * Les deux se lisent PAREIL côté Panel : « taux inconnu ». Et un taux
     * inconnu ne devient jamais 20 % par défaut — il fait REFUSER la création
     * d'une prestation, avec un message qui dit quoi corriger. Un repli
     * implicite aurait facturé un client à un taux que personne n'a décidé.
     */
    taxRate: z.number().min(0).max(100).nullable().optional(),
    /**
     * LE DÉLAI DE GRÂCE, EN JOURS ENTIERS (L10.6B-1).
     *
     * `nullable` parce qu'un contrat peut légitimement n'avoir aucune politique,
     * et `optional` parce qu'une projection antérieure au lot n'en porte pas.
     * Les deux se lisent PAREIL : « non configurée » — et le Panel ne suspend
     * alors jamais automatiquement.
     *
     * Borné à un an : au-delà, une grâce n'est plus une grâce, c'est une
     * gratuité, et la valeur trahit une faute de frappe.
     */
    paymentGraceDays: z.number().int().min(0).max(365).nullable().optional(),
    /**
     * L'HISTOIRE — les contrats terminés, du plus récent au plus ancien.
     *
     * Ils restent entièrement consultables : référence, statut terminal,
     * dates, montants, document. Rien n'y est inventé — un motif de
     * résiliation que le projet ne conserve pas n'est pas publié.
     */
    previousContracts: z
      .array(
        z
          .object({
            sourceContractId: z.string().min(1),
            status: z.string().min(1),
            reference: z.string().nullable().optional(),
            createdAt: z.string().nullable().optional(),
            activatedAt: z.string().nullable().optional(),
            endedAt: z.string().nullable().optional(),
            cancellationReason: z.string().nullable().optional(),
            document: contractDocumentSchema.optional(),
            pricing: contractPricingSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const syncPushRequestSchema = z
  .object({
    changes: z.array(syncChangeSchema).min(1).max(500),
  })
  .strict();

export const syncPullQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

// ------------------------------------------------- découverte (>= 1.3.0) ----
// Le Panel SERT ces charges utiles ; il ne les reçoit jamais. Les valider ici
// n'est donc pas une garde d'entrée mais une garantie de SORTIE : ce que le
// Panel promet dans sa spec est ce qu'il envoie réellement.

export const companyProfileSchema = z
  .object({
    companyId: z.string().uuid(),
    slug: z.string().min(2),
    environment: z.enum(['TEST', 'PROD']),
    version: z.number().int().positive().optional(),
    identity: z.object({
      name: z.string().min(1),
      legalName: z.string().nullable().optional(),
      tagline: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
    branding: z.record(z.string(), z.any()).optional(),
    domains: z.record(z.string(), z.any()).optional(),
    contacts: z.record(z.string(), z.any()).optional(),
    legal: z.record(z.string(), z.any()).optional(),
    settings: z.record(z.string(), z.any()).optional(),
    // ADDITIF : un projet antérieur les ignore sans rien casser. Le Panel est
    // désormais l'autorité de l'identité développeur — signataire compris.
    signer: z.record(z.string(), z.any()).nullable().optional(),
    references: z.array(z.record(z.string(), z.any())).optional(),
    // L'ÉQUIPE — additive elle aussi. Un Panel antérieur ne l'envoie pas, et
    // le projet affiche alors une équipe vide : une information manquante,
    // jamais une équipe inventée.
    team: z.array(z.record(z.string(), z.any())).optional(),
  })
  .passthrough();

export const integratedApiConfigSchema = z
  .object({
    apiId: z.string().uuid(),
    key: z.string().min(1),
    label: z.string().optional(),
    provider: z.string().min(1),
    category: z.string().optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(['TEST', 'PROD']),
    settings: z.record(z.string(), z.any()).optional(),
    credentials: z.record(z.string(), z.string()),
    updatedAt: z.string().optional(),
  })
  .passthrough();

/**
 * Ce que le Panel renvoie au bootstrap. Les trois derniers champs sont
 * additifs 1.3.0 : un projet 1.2.x les ignore sans rien casser.
 */
export const bootstrapResponseSchema = z
  .object({
    projectId: z.string().uuid(),
    bridgeToken: z.string().min(16),
    panel: z.object({ name: z.string(), contractVersion: semver }),
    company: companyProfileSchema.nullable().optional(),
    integratedApis: z.array(integratedApiConfigSchema).optional(),
    syncCursor: z.string().nullable().optional(),
  })
  .strict();

/**
 * Ce qu'un projet déclare avoir APPLIQUÉ (ProjectBridge >= 1.3.0). Le Panel
 * le CONSOMME : ce schéma est donc, lui, une vraie garde d'entrée — mais
 * tolérante, un projet plus récent pouvant en dire davantage.
 */
export const appliedConfigurationSchema = z
  .object({
    companyId: z.string().nullable().optional(),
    companySlug: z.string().nullable().optional(),
    companyVersion: z.number().int().nullable().optional(),
    companyAppliedAt: z.string().nullable().optional(),
    integratedApiCount: z.number().int().min(0).optional(),
    integratedApiKeys: z.array(z.string()).optional(),
    lastSyncAt: z.string().nullable().optional(),
  })
  .passthrough();

// ------------------------------------------------------------- utilitaires --
export function parseOrThrow(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
      `${label} non conforme au contrat.`,
      { issues },
    );
  }
  return result.data;
}

export function isContractCompatible(version) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version.trim())) return false;
  return version.trim().split('.')[0] === CONTRACT_VERSION.split('.')[0];
}

export function newBridgeId() {
  return crypto.randomUUID();
}

/** Espace de noms du pont — figé : le changer réécrirait toutes les identités. */
const BRIDGE_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

/**
 * UN IDENTIFIANT MÉTIER LISIBLE → UN UUID STABLE.
 *
 * ══ LE PROBLÈME QU'IL RÈGLE ═════════════════════════════════════════════════
 *
 * Le contrat de pont impose `entityId: uuid`. Beaucoup d'identités métier n'en
 * sont pas : `panel-template-test-<uuid>`, `pay-ok-<id>-<n>`… Les émettre telles
 * quelles faisait rejeter la page ENTIÈRE côté projet, et le rattrapage
 * s'arrêtait là — définitivement, sans erreur visible.
 *
 * Cette dérivation est un UUID v5 : même graine, même identifiant, toujours.
 * L'idempotence du pont — qui repose sur `entityId` — est donc préservée, et
 * l'identité lisible reste dans la charge utile pour la corrélation humaine.
 */
export function stableBridgeId(seed) {
  const ns = Buffer.from(String(BRIDGE_NAMESPACE).replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(String(seed), 'utf8')])).digest();
  const octets = Buffer.from(hash.subarray(0, 16));
  octets[6] = (octets[6] & 0x0f) | 0x50; // version 5
  octets[8] = (octets[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = octets.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso() {
  return new Date().toISOString();
}
