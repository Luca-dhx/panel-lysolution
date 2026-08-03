/**
 * JOURNAL DES CORRECTIONS — commun aux réunions et aux événements.
 *
 * Tout objet reste modifiable, y compris passé et classé : on se trompe en
 * saisissant, on apprend le lendemain que le client n'était pas là, on corrige
 * un compte rendu. Interdire la correction ne rend pas l'historique plus vrai —
 * il le fige sur une erreur et pousse à créer un doublon pour dire le
 * contraire.
 *
 * Ce qui protège l'histoire, c'est la TRACE. Chaque modification consigne son
 * auteur, sa date, l'ancienne et la nouvelle valeur de CHAQUE champ touché, et
 * son motif éventuel. Rien ne s'efface, tout s'ajoute.
 */
const nowIso = () => new Date().toISOString();

/** Comparaison tolérante : une date et son ISO sont la même valeur. */
function identique(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const ta = a ? new Date(a).getTime() : null;
    const tb = b ? new Date(b).getTime() : null;
    return ta === tb;
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? null) === (b ?? null);
}

const lisible = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/**
 * Applique un correctif et consigne ce qui a VRAIMENT changé.
 *
 * Un champ réécrit à l'identique ne produit pas de ligne : un journal qui
 * enregistre les non-changements devient illisible, donc inutile.
 *
 * @returns {number} nombre de champs réellement modifiés
 */
export function applyPatch(doc, patch, { actor = {}, reason = null } = {}) {
  const changes = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const avant = doc[field];
    if (identique(avant, value)) continue;
    changes.push({ field, from: lisible(avant), to: lisible(value) });
    doc[field] = value;
  }
  if (changes.length === 0) return 0;

  doc.revisions.push({
    at: nowIso(),
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
    reason,
    changes,
  });
  doc.updatedBy = actor.email ?? null;
  return changes.length;
}

export default { applyPatch };
