/**
 * L'ADRESSE PUBLIQUE D'UN PROJET — une règle, écrite une seule fois (1.9.0).
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * `PanelProject.runtime.publicBackendUrl` était écrite au BOOTSTRAP, et plus
 * jamais relue. Un projet redéployé sur un autre domaine gardait donc, côté
 * Panel, l'adresse du jour de son appairage. Observé en recette réelle : une
 * fiche annonçait encore l'ancien domaine d'un projet des semaines après sa
 * migration, alors que le projet déclarait correctement le nouveau.
 *
 * La seule façon de la corriger était de RÉAPPAIRER — c'est-à-dire de détruire
 * une relation de confiance pour rafraîchir une donnée d'exploitation.
 *
 * ══ L'INVARIANT ════════════════════════════════════════════════════════════
 *
 *     APPAIRAGE    une relation d'IDENTITÉ et de CONFIANCE
 *     URL PUBLIQUE un ÉTAT COURANT du projet
 *
 * Les deux n'ont pas le même cycle de vie. Une adresse n'est jamais immuable
 * parce qu'elle existait au moment de l'appairage, et le lien de confiance n'a
 * pas à être refait parce qu'une adresse a changé.
 *
 * ══ POURQUOI UN MODULE, ET PAS DEUX LIGNES DANS CHAQUE APPELANT ════════════
 *
 * Deux canaux transportent cette donnée — l'appairage et le battement — et ils
 * affirment tous deux la même chose : « c'est ici que je réponds ». Écrire la
 * règle deux fois garantissait qu'elles divergeraient : c'est déjà arrivé sur
 * l'environnement d'un projet, dont l'annonce et la lecture avaient fini par
 * ne plus employer la même règle, et la destination existait sans être trouvée.
 *
 * Il vit à part plutôt que dans le registre pour une raison plus prosaïque :
 * l'appairage est importé PAR le registre. Y placer la règle aurait créé un
 * cycle, et un cycle se paie toujours plus tard.
 */
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { normalizeBackendUrl } from './projectIdentity.js';

/**
 * D'OÙ VIENT UNE DÉCLARATION DE RÉSEAU. Fermé — et volontairement COURT.
 *
 * ══ POURQUOI LA PROJECTION DE PRÉSENTATION N'EN FAIT PAS PARTIE ═════════════
 *
 * Elle en a fait partie le temps d'une itération, et une suite de bout en bout
 * l'a arrêtée net — à raison. Le champ écrit ici n'est pas de même nature que
 * `PROJECT_PRESENTATION.network.backend` :
 *
 *     publicBackendUrl                l'adresse OPÉRATIONNELLE
 *                                     « c'est ICI que je réponds, maintenant »
 *
 *     PROJECT_PRESENTATION.network    l'adresse DÉCLARATIVE
 *                                     « voici le domaine que je vise »
 *
 * En production les deux coïncident, ce qui rend la confusion facile et son
 * effet invisible — jusqu'au moment où elles divergent : une instance servie
 * sur un port éphémère, une recette locale, un déploiement dont le DNS n'a pas
 * encore basculé. La projection annonce alors un domaine parfaitement exact où
 * PERSONNE n'écoute encore, et le Panel se met à appeler dans le vide en
 * concluant que le projet est en panne.
 *
 * `pairing.service.js` documentait déjà cet arbitrage — « le manifeste est
 * DESCRIPTIF, il peut nommer le domaine visé alors que le service répond
 * ailleurs » — et le lui faire perdre a immédiatement cassé le parcours fédéré
 * de bout en bout : le Panel appelait le domaine déclaré au lieu du port réel.
 *
 * La projection garde donc son rôle, qui est le bon : elle alimente la
 * DESTINATION (`projectDestination.service.js`), là où une adresse visée a un
 * sens. Elle n'écrit pas l'adresse à laquelle on rappelle.
 *
 * Ne restent ici que des sources OPÉRATIONNELLES — celles où le projet dit où
 * il répond, à l'instant où il le dit.
 */
export const NETWORK_DECLARATION_SOURCES = Object.freeze({
  /**
   * L'appairage : « rappelez-moi ICI ». Opérationnel par construction — c'est
   * l'adresse par laquelle le projet vient de nous joindre. Mais ponctuel : il
   * pose la valeur initiale et ne revient jamais sur une déclaration vivante.
   */
  BOOTSTRAP: 'BOOTSTRAP',
  /**
   * Le battement de cœur (>= 1.9.0) : la même affirmation, RÉPÉTÉE. C'est ce
   * qui rend l'adresse vivante au lieu de figée, et c'est tout l'objet du lot.
   */
  HEARTBEAT: 'HEARTBEAT',
});

/**
 * APPLIQUE L'ADRESSE PUBLIQUE QUE LE PROJET VIENT DE DÉCLARER.
 *
 * ══ CE QUE CETTE FONCTION NE FAIT JAMAIS ═══════════════════════════════════
 *
 *   · elle n'INVENTE aucune adresse. Une valeur illisible est ignorée et
 *     l'ancienne reste : mieux vaut une adresse datée qu'une adresse fausse ;
 *   · elle n'EFFACE pas une adresse connue sur une déclaration vide. Un projet
 *     qui ne publie pas son réseau ne déclare pas qu'il n'en a pas ;
 *   · elle ne fait REMONTER aucune valeur du Panel vers le projet. L'autorité
 *     de l'adresse est le projet, et elle le reste — le Panel REFLÈTE.
 *
 * @param {object} record             la fiche projet (mutée sur place)
 * @param {object} args
 * @param {string} args.backendUrl    l'adresse déclarée, telle quelle
 * @param {string} args.source        `NETWORK_DECLARATION_SOURCES`
 * @param {string} [args.declaredAt]  l'horloge du PROJET — informative
 * @returns {boolean} `true` si la fiche a changé.
 */
