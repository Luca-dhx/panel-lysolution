// L'ASSERTION FÉDÉRÉE — ce que le Panel affirme d'un DEV, à UN projet (L12.A).
//
// docs/auth/PANEL_FEDERATED_DEV_IDENTITY_IMPLEMENTATION.md §« ASSERTION ».
//
// ── CE QU'UNE ASSERTION EST, ET CE QU'ELLE N'EST PAS ────────────────────────
//
// Ce n'est PAS une session de projet. C'est un LAISSEZ-PASSER DE TRANSITION,
// valable quelques minutes, qui dit une seule chose :
//
//     « Moi, ce Panel, j'affirme que le porteur est le PanelUser <sub>,
//       qu'il est DEV, qu'il a le droit d'entrer dans le projet <aud>,
//       et que sa version de session est <tokenVersion>. »
//
// Le projet en dérivera SA session, avec SA durée. Confondre les deux ferait
// d'une assertion interceptée un accès de plusieurs heures.
//
// ── L'ORDRE DES VÉRIFICATIONS, ET POURQUOI CELUI-LÀ ─────────────────────────
//
//   1. l'utilisateur, RELU EN BASE      jamais l'objet de la session HTTP
//   2. le compte est-il actif           enabled
//   3. le rôle donne-t-il cet accès     DEV strictement
//   4. le projet existe-t-il            registre
//   5. l'appairage l'autorise-t-il      PAIRED
//   6. cet utilisateur a-t-il CE projet accès explicite ou ALL_PAIRED
//   7. les mondes concordent-ils        runtime vs fiche
//   8. y a-t-il une clé pour signer     sinon refus de configuration
//
// L'identité passe avant le projet : un compte désactivé ne doit pas révéler,
// par la nature du refus, quels projets existent.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import logger from '../../utils/logger.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import { runtimeEnvironment } from '../integratedApi/environment.js';
import {
  authoritativeEnvironmentOf, environmentContradicted,
} from '../registry/projectEnvironment.js';
import { PROJECT_ACCESS_MODES, getStoredUserById } from '../auth/panelUsers.service.js';
import { FEDERATED_PROJECT_ROLE, grantsProjectFederation } from '../auth/panelRoles.js';
import PanelProject from '../../models/PanelProject.model.js';
import { FEDERATION_ERROR_CODES as E, FederationDenied } from './federationErrors.js';
import { publicKeyFor, signingKey, ensureActiveKey } from './federationKeys.service.js';

/**
 * L'ÉMETTEUR — stable, et propre à cette instance de Panel.
 *
 * Une URN plutôt qu'une URL : l'adresse publique du Panel peut changer
 * (migration, domaine, reverse proxy), et un `iss` qui change invaliderait
 * toutes les assertions en vol pour une raison qui n'a rien à voir avec la
 * sécurité. Un projet épingle cette valeur une fois, à l'appairage.
 */
export const FEDERATION_ISSUER = 'urn:ly-solution:panel';

/**
 * LE TYPE DE PRINCIPAL — dit au projet à quoi il a affaire.
 *
 * Sans lui, un projet qui verrait un jour arriver un second type d'assertion
 * (un service, une machine) devrait le deviner à la forme des claims.
 */
export const PRINCIPAL_TYPE = 'PANEL_USER';

/**
 * TROIS MINUTES — au milieu de la fourchette 2-5 que le lot fixe.
 *
 * ── POURQUOI SI COURT ──────────────────────────────────────────────────────
 *
 * Cette assertion voyage dans une URL de redirection : elle finit donc dans un
 * historique de navigateur, potentiellement dans un journal de reverse proxy,
 * et dans le `Referer` d'une requête suivante. Sa durée de vie est la fenêtre
 * pendant laquelle une fuite est exploitable, et le seul geste qu'elle doit
 * permettre — l'échange contre une session projet — prend deux secondes.
 *
 * Trois minutes, et non trente secondes : un poste dont l'horloge dérive d'une
 * minute rendrait la fédération aléatoire, et le diagnostic serait atroce.
 */
export const ASSERTION_TTL_SECONDS = 180;

