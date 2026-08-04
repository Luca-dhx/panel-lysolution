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

/** La génération d'un projet, telle que le registre la connaît AUJOURD'HUI. */
export function currentGeneration(record) {
  const environment = record?.runtime?.environment ?? null;
  // À défaut d'appairage — fiche déclarée, jamais reliée — la création fait
  // office de repère : elle ne bougera plus.
  const paired = record?.pairing?.pairedAt ?? record?.createdAt ?? null;
  return {
    environment,
    generation: `${environment ?? 'INCONNU'}|${paired ?? 'JAMAIS'}`,
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
export function stampOf(record, receivedAt) {
  const { environment, generation, softwareVersion } = currentGeneration(record);
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
