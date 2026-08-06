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
 * ACTIVE — la seule autorité — et vaut `SANS-DESTINATION` tant qu'aucune n'est
 * connue : une valeur stable, qui ne fabrique pas de fausse rupture.
 *
 * @param {object} record
 * @param {string|null} [destinationHost]  hôte de la destination ACTIVE.
 */
export function currentGeneration(record, destinationHost = null) {
  const environment = record?.runtime?.environment ?? null;
  // À défaut d'appairage — fiche déclarée, jamais reliée — la création fait
  // office de repère : elle ne bougera plus.
  const paired = record?.pairing?.pairedAt ?? record?.createdAt ?? null;
  const destination = destinationHost ?? record?.activeDestinationHost ?? null;
  return {
    environment,
    destination,
    generation: `${environment ?? 'INCONNU'}|${paired ?? 'JAMAIS'}|${destination ?? 'SANS-DESTINATION'}`,
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
export function stampOf(record, receivedAt, destinationHost = null) {
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
  return stocke === courante;
}

export default { currentGeneration, stampOf, sameGeneration };