/**
 * ══ UNE ADRESSE « PUBLIQUE » DOIT ÊTRE JOIGNABLE DE L'EXTÉRIEUR ═════════════
 *
 * ── LE DÉFAUT OBSERVÉ À LA CERTIFICATION FACTORY ──────────────────────────
 *
 * Un projet appairé, lancé en LOCAL par un développeur, déclare au battement
 * `http://localhost:6090`. Le Panel l'acceptait, la retenait comme adresse
 * publique, et le service de destinations RETIRAIT le vrai domaine pour la
 * remplacer par `localhost`.
 *
 * Trois conséquences, toutes silencieuses :
 *   · le Panel rappelait `localhost` — c'est-à-dire lui-même — pour sonder le
 *     projet ;
 *   · l'appartenance du nom, qui se lit sur la destination ACTIVE, devenait
 *     fausse : le DNS automatique refusait le vrai domaine du projet ;
 *   · la fiche annonçait une adresse que personne au monde ne peut atteindre.
 *
 * Avec un parc, n'importe quel développeur qui lance un projet en local détruit
 * ainsi ce que le Panel sait du domaine de production, sans que rien ne le dise.
 *
 * ── POURQUOI REFUSER PLUTÔT QUE CORRIGER ───────────────────────────────────
 *
 * La règle qui gouverne déjà cette fonction est « une valeur illisible est
 * ignorée et l'ancienne reste : mieux vaut une adresse datée qu'une adresse
 * fausse ». `localhost` n'est pas illisible — elle est LISIBLEMENT FAUSSE, et
 * le même raisonnement s'applique avec plus de force encore.
 *
 * Le projet n'est pas en faute : il dit la vérité sur où il répond. C'est le
 * Panel qui n'a pas à retenir, comme adresse PUBLIQUE, une adresse qui ne l'est
 * pas.
 */
const HOTES_NON_PUBLICS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /\.local$/i,
  /\.localhost$/i,
  /\.internal$/i,
];

/** Cette adresse peut-elle être atteinte depuis l'extérieur ? */
export function isPubliclyRoutableBackendUrl(url) {
  let hote;
  try { hote = new URL(String(url)).hostname; } catch { return false; }
  if (!hote) return false;
  if (HOTES_NON_PUBLICS.some((re) => re.test(hote))) return false;
  /**
   * Un nom sans point n'est pas un nom de domaine : c'est un nom de machine sur
   * un réseau local. Les adresses IP publiques, elles, en contiennent.
   */
  if (!hote.includes('.') && !hote.includes(':')) return false;
  return true;
}

export function applyDeclaredNetwork(record, { backendUrl, source, declaredAt = null } = {}) {
  if (!record?.runtime) return false;

  const normalisee = normalizeBackendUrl(backendUrl);
  if (!normalisee) return false;

  /**
   * ON GARDE CE QU'ON SAVAIT. Refuser n'est pas ignorer : le refus est
   * journalisé, parce qu'un projet qui annonce une adresse privée dit quelque
   * chose de vrai sur lui — il tourne ailleurs que là où on croit.
   */
  if (!isPubliclyRoutableBackendUrl(normalisee)) {
    logger.warn(
      `[registry] ${record.projectId} — adresse publique REFUSÉE : « ${normalisee} » `
      + `n'est pas joignable depuis l'extérieur (${source}). `
      + `Le Panel conserve ${record.runtime.publicBackendUrl ?? 'aucune adresse'}.`,
    );
    return false;
  }

  /**
   * LE BOOTSTRAP NE REVIENT PAS SUR UNE DÉCLARATION VIVANTE.
   *
   * Un réappairage rejoue le bootstrap avec l'adresse que le projet présente à
   * ce moment-là — c'est la bonne, et elle passe. Mais une reprise, une façade
   * ou un test qui rejouerait un bootstrap ANCIEN ne doit pas pouvoir
   * réintroduire l'adresse périmée qu'on vient précisément de corriger.
   */
  const dejaVivante = record.runtime.publicBackendUrlSource
    && record.runtime.publicBackendUrlSource !== NETWORK_DECLARATION_SOURCES.BOOTSTRAP;
  if (source === NETWORK_DECLARATION_SOURCES.BOOTSTRAP
      && dejaVivante
      && record.runtime.publicBackendUrl
      && record.runtime.publicBackendUrl !== normalisee) {
    return false;
  }

  const ancienne = record.runtime.publicBackendUrl ?? null;
  const change = ancienne !== normalisee;

  record.runtime.publicBackendUrl = normalisee;
  /**
   * L'HORODATAGE EST CELUI DE LA RÉCEPTION, PAS CELUI DU PROJET.
   *
   * `declaredAt` vient d'une horloge que le Panel ne contrôle pas. Une dérive
   * — fréquente juste après un redéploiement — ferait apparaître une
   * déclaration comme future, ou comme vieille de trois jours alors qu'elle
   * vient d'arriver. On retient donc l'instant où NOUS l'avons apprise : c'est
   * la seule chose que le Panel puisse affirmer de lui-même.
   */
  record.runtime.publicBackendUrlUpdatedAt = nowIso();
  record.runtime.publicBackendUrlSource = source ?? null;

  if (change) {
    logger.info(
      `[registry] ${record.projectId} — adresse publique déclarée : `
      + `${ancienne ?? 'aucune'} → ${normalisee} (${source}).`,
    );
  }
  return true;
}

export default { NETWORK_DECLARATION_SOURCES, applyDeclaredNetwork };
