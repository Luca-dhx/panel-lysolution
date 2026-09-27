/**
 * LA CLÉ ANNONCÉE PAR UN PROJET CORRESPOND-ELLE À SA FICHE ?
 *
 * Un projet annonce toujours la clé dérivée de son nom (`beautysavage`). Quand
 * il existe DEUX fiches pour le même projet — sa recette et sa production —,
 * la seconde est enregistrée sous la clé QUALIFIÉE par son environnement
 * déclaré (`beautysavage-prod`, voir `projectRegistry.service.js`), parce que
 * l'index des clés est unique.
 *
 * Sans cette règle, l'instance de production ne pouvait JAMAIS s'appairer :
 * sa clé nue était détenue par la fiche de recette (refus « Un autre projet du
 * registre porte déjà cette clé »), et son Manifest était jugé incohérent.
 *
 * On accepte donc, en plus de l'égalité stricte, UNE seule forme : la clé nue
 * suivie de l'environnement DÉCLARÉ de la fiche. Une production ne peut pas
 * s'approprier une fiche de recette (l'environnement est épinglé et vérifié à
 * l'appairage), et aucune autre clé n'est admise.
 */
export function isQualifiedSisterKey(announcedKey, record) {
  const announced = String(announcedKey || '').trim();
  const env = String(record?.declaredEnvironment || '').trim().toLowerCase();
  if (!announced || !env) return false;
  return record?.projectKey === `${announced}-${env}`;
}

export function projectKeyMatches(announcedKey, record) {
  return announcedKey === record?.projectKey || isQualifiedSisterKey(announcedKey, record);
}
