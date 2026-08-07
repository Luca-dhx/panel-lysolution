/**
 * GÉNÉRATION D'UNE SOURCE — « ces données viennent-elles encore du même projet ? »
 *
 * ── LE PROBLÈME QU'ELLE RÉSOUT ──────────────────────────────────────────────
 * Une même destination a été redéployée de PROD vers TEST. Le `projectId` du
 * registre n'a pas bougé — c'est toujours la même fiche — mais TOUT le reste a
 * changé : autre base de données, autres utilisateurs, autre contrat. Le Panel
 * a pourtant continué d'afficher l'identité, l'équipe et le contrat de PROD
 * comme s'ils étaient l'état courant du projet.
 *
 * Rien ne pouvait l'en empêcher : une projection ne portait que sa date. Or
 * comparer des dates n'a de sens qu'À L'INTÉRIEUR d'une même génération. Un
 * contrat TEST créé hier est plus RÉCENT, en vérité, qu'un contrat PROD
 * modifié ce matin — parce qu'il vient d'un monde qui a remplacé l'autre.
 *
 * ── CE QUI SERT DE GÉNÉRATION, ET POURQUOI ──────────────────────────────────
 * Aucun champ nouveau ne traverse le pont : le Panel a déjà, dans son propre
 * registre, de quoi dater la génération d'un projet.
 *
 *   · `runtime.environment` — PROD ou TEST, annoncé au bootstrap puis à chaque
 *     battement. C'est ce qui change lors d'un redéploiement croisé.
 *   · `pairing.pairedAt`   — l'instant du dernier appairage. Changer
 *     d'environnement change de base, donc de jeton : le projet DOIT se
 *     réappairer, et cet horodatage bouge. Deux instances successives ne
 *     partagent jamais le même.
 *
 * La paire des deux forme une clé de génération stable, calculée ici et nulle
 * part ailleurs.
 */

/**
 * ── CE QUI MANQUAIT À LA CLÉ, ET CE QUE ÇA A COÛTÉ ──────────────────────────
 *
 * La paire (environnement, appairage) ne suffit pas. Un projet qui change de
 * DOMAINE en gardant sa base garde aussi son jeton de pont : il ne se
 * réappaire pas, `pairedAt` ne bouge pas, l'environnement non plus. La
 * génération restait donc IDENTIQUE de part et d'autre du déménagement, et
 * aucune projection reçue avant n'était considérée comme périmée.
 *
 * Constaté sur « Demo SB Auto » : projections et manifeste portaient la même
 * génération `TEST|2026-08-04T17:37:22.545Z`, alors que le projet était passé
 * de `demo-sbauto.lycarz.com` à `demo-sbauto06.ly-solution.com`.
 *
 * La DESTINATION entre donc dans la clé. Elle est lue sur la destination
 * ACTIVE — la seule autorité.
 *
 * ══ « PAS DE DESTINATION » ET « JE NE SAIS PAS » NE SONT PAS LA MÊME CHOSE ══
 *
 * Cette distinction a coûté un écran entier. L'ÉCRITURE passait l'hôte de la
 * destination active ; la LECTURE, elle, ne passait rien et retombait sur
 * `record.activeDestinationHost` — un champ que RIEN, nulle part, n'écrit. Les
 * deux côtés calculaient donc deux clés qui ne pouvaient pas coïncider :
 *
 *   estampillée à l'écriture : TEST|<appairage>|demo-sbauto06.ly-solution.com
 *   recalculée à la lecture  : TEST|<appairage>|SANS-DESTINATION
 *
 * Conséquence : TOUT projet doté d'une destination active était déclaré d'une
 * autre génération que ses propres projections. La photographie avait bien été
 * reçue, acceptée et persistée — l'écran affirmait pourtant qu'elle venait de
 * l'instance précédente, définitivement, et le contrat restait « en attente de
 * synchronisation ».
 *
 * Le paramètre n'a donc plus de valeur par défaut : ne rien passer se DIT
 * (`DESTINATION-INCONNUE`) au lieu de se faire passer pour « aucune ». Un
 * appelant qui ne peut pas savoir produit désormais une ignorance — que la
 * comparaison ci-dessous refuse de traiter comme un désaccord.
 *
 * @param {object} record
 * @param {string|null|undefined} destinationHost  hôte de la destination ACTIVE,
 *        `null` si l'on SAIT qu'il n'y en a aucune, omis si l'on ne sait pas.
 */