/**
 * TOLÉRANCE D'HORLOGE à la vérification.
 *
 * Deux machines qui ne sont pas à la même seconde ne doivent pas produire un
 * refus. 30 secondes est assez pour absorber une dérive NTP ordinaire, et
 * assez peu pour ne pas prolonger notablement une assertion de trois minutes.
 */
export const CLOCK_TOLERANCE_SECONDS = 30;

/** Les appairages qui autorisent un accès DEV. Un seul, et c'est voulu. */
const PAIRING_ALLOWED = Object.freeze(['PAIRED']);

/**
 * CE RÔLE DONNE-T-IL L'ACCÈS DÉVELOPPEUR AUX PROJETS ?
 *
 * ── DÉCISION SUR ADMIN, ET SA JUSTIFICATION ─────────────────────────────────
 *
 * **`DEV` et `SUPER_ADMIN` sont autorisés. `ADMIN` est refusé.**
 *
 * Le lot demande de trancher explicitement plutôt que de supposer. La doctrine
 * du Panel est déjà écrite dans `requirePanelDeveloper` : les surfaces
 * techniques — plan de contrôle, modèles e-mail, intégrations — sont réservées
 * aux capacités développeur, et ADMIN en est exclu. Entrer dans le manager d'un
 * projet client avec les droits DEV est une surface technique de la même
 * nature, et `SUPER_ADMIN ≥ DEV`.
 *
 * On note l'asymétrie apparente : à l'intérieur du Panel, « DEV est un superset
 * d'ADMIN ». Cela ne rend pas ADMIN plus autorisé — cela rend DEV plus large.
 * Un ADMIN du Panel n'est pas un développeur, et n'a rien à faire dans le code
 * d'un client — y compris s'il porte un `projectAccess` hérité : le rôle est
 * vérifié AVANT l'accès, et un accès accordé par erreur n'ouvre donc rien.
 */
function roleGrantsProjectAccess(role) {
  return grantsProjectFederation(role);
}

/** Cet utilisateur a-t-il accès à CE projet ? */
function accessCoversProject(projectAccess, projectId) {
  const mode = projectAccess?.mode ?? PROJECT_ACCESS_MODES.NONE;
  if (mode === PROJECT_ACCESS_MODES.ALL_PAIRED) return true;
  if (mode === PROJECT_ACCESS_MODES.EXPLICIT) {
    return (projectAccess?.projectIds ?? []).map(String).includes(String(projectId));
  }
  return false;
}

/**
 * ÉMET une assertion pour `panelUserId` vers `projectId`.
 *
 * ── CE QUE L'APPELANT NE FOURNIT PAS ────────────────────────────────────────
 *
 * Ni le rôle, ni la version de session, ni l'identité affichée. Il fournit UN
 * identifiant d'utilisateur — celui que sa session Panel a prouvé — et UN
 * projet. Tout le reste est relu en base, à cet instant. Un appelant qui
 * pourrait proposer `role` ou `tokenVersion` pourrait s'accorder un accès qu'il
 * n'a pas, ou rejouer une version révoquée.
 *
 * @throws {FederationDenied} avec un `reasonCode` du catalogue.
 */
