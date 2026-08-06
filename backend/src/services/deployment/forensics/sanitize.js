/**
 * NETTOYAGE DES TRACES — un journal qui fuit est pire que pas de journal.
 *
 * ══ POURQUOI UN SEUL ENDROIT ════════════════════════════════════════════════
 *
 * Le journal forensique enregistre des corps de requête, des en-têtes, des
 * messages d'erreur et des piles d'appel. Chacun de ces canaux peut porter un
 * secret : le mot de passe SSH voyage dans le corps d'un POST, le jeton de
 * pont dans un en-tête, une URI Mongo dans un message d'exception.
 *
 * Nettoyer « à l'endroit où l'on écrit » garantit qu'on oubliera un endroit.
 * Tout ce qui entre dans le journal passe donc par ici, et par rien d'autre.
 *
 * ══ CE QUI NE DOIT JAMAIS ÊTRE ÉCRIT ════════════════════════════════════════
 *
 * Mot de passe SSH, jeton JWT, jeton de pont, clés d'API, en-têtes
 * d'autorisation, URI de base de données. La liste est déclarée par NOM DE
 * CHAMP et par MOTIF : un secret arrive parfois sous un nom qu'on n'a pas
 * prévu, mais rarement sous une forme qu'on ne reconnaît pas.
 */

/** Ce qui est effacé sur le NOM du champ, quelle que soit sa valeur. */
const CHAMPS_SECRETS = [
  'password', 'sshpassword', 'motdepasse', 'pass', 'secret',
  'token', 'bridgetoken', 'accesstoken', 'refreshtoken', 'jwt',
  'authorization', 'cookie', 'setcookie',
  'apikey', 'api_key', 'privatekey', 'clientsecret',
  'mongodburi', 'mongo_uri', 'databaseurl', 'connectionstring',
  'jwtsecret', 'encryptionkey',
];

/** Ce qui est effacé sur la FORME de la valeur, même sous un nom anodin. */
const MOTIFS_SECRETS = [
  // URI Mongo avec identifiants.
  [/mongodb(\+srv)?:\/\/[^\s"']*/gi, 'mongodb://«masqué»'],
  // Jeton porteur.
  [/Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer «masqué»'],
  // JWT nu (trois segments base64url).
  [/\beyJ[A-Za-z0-9._-]{20,}\b/g, '«jwt masqué»'],
  // Clés de prestataires courantes.
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/gi, '«clé masquée»'],
  // Bloc de clé privée.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«clé privée masquée»'],
];

const MASQUE = '«masqué»';

const estSecret = (cle) => {
  const nu = String(cle).toLowerCase().replace(/[^a-z0-9]/g, '');
  return CHAMPS_SECRETS.some((s) => nu.includes(s.replace(/[^a-z0-9]/g, '')));
};

/** Masque les motifs sensibles dans une chaîne — messages, piles, URLs. */
export function sanitizeText(valeur) {
  let texte = String(valeur ?? '');
  for (const [motif, remplacement] of MOTIFS_SECRETS) texte = texte.replace(motif, remplacement);
  return texte;
}

/**
 * Rend une valeur SÛRE et SÉRIALISABLE.
 *
 * Trois contraintes tenues ensemble :
 *   · aucun secret — par nom de champ et par motif ;
 *   · aucune référence circulaire — le journal part en base ;
 *   · aucune taille déraisonnable — un run ne doit pas devenir un dépotoir.
 */
export function sanitizeValue(valeur, { profondeur = 0, maxProfondeur = 6, maxChaine = 4000 } = {}) {
  if (valeur === null || valeur === undefined) return null;
  if (profondeur > maxProfondeur) return '«profondeur maximale atteinte»';

  const type = typeof valeur;
  if (type === 'string') {
    const propre = sanitizeText(valeur);
    return propre.length > maxChaine ? `${propre.slice(0, maxChaine)}… (${propre.length} car.)` : propre;
  }
  if (type === 'number' || type === 'boolean') return valeur;
  if (type === 'function' || type === 'symbol') return `«${type}»`;
  if (valeur instanceof Date) return valeur.toISOString();
  if (valeur instanceof Error) {
    return {
      name: valeur.name,
      message: sanitizeText(valeur.message),
      code: valeur.code ?? null,
      stack: sanitizeText(valeur.stack ?? ''),
    };
  }
  if (Array.isArray(valeur)) {
    // Un tableau très long dirait la même chose en dix fois plus de place.
    const borne = valeur.slice(0, 50);
    const rendu = borne.map((v) => sanitizeValue(v, { profondeur: profondeur + 1, maxProfondeur, maxChaine }));
    if (valeur.length > borne.length) rendu.push(`… ${valeur.length - borne.length} entrée(s) de plus`);
    return rendu;
  }
  if (type === 'object') {
    const sortie = {};
    for (const [cle, v] of Object.entries(valeur)) {
      sortie[cle] = estSecret(cle)
        ? MASQUE
        : sanitizeValue(v, { profondeur: profondeur + 1, maxProfondeur, maxChaine });
    }
    return sortie;
  }
  return String(valeur);
}

/**
 * En-têtes HTTP réduits à ce qui SERT AU DIAGNOSTIC.
 *
 * On liste ce qu'on garde plutôt que ce qu'on retire : une liste de refus
 * laisse passer tout ce qu'on n'a pas anticipé, et `authorization` finit un
 * jour par arriver sous un autre nom.
 */
const ENTETES_CONSERVES = [
  'content-type', 'content-length', 'user-agent', 'accept',
  'x-request-id', 'x-forwarded-for', 'referer', 'origin', 'connection',
];

export function sanitizeHeaders(headers = {}) {
  const sortie = {};
  for (const nom of ENTETES_CONSERVES) {
    const v = headers[nom] ?? headers[nom.toLowerCase()];
    if (v !== undefined) sortie[nom] = sanitizeText(v);
  }
  return sortie;
}

export default { sanitizeValue, sanitizeText, sanitizeHeaders };