/** Aucune destination active — un fait, et il est stable. */
export const SANS_DESTINATION = 'SANS-DESTINATION';
/** L'appelant n'a pas pu se prononcer — une ignorance, jamais un désaccord. */
export const DESTINATION_INCONNUE = 'DESTINATION-INCONNUE';

export function currentGeneration(record, destinationHost) {
  const environment = record?.runtime?.environment ?? null;
  // À défaut d'appairage — fiche déclarée, jamais reliée — la création fait
  // office de repère : elle ne bougera plus.
  const paired = record?.pairing?.pairedAt ?? record?.createdAt ?? null;

  const connue = destinationHost !== undefined;
  const destination = connue ? (destinationHost ?? null) : null;
  const marqueur = connue ? (destination ?? SANS_DESTINATION) : DESTINATION_INCONNUE;

  return {
    environment,
    destination,
    /** L'appelant s'est-il prononcé sur la destination ? */
    destinationKnown: connue,
    generation: `${environment ?? 'INCONNU'}|${paired ?? 'JAMAIS'}|${marqueur}`,
    softwareVersion: record?.runtime?.softwareVersion ?? null,
  };
}

/**
 * Les champs à STAMPER sur une projection au moment où elle est appliquée.
 *
 * Ils disent d'où vient la photographie — pas ce qu'elle contient. C'est ce
 * qui permettra, plus tard, de dire « cette information a été synchronisée
 * depuis PROD » sans avoir à le deviner.
 */
export function stampOf(record, receivedAt, destinationHost) {
  const { environment, generation, softwareVersion } = currentGeneration(record, destinationHost);
  return {
    sourceEnvironment: environment,
    sourceGeneration: generation,
    sourceSoftwareVersion: softwareVersion,
    receivedAt,
  };
}

/**
 * Deux générations sont-elles la même ?
 *
 * Une projection sans génération est ANTÉRIEURE à cette notion : on ne la
 * déclare pas périmée pour autant — elle a été reçue avant que le Panel ne
 * sache dater les générations, et rien ne prouve qu'elle soit fausse. Elle
 * sera re-stampée à la première écriture qui la remplacera.
 */
export function sameGeneration(stocke, courante) {
  if (!stocke) return true;
  return !generationsDiverge(stocke, courante);
}

/**
 * DEUX GÉNÉRATIONS SE CONTREDISENT-ELLES ?
 *
 * ── POURQUOI PAS UNE SIMPLE INÉGALITÉ DE CHAÎNES ────────────────────────────
 * Parce qu'une clé peut contenir une case VIDE. Comparer les chaînes
 * entières fait alors passer une ignorance pour un désaccord : c'est
 * exactement ce qui a déclaré périmée, sur tout le parc, une photographie
 * parfaitement à jour.
 *
 * On compare donc case par case, et une case dont l'un des deux côtés dit
 * « je ne sais pas » ne tranche rien. Le reste continue de trancher : un
 * environnement différent, un réappairage ou un changement de domaine
 * restent des ruptures, et doivent le rester — c'est ce qui protège contre
 * l'affichage de données d'une instance disparue.
 *
 * Deux clés dont on ne connaît pas la forme retombent sur l'égalité stricte :
 * mieux vaut un doute signalé qu'une comparaison qu'on ne sait pas faire.
 */
export function generationsDiverge(stocke, courante) {
  if (!stocke || !courante) return false;

  const a = String(stocke).split('|');
  const b = String(courante).split('|');
  if (a.length !== b.length) return stocke !== courante;

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === DESTINATION_INCONNUE || b[i] === DESTINATION_INCONNUE) continue;
    if (a[i] !== b[i]) return true;
  }
  return false;
}

export default {
  currentGeneration, stampOf, sameGeneration, generationsDiverge,
  SANS_DESTINATION, DESTINATION_INCONNUE,
};