export async function issueProjectAssertion({ panelUserId, projectId, requestedBy = null }) {
  /**
   * CE QU'ON SAIT DE LA DÉCISION, AU FUR ET À MESURE QU'ON L'APPREND.
   *
   * ── POURQUOI UN ACCUMULATEUR PLUTÔT QUE DES ARGUMENTS ─────────────────────
   *
   * Un refus doit pouvoir NOMMER l'état qui l'a produit — le mode d'accès du
   * compte, l'appairage du projet. Or ces faits ne sont connus qu'après les
   * lectures qui peuvent elles-mêmes refuser. Les passer en arguments à chaque
   * `deny()` obligerait à répéter, à chaque point de sortie, une liste qu'on
   * finirait par oublier de compléter — et un journal incomplet à l'endroit
   * précis où l'on enquête ne vaut pas mieux qu'un journal absent.
   *
   * `null` y signifie « pas encore lu », jamais « absent » : la distinction est
   * ce qui permet de lire, dans le journal, JUSQU'OÙ la décision est allée.
   */
  const observed = {
    projectAccessMode: null,
    projectPaired: null,
  };

  const deny = async (reasonCode, message, details = null) => {
    await audit({
      outcome: 'DENIED', panelUserId, projectId, reasonCode, requestedBy, ...observed,
    });
    throw new FederationDenied(reasonCode, message, details);
  };

  // ── 1. L'UTILISATEUR, RELU EN BASE ────────────────────────────────────────
  // Jamais l'objet de la requête : il a été construit à l'authentification, et
  // le compte a pu être désactivé depuis.
  const user = await getStoredUserById(panelUserId);
  if (!user) {
    return deny(E.USER_DISABLED, 'Ce compte n’existe plus.');
  }

  // ── 2. LE COMPTE EST-IL ACTIF ? ───────────────────────────────────────────
  if (user.enabled === false) {
    return deny(E.USER_DISABLED, 'Ce compte est désactivé : aucun accès projet ne peut être délivré.');
  }

  /**
   * LE MODE EST RELEVÉ SUR LE DOCUMENT QU'ON VIENT DE LIRE, ET SUR LUI SEUL.
   *
   * Pas sur la session, pas sur un paramètre, pas sur une copie mémorisée : ce
   * qui est journalisé doit être exactement ce qui décide, sans quoi le journal
   * expliquerait une décision que le code n'a pas prise.
   */
  observed.projectAccessMode = user.projectAccess?.mode ?? PROJECT_ACCESS_MODES.NONE;

  // ── 3. LE RÔLE DONNE-T-IL CET ACCÈS ? ─────────────────────────────────────
  if (!roleGrantsProjectAccess(user.role)) {
    return deny(
      E.ROLE_FORBIDDEN,
      `Le rôle ${user.role} ne donne pas l’accès développeur aux projets.`,
    );
  }

  // ── 4. LE PROJET EXISTE-T-IL ? ────────────────────────────────────────────
  const project = await PanelProject.findOne({ projectId: String(projectId) }).lean();
  if (!project) {
    return deny(E.PROJECT_UNKNOWN, `Aucun projet « ${projectId} » au registre.`);
  }

  // ── 5. L'APPAIRAGE AUTORISE-T-IL ? ────────────────────────────────────────
  const pairing = project.pairing?.status ?? null;
  observed.projectPaired = PAIRING_ALLOWED.includes(pairing);
  if (!observed.projectPaired) {
    return deny(
      E.PROJECT_NOT_PAIRED,
      `L’appairage de ce projet est « ${pairing ?? 'inconnu'} » : aucun accès n’est délivré.`,
    );
  }

  // ── 6. CET UTILISATEUR A-T-IL CE PROJET ? ─────────────────────────────────
  if (!accessCoversProject(user.projectAccess, project.projectId)) {
    return deny(
      E.PROJECT_ACCESS_DENIED,
      'Ce compte n’a pas d’accès déclaré à ce projet.',
    );
  }

  /**
   * ── 7. POUR QUEL MONDE SIGNE-T-ON ? ──────────────────────────────────────
   *
   * ══ CE QUI ÉTAIT COMPARÉ, ET POURQUOI C'ÉTAIT DEVENU FAUX ═══════════════
   *
   * On confrontait l'annonce du projet au `config.env` du Panel, et l'on
   * refusait toute divergence. La règle était juste tant qu'un Panel ne pouvait
   * appairer que des projets de son propre monde.
   *
   * Depuis qu'un plan de contrôle de recette ADMINISTRE une production
   * (05_PAIRING §9), cette confrontation refusait purement et simplement la
   * connexion fédérée de tout projet en production — c'est-à-dire la seule
   * façon d'entrer dans son Manager. Le lot qui ouvre le pilotage aurait fermé
   * la porte d'entrée.
   *
   * ══ CE QU'ON COMPARE MAINTENANT ════════════════════════════════════════
   *
   * L'assertion est émise POUR UN PROJET : le monde qu'elle porte est celui du
   * PROJET, épinglé sur sa fiche — pas celui de l'instance qui la signe.
   *
   * Ce qui reste refusé, c'est l'INCERTITUDE : un projet qui ANNONCE un monde
   * différent de celui épinglé sur sa fiche nous laisse sans savoir pour qui
   * l'on signe. L'épingle fait autorité partout ailleurs ; ici, où l'on émet un
   * droit d'entrée, la contradiction elle-même suffit à refuser.
   */
  const served = runtimeEnvironment();
  if (environmentContradicted(project)) {
    return deny(
      E.ENVIRONMENT_MISMATCH,
      `La fiche de ce projet est enregistrée en ${project.declaredEnvironment} `
      + `alors qu’il annonce ${project.runtime?.environment}. `
      + 'Aucune assertion n’est émise tant que les deux ne concordent pas.',
    );
  }
  /**
   * Le monde PORTÉ par l'assertion. `served` ne sert que de repli pour une
   * fiche antérieure à l'épinglage, dont le projet n'a jamais parlé.
   */
  const monde = authoritativeEnvironmentOf(project) ?? served;

  // ── 8. Y A-T-IL UNE CLÉ POUR SIGNER ? ─────────────────────────────────────
  await ensureActiveKey();
  const key = await signingKey();
  if (!key) {
    return deny(E.KEY_UNAVAILABLE, 'Aucune clé de signature fédérée n’est disponible.');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();

  /**
   * LES CLAIMS — le minimum, et rien de plus.
   *
   * Pas de nom affiché, pas d'adresse : le projet les obtiendra par la
   * projection du LOT 2B, où ils pourront être corrigés. Les figer dans une
   * assertion en ferait des données périmées et recopiées.
   */
  const token = jwt.sign(
    {
      principalType: PRINCIPAL_TYPE,
      panelUserId: user.userId,
      /**
       * LE RÔLE PROJETÉ — `DEV`, TOUJOURS. Jamais `user.role`.
       *
       * ══ POURQUOI LE PANEL NE DIT PAS AU PROJET CE QU'IL EST CHEZ LUI ═══════
       *
       * Un projet client possède son propre modèle de rôles et ignore le
       * nôtre. Recopier `user.role` lui enverrait un jour `SUPER_ADMIN` — une
       * valeur dont il ne sait rien, et à laquelle quelqu'un finirait par
       * donner un sens. Une hiérarchie interne du PANEL déciderait alors de
       * privilèges CHEZ UN CLIENT, sans que personne l'ait décidé.
       *
       * L'assertion affirme donc une seule chose : « ce porteur est un
       * développeur autorisé ». `DEV` et `SUPER_ADMIN` produisent exactement
       * le même claim, et le vérificateur refuse tout autre valeur.
       */
      role: FEDERATED_PROJECT_ROLE,
      /**
       * LA VERSION DE SESSION, LUE À L'INSTANT DE L'ÉMISSION.
       *
       * C'est elle qui permettra au projet, au LOT 2B, de savoir si la session
       * qu'il a ouverte repose encore sur une identité valable.
       */
      tokenVersion: user.tokenVersion ?? 0,
      environment: monde,
      jti,
    },
    key.privateKeyPem,
    {
      algorithm: key.algorithm,
      issuer: FEDERATION_ISSUER,
      audience: project.projectId,
      subject: user.userId,
      expiresIn: ASSERTION_TTL_SECONDS,
      /**
       * `kid` DANS L'EN-TÊTE, pas dans les claims.
       *
       * Le vérificateur doit choisir sa clé AVANT de faire confiance à quoi que
       * ce soit — donc avant de lire un claim, qui n'est pas encore vérifié.
       */
      keyid: key.kid,
      header: { kid: key.kid },
    },
  );

  const expiresAt = new Date((issuedAt + ASSERTION_TTL_SECONDS) * 1000).toISOString();

  await audit({
    outcome: 'ISSUED',
    panelUserId: user.userId,
    projectId: project.projectId,
    kid: key.kid,
    jti,
    expiresAt,
    requestedBy,
    ...observed,
  });

  return {
    assertion: token,
    /** Métadonnées d'affichage. Le jeton n'est JAMAIS journalisé, celles-ci si. */
    kid: key.kid,
    jti,
    audience: project.projectId,
    issuer: FEDERATION_ISSUER,
    expiresAt,
    expiresInSeconds: ASSERTION_TTL_SECONDS,
  };
}

/**
 * LE VÉRIFICATEUR DE RÉFÉRENCE (Phase 14).
 *
 * ── CE QU'IL EST, ET CE QU'IL N'EST PAS ─────────────────────────────────────
 *
 * C'est la SPÉCIFICATION EXÉCUTABLE de ce qu'un projet devra faire au LOT 2B.
 * Il vit ici parce qu'il doit être éprouvé avant qu'un projet en dépende — un
 * vérificateur écrit en même temps que son premier consommateur n'est jamais
 * mis en défaut, il est seulement mis d'accord avec lui.
 *
 * Ce n'est PAS le runtime d'un projet : le projet aura sa propre implémentation,
 * lisant le JWKS publié, sans accès à cette base.
 *
 * ── CE QU'IL VÉRIFIE, ET DANS QUEL ORDRE ────────────────────────────────────
 *
 *   en-tête → kid → clé → signature → iss → aud → exp → contrat de claims
 *
 * L'algorithme est IMPOSÉ, jamais lu du jeton : accepter l'algorithme annoncé
 * par le jeton qu'on vérifie est la confusion d'algorithme, et c'est ainsi
 * qu'on transforme une clé publique en secret HMAC.
 *
 * @returns {Promise<{valid: boolean, reasonCode?: string, claims?: object}>}
 */
export async function verifyProjectAssertion(token, { audience, now = null } = {}) {
  const fail = (reasonCode) => ({ valid: false, reasonCode });

  if (typeof token !== 'string' || token.length === 0) {
    return fail(E.ASSERTION_MALFORMED);
  }

  // L'en-tête se lit sans confiance : il ne sert qu'à CHOISIR la clé.
  let decoded;
  try {
    decoded = jwt.decode(token, { complete: true });
  } catch {
    return fail(E.ASSERTION_MALFORMED);
  }
  if (!decoded?.header) return fail(E.ASSERTION_MALFORMED);

  const kid = decoded.header.kid ?? null;
  if (!kid) return fail(E.ASSERTION_MALFORMED);

  const key = await publicKeyFor(kid);
  if (!key) return fail(E.ASSERTION_UNKNOWN_KEY);

  let claims;
  try {
    claims = jwt.verify(token, key.publicKeyPem, {
      // IMPOSÉ. Jamais `decoded.header.alg`.
      algorithms: [key.algorithm],
      issuer: FEDERATION_ISSUER,
      audience: String(audience),
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      ...(now ? { clockTimestamp: Math.floor(now / 1000) } : {}),
    });
  } catch (error) {
    /**
     * LA CAUSE EST NOMMÉE POUR LE JOURNAL, PAS POUR LE PORTEUR.
     *
     * Un vérificateur de projet ne devra pas renvoyer ces codes à un appelant
     * anonyme : « mauvaise audience » lui apprendrait pour quel projet
     * l'assertion qu'il détient est valable.
     */
    if (error?.name === 'TokenExpiredError') return fail(E.ASSERTION_EXPIRED);
    if (error?.message?.includes('audience')) return fail(E.ASSERTION_WRONG_AUDIENCE);
    if (error?.message?.includes('issuer')) return fail(E.ASSERTION_WRONG_ISSUER);
    return fail(E.ASSERTION_INVALID_SIGNATURE);
  }

  /**
   * LE CONTRAT DE CLAIMS — vérifié APRÈS la signature, et quand même vérifié.
   *
   * Une signature valide prouve que NOUS avons émis, pas que nous avons émis
   * ce qu'on croit lire. Un jeton signé par cette clé pour un autre usage — il
   * n'y en a pas aujourd'hui, il y en aura — ne doit pas passer pour une
   * assertion de fédération.
   */
  if (claims.principalType !== PRINCIPAL_TYPE) return fail(E.ASSERTION_CONTRACT_VIOLATION);
  if (!claims.sub || claims.sub !== claims.panelUserId) return fail(E.ASSERTION_CONTRACT_VIOLATION);
  if (!claims.jti) return fail(E.ASSERTION_CONTRACT_VIOLATION);
  if (!Number.isInteger(claims.tokenVersion)) return fail(E.ASSERTION_CONTRACT_VIOLATION);
  /**
   * LE RÔLE PORTÉ DOIT ÊTRE EXACTEMENT LE RÔLE PROJETÉ.
   *
   * Et non « un rôle qui donnerait accès ». La nuance est la garde : une
   * assertion portant `SUPER_ADMIN` est REFUSÉE, alors même que ce rôle
   * autorise la fédération côté Panel. C'est le contrôle qui rend la
   * projection obligatoire plutôt que conventionnelle — si un jour quelqu'un
   * recopie `user.role` dans les claims, cette ligne le refuse au lieu de le
   * laisser passer chez le client.
   */
  if (claims.role !== FEDERATED_PROJECT_ROLE) return fail(E.ASSERTION_CONTRACT_VIOLATION);

  return { valid: true, claims, kid };
}

/**
 * OBSERVABILITÉ — ce qui est écrit, et rien d'autre.
 *
 * Jamais le jeton, jamais la clé privée, jamais un mot de passe. Le `jti` est
 * écrit ENTIER et c'est sans risque : il n'ouvre rien seul, et il est la seule
 * poignée qui permettra, au LOT 2B, de rapprocher une émission du Panel d'une
 * consommation dans un projet — donc de répondre à « cette assertion a-t-elle
 * servi, et où ».
 */
async function audit({
  outcome, panelUserId, projectId, reasonCode = null, kid = null, jti = null,
  expiresAt = null, requestedBy = null, projectAccessMode = null, projectPaired = null,
}) {
  /**
   * L'ÉVÉNEMENT EST NOMMÉ, ET LE NOM DIT LA DÉCISION.
   *
   * ── POURQUOI UN CHAMP `event` EN PLUS DE `outcome` ────────────────────────
   *
   * `outcome: 'DENIED'` ne dit pas CE QUI a été refusé : un accès projet, un
   * rôle, un appairage, une clé absente. Chercher un refus d'accès projet dans
   * un journal obligeait donc à connaître le catalogue de codes et à filtrer
   * sur deux champs à la fois. Un nom stable — celui-là même que le lot
   * demande — se cherche tel quel, et il ne change pas quand le catalogue
   * s'enrichit.
   */
  const event = outcome === 'ISSUED'
    ? 'FEDERATION_PROJECT_ACCESS_GRANTED'
    : (reasonCode ?? 'FEDERATION_DENIED');

  const observation = {
    event,
    outcome,
    /**
     * L'ACTEUR — le compte POUR QUI la décision est prise.
     *
     * Nommé `actorUserId` en plus de `panelUserId` parce que c'est sous ce nom
     * que les autres journaux d'administration désignent le sujet d'un acte :
     * une enquête qui traverse plusieurs surfaces ne doit pas avoir à traduire.
     */
    actorUserId: panelUserId ?? null,
    panelUserId: panelUserId ?? null,
    projectId: projectId ?? null,
    reasonCode,
    /**
     * L'ÉTAT QUI A DÉCIDÉ — relu en base à cet instant, jamais une session.
     * `null` signifie « la décision s'est arrêtée avant de le lire ».
     */
    projectAccessMode,
    projectPaired,
    kid,
    jti,
    expiresAt,
    requestedBy,
  };

  logger.info(`[federation] ${JSON.stringify(observation)}`);

  await recordEvent({
    // La chronologie est partitionnée par projet : une demande qui ne désigne
    // aucun projet connu reste lisible sous `null` plutôt que d'être perdue.
    projectId: projectId ?? null,
    type: outcome === 'ISSUED'
      ? EVENT_TYPES.FEDERATED_ASSERTION_ISSUED
      : EVENT_TYPES.FEDERATED_ASSERTION_DENIED,
    source: 'PANEL',
    severity: outcome === 'ISSUED' ? 'INFO' : 'WARNING',
    summary: outcome === 'ISSUED'
      ? `Accès développeur délivré au compte ${panelUserId} pour ce projet.`
      : `Accès développeur refusé — ${reasonCode}.`,
    data: observation,
  }).catch(() => {});
}

export default {
  ASSERTION_TTL_SECONDS,
  CLOCK_TOLERANCE_SECONDS,
  FEDERATION_ISSUER,
  PRINCIPAL_TYPE,
  issueProjectAssertion,
  verifyProjectAssertion,
};
