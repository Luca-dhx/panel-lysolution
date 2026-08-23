// DEUX RUNTIMES POUR UN SEUL PROJET — le détecter, et le NOMMER.
//
// ── LE DÉFAUT OBSERVÉ, EN PRODUCTION DE RECETTE ─────────────────────────────
//
// La fiche de Demo SB Auto annonçait un contrat 1.10.0 pendant que l'instance
// déployée parlait 1.13.0. Le mécanisme de convergence était pourtant correct,
// et vérifié. La cause : une SECONDE instance — un `npm start` local oublié,
// sur du code périmé, portant le MÊME jeton de pont — battait elle aussi vers
// le Panel, une fois par minute, et réécrivait la fiche à chaque tour.
//
// Le Panel affichait donc, en alternance et sans le dire, l'état de deux
// logiciels différents. Aucun écran ne pouvait révéler le problème : chaque
// battement pris isolément était parfaitement valide.
//
// ── POURQUOI ON NE PEUT PAS SIMPLEMENT EN REFUSER UN ────────────────────────
//
// Le jeton de pont EST l'identité. Deux détenteurs du même jeton sont, pour le
// Panel, le même projet — et c'est voulu : c'est ce qui permet de redéployer
// sans réappairer. Élire un « vrai » runtime demanderait un critère que le
// Panel n'a pas, et le mauvais choix couperait un projet légitime.
//
// La doctrine est donc la même que pour l'enlisement d'un rejeu : le système
// DÉTECTE et SUPERVISE, un humain décide.
//
// ── COMMENT ON DISTINGUE UN REDÉMARRAGE D'UNE RIVALITÉ ──────────────────────
//
// Par la MONOTONIE. Le temps de fonctionnement d'un runtime ne fait que
// croître ; un redémarrage le remet près de zéro et il recroît depuis là. Une
// lignée abandonnée ne revient JAMAIS.
//
// Deux instances qui alternent, elles, font l'inverse : la lignée qu'on croyait
// morte RESSUSCITE au battement suivant, avec un temps de fonctionnement
// cohérent avec sa propre histoire. C'est cette résurrection — et elle seule —
// qui prouve que deux logiciels vivent en même temps.
//
// Aucun champ n'a été ajouté au contrat de pont : `softwareVersion` et
// `runtime.uptimeSeconds` sont déjà déclarés, et suffisent.

/** Écart toléré entre le temps de fonctionnement attendu et celui déclaré. */
export const LINEAGE_TOLERANCE_S = 90;

/** Au-delà, on considère la rivale disparue et l'on referme le constat. */
export const RIVAL_FORGET_MS = 10 * 60_000;

/**
 * Est-ce que cette déclaration prolonge cette lignée ?
 *
 * Le temps de fonctionnement déclaré doit valoir celui d'avant, PLUS le temps
 * réellement écoulé — à la tolérance près, qui absorbe les cadences irrégulières
 * et les horloges qui ne battent pas ensemble.
 */
export function prolonge(lignee, { uptimeSeconds, at }) {
  if (!lignee || !Number.isFinite(lignee.uptimeSeconds)) return false;
  if (!Number.isFinite(uptimeSeconds)) return false;
  const ecoule = Math.max(0, (Date.parse(at) - Date.parse(lignee.at)) / 1000);
  const attendu = lignee.uptimeSeconds + ecoule;
  return Math.abs(uptimeSeconds - attendu) <= LINEAGE_TOLERANCE_S + ecoule * 0.1;
}

/** Ce qui identifie une lignée à l'écran. Jamais un secret, jamais une adresse. */
const decrire = (l) => (l ? { softwareVersion: l.softwareVersion ?? null, at: l.at } : null);

/**
 * OBSERVE UN BATTEMENT, ET DIT CE QU'IL FAUT RETENIR.
 *
 * Fonction PURE : elle ne lit rien, n'écrit rien, ne date rien elle-même. Tout
 * ce dont elle a besoin lui est donné — ce qui la rend prouvable sans base de
 * données ni horloge.
 *
 * @param {object} p
 * @param {object|null} p.lignee        la lignée retenue jusqu'ici
 * @param {object|null} p.ecartee       une lignée vue puis abandonnée, en attente
 * @param {object|null} p.rival         le constat de rivalité déjà posé
 * @param {object} p.battement          { softwareVersion, uptimeSeconds, at }
 * @returns {{lignee: object, ecartee: object|null, rival: object|null,
 *            evenement: 'RIVAL_DETECTE'|'RIVAL_OUBLIE'|null}}
 */
export function observerBattement({ lignee, ecartee, rival, battement }) {
  const vue = {
    softwareVersion: battement.softwareVersion ?? null,
    uptimeSeconds: Number.isFinite(battement.uptimeSeconds) ? battement.uptimeSeconds : null,
    at: battement.at,
  };

  /**
   * SANS TEMPS DE FONCTIONNEMENT, ON NE CONCLUT RIEN.
   *
   * Un projet antérieur au contrat 1.2 n'en déclare pas. Deviner à partir du
   * seul numéro de version inventerait des rivalités à chaque redéploiement —
   * et une alerte qui se trompe est une alerte qu'on apprend à ignorer.
   */
  if (vue.uptimeSeconds === null) {
    return { lignee: vue, ecartee, rival, evenement: null };
  }

  /* ── Cas 1 : la déclaration prolonge la lignée retenue ──────────────────── */
  if (prolonge(lignee, vue)) {
    const oublier = rival
      && Date.parse(vue.at) - Date.parse(rival.lastSeenAt) >= RIVAL_FORGET_MS;
    return {
      lignee: vue,
      ecartee: null,
      rival: oublier ? null : rival,
      evenement: oublier ? 'RIVAL_OUBLIE' : null,
    };
  }

  /* ── Cas 2 : elle prolonge une lignée qu'on avait ÉCARTÉE ───────────────── */
  if (prolonge(ecartee, vue)) {
    /**
     * LA RÉSURRECTION. Une lignée abandonnée qui reprend exactement où elle en
     * était n'est pas un redémarrage : c'est un logiciel qui n'a jamais cessé
     * de tourner, pendant qu'un autre parlait à sa place.
     */
    const constat = {
      detectedAt: rival?.detectedAt ?? vue.at,
      lastSeenAt: vue.at,
      identities: [decrire(vue), decrire(lignee)],
      /** Combien de fois on a vu la bascule. Il monte : la rivalité dure. */
      alternations: (rival?.alternations ?? 0) + 1,
    };
    return { lignee: vue, ecartee: lignee, rival: constat, evenement: rival ? null : 'RIVAL_DETECTE' };
  }

  /**
   * ── Cas 3 : ni l'une ni l'autre — un redémarrage, ou une lignée neuve ────
   *
   * On retient la nouvelle et on MET DE CÔTÉ celle qu'on quitte. Si elle est
   * vraiment morte, on ne la reverra jamais et rien ne sera signalé. Si elle
   * revient, le cas 2 la reconnaîtra.
   */
  return { lignee: vue, ecartee: lignee ?? ecartee, rival, evenement: null };
}

export default { observerBattement, prolonge, LINEAGE_TOLERANCE_S, RIVAL_FORGET_MS };
