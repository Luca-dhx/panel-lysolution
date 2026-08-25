// LE REGISTRE DES DONNÉES INSERTIBLES DANS UN DOCUMENT LÉGAL — code-first.
//
// ══ POURQUOI UN REGISTRE, ET PAS UN REMPLACEMENT DE CHAÎNES ═════════════════
//
// Un éditeur qui accepte n'importe quel `{{...}}` accepte trois choses qu'on ne
// veut pas :
//
//   · une CLÉ INEXISTANTE — `{{company.siret}}` au lieu de `{{client.siret}}` —
//     qui ne se voit qu'une fois la page publiée, sous la forme d'un trou ou
//     d'un `undefined` sur les mentions légales d'un client ;
//   · un CHEMIN ARBITRAIRE dans l'objet résolu, c'est-à-dire une porte ouverte
//     sur tout ce que le résolveur a sous la main — notes internes de gestion,
//     documents administratifs, identifiants techniques ;
//   · une VARIABLE SANS AUTORITÉ : personne ne saurait dire d'où vient la
//     valeur, ni qui doit la corriger quand elle est fausse.
//
// Ici, l'ensemble des clés valides est FERMÉ et vit dans ce fichier. Une clé
// absente d'ici n'existe pas : l'éditeur la refuse à l'enregistrement, le
// résolveur ne la connaît pas, et aucun document ne peut la contenir.
//
// ══ TROIS AUTORITÉS, ET ELLES NE SE MÉLANGENT JAMAIS ════════════════════════
//
//   client      L'ENTREPRISE ÉDITRICE du site — `PanelClientCompany`, rattachée
//               au projet par `PanelProject.clientCompanyId`. NOMINATIVE : la
//               résolution part TOUJOURS du projet, jamais d'une recherche par
//               nom, et deux projets ne partagent une valeur que s'ils
//               partagent l'entreprise.
//
//   developer   L.Y SOLUTION — `PanelCompany`, le tenant. Diffusée à tout le
//               parc : elle s'affiche déjà en pied de chaque site.
//
//   host        L'HÉBERGEUR — `PanelHostCompany`. Ni le client ni nous : un
//               tiers dont l'identité est une donnée d'exploitation.
//
// Les confondre a un coût immédiat et vérifiable : afficher le SIRET de
// L.Y Solution comme celui du client, ou l'adresse d'un client sur le site
// d'un autre. `resolveLegalContext()` construit les trois depuis trois
// autorités DISTINCTES et EXPLICITES, et ce registre est ce qui rend cette
// séparation lisible dans l'éditeur — chaque variable annonce sa source.
//
// ══ CE QU'UNE VARIABLE N'EST JAMAIS ════════════════════════════════════════
//
// Un morceau de HTML, un lien, un fragment de code. Une valeur résolue est du
// TEXTE, rendu comme du texte. Le document publié ne contient aucune balise :
// la vitrine reçoit des sections, des paragraphes et des listes déjà résolus,
// et n'a rien à interpréter. C'est ce qui rend l'injection impossible par
// construction plutôt que par filtrage.

/** Les catégories de la palette « + Insérer une donnée ». */
export const VARIABLE_SOURCES = Object.freeze({
  CLIENT: 'CLIENT',
  DEVELOPER: 'DEVELOPER',
  HOST: 'HOST',
});

export const VARIABLE_SOURCE_LABELS = Object.freeze({
  CLIENT: 'Entreprise cliente',
  DEVELOPER: 'Concepteur du site',
  HOST: 'Hébergeur',
});

/**
 * LES TYPES — ils décrivent ce qu'on ATTEND, pas ce qu'on affiche.
 *
 * Ils servent à l'écran (icône, aide à la saisie) et au contrôle de complétude.
 * Aucun n'est mis en forme au rendu : une valeur reste la chaîne saisie par
 * l'opérateur. Reformater un SIRET ou un téléphone au rendu ferait diverger la
 * page publique de la fiche, et rendrait indécidable laquelle fait foi.
 */
export const VARIABLE_TYPES = Object.freeze({
  TEXT: 'TEXT',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  URL: 'URL',
  ADDRESS: 'ADDRESS',
  IDENTIFIER: 'IDENTIFIER',
});

/**
 * LE CATALOGUE.
 *
 * `required` ne signifie PAS « la résolution échoue sans elle ». Il signifie
 * « son absence est une ANOMALIE À CORRIGER, et le Panel doit le dire ». Un
 * document dont une variable obligatoire manque est publié quand même — les
 * blocs concernés sont retirés (voir `legalDocumentResolver.js`) — parce
 * qu'une page de mentions légales incomplète vaut mieux qu'une page vide, et
 * que refuser la publication punirait le visiteur d'une saisie manquante.
 * L'écran, lui, l'affiche en avertissement, avec le chemin pour la corriger.
 *
 * `optional` (au sens de `required: false`) recouvre deux cas bien distincts,
 * et c'est voulu :
 *
 *   · la donnée EXISTE mais n'est pas encore saisie ;
 *   · la donnée N'EXISTE PAS pour cette forme juridique — capital social et
 *     RCS d'un entrepreneur individuel. Forcer la mention produirait
 *     « Capital social : N/A » sur la page publique d'un EI, ce qui est faux
 *     et ridicule. Le bloc disparaît, et rien n'en tient lieu.
 */
const DEFINITIONS = [
  /* ── ENTREPRISE CLIENTE — l'éditeur du site ─────────────────────────── */
  {
    key: 'client.tradeName',
    label: 'Nom commercial',
    description: "L'enseigne sous laquelle le client est connu du public.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.TEXT,
    required: true,
  },
  {
    key: 'client.legalName',
    label: 'Raison sociale',
    description:
      "La dénomination au registre. Pour un entrepreneur individuel, c'est le nom civil de l'entrepreneur.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.TEXT,
    required: true,
  },
  {
    key: 'client.legalForm',
    label: 'Forme juridique',
    description: 'SAS, SARL, EURL, entrepreneur individuel…',
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.TEXT,
    required: true,
  },
  {
    key: 'client.siren',
    label: 'SIREN',
    description: "9 chiffres — l'identifiant durable de la personne morale.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.IDENTIFIER,
    required: true,
  },
  {
    key: 'client.siret',
    label: 'SIRET',
    description: "14 chiffres — l'établissement. Change en cas de déménagement.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.IDENTIFIER,
    required: false,
  },
  {
    key: 'client.vatNumber',
    label: 'TVA intracommunautaire',
    description:
      "Absente lorsque l'entreprise relève de la franchise en base : le bloc disparaît alors.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.IDENTIFIER,
    required: false,
  },
  {
    key: 'client.registrationCity',
    label: "Ville d'immatriculation (RCS)",
    description: "Sans objet pour un entrepreneur individuel non commerçant.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.TEXT,
    required: false,
  },
  {
    key: 'client.shareCapital',
    label: 'Capital social',
    description: "Sans objet pour un entrepreneur individuel : le bloc disparaît.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.TEXT,
    required: false,
  },
  {
    key: 'client.address',
    label: 'Adresse du siège',
    description: "Le siège social tel qu'il figure au registre, sur une ligne.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.ADDRESS,
    required: true,
  },
  {
    key: 'client.email',
    label: 'Adresse e-mail',
    description: 'Le contact que le visiteur peut écrire.',
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.EMAIL,
    required: false,
  },
  {
    key: 'client.phone',
    label: 'Téléphone',
    description: 'Le numéro publié au public.',
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.PHONE,
    required: false,
  },
  {
    key: 'client.publicationDirector',
    label: 'Directeur de la publication',
    description:
      "La personne physique responsable du contenu. À défaut de saisie, c'est le représentant légal.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.TEXT,
    required: true,
  },
  {
    key: 'client.websiteUrl',
    label: 'Adresse du site',
    description: "L'adresse publique du site édité.",
    source: VARIABLE_SOURCES.CLIENT,
    type: VARIABLE_TYPES.URL,
    required: false,
  },

  /* ── CONCEPTEUR — L.Y Solution ──────────────────────────────────────── */
  {
    key: 'developer.name',
    label: 'Nom',
    description: "Le nom sous lequel nous concevons les sites.",
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.TEXT,
    required: true,
  },
  {
    key: 'developer.legalName',
    label: 'Raison sociale',
    description: "La dénomination au registre, si elle diffère du nom d'usage.",
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.TEXT,
    required: false,
  },
  {
    key: 'developer.legalForm',
    label: 'Forme juridique',
    description: 'Renseignée dans « Mon entreprise ».',
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.TEXT,
    required: false,
  },
  {
    key: 'developer.siren',
    label: 'SIREN',
    description: 'Renseigné dans « Mon entreprise ».',
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.IDENTIFIER,
    required: false,
  },
  {
    key: 'developer.siret',
    label: 'SIRET',
    description: 'Renseigné dans « Mon entreprise ».',
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.IDENTIFIER,
    required: false,
  },
  {
    key: 'developer.vatNumber',
    label: 'TVA intracommunautaire',
    description: 'Renseignée dans « Mon entreprise ».',
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.IDENTIFIER,
    required: false,
  },
  {
    key: 'developer.address',
    label: 'Adresse',
    description: "L'adresse de contact renseignée dans « Mon entreprise ».",
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.ADDRESS,
    required: false,
  },
  {
    key: 'developer.email',
    label: 'Adresse e-mail',
    description: "Le contact public — jamais l'expéditeur technique du parc.",
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.EMAIL,
    required: false,
  },
  {
    key: 'developer.website',
    label: 'Site web',
    description: 'Notre adresse publique.',
    source: VARIABLE_SOURCES.DEVELOPER,
    type: VARIABLE_TYPES.URL,
    required: false,
  },

  /* ── HÉBERGEUR ──────────────────────────────────────────────────────── */
  {
    key: 'host.legalName',
    label: 'Raison sociale',
    description: "La dénomination exacte de l'hébergeur.",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.TEXT,
    required: true,
  },
  {
    key: 'host.legalForm',
    label: 'Forme juridique',
    description: "Private limited company, SAS, UAB…",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.TEXT,
    required: false,
  },
  {
    key: 'host.registrationNumber',
    label: "Numéro d'immatriculation",
    description: "L'identifiant au registre du pays de l'hébergeur.",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.IDENTIFIER,
    required: false,
  },
  {
    key: 'host.address',
    label: 'Adresse',
    description: "Le siège de l'hébergeur, sur une ligne.",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.ADDRESS,
    required: true,
  },
  {
    key: 'host.country',
    label: 'Pays',
    description: "Le pays du siège de l'hébergeur.",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.TEXT,
    required: false,
  },
  {
    key: 'host.email',
    label: 'Adresse e-mail',
    description: "Le contact publié par l'hébergeur.",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.EMAIL,
    required: false,
  },
  {
    key: 'host.phone',
    label: 'Téléphone',
    description: "Le numéro publié par l'hébergeur.",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.PHONE,
    required: false,
  },
  {
    key: 'host.website',
    label: 'Site web',
    description: "L'adresse publique de l'hébergeur.",
    source: VARIABLE_SOURCES.HOST,
    type: VARIABLE_TYPES.URL,
    required: false,
  },
];

export const LEGAL_VARIABLES = Object.freeze(
  DEFINITIONS.map((definition) => Object.freeze({ ...definition })),
);

const BY_KEY = new Map(LEGAL_VARIABLES.map((v) => [v.key, v]));

/** La clé existe-t-elle au registre ? Seule autorité sur cette question. */
export function isKnownVariable(key) {
  return BY_KEY.has(key);
}

export function getVariable(key) {
  return BY_KEY.get(key) ?? null;
}

/** Toutes les clés, pour les gardes et les messages d'erreur. */
export function variableKeys() {
  return LEGAL_VARIABLES.map((v) => v.key);
}

/**
 * LA SYNTAXE — `{{ cle }}`, et rien d'autre.
 *
 * Volontairement pauvre : ni filtres, ni conditions, ni boucles, ni appels.
 * Un langage de gabarit expressif dans un éditeur web est une surface
 * d'exécution ; celui-ci ne sait faire qu'UNE chose — nommer une valeur du
 * registre — et ne peut donc rien faire d'autre.
 *
 * La conditionnalité dont les mentions légales ont besoin (« pas de capital
 * social sur un EI ») n'est pas exprimée par une syntaxe : elle découle de la
 * RÉSOLUTION — un bloc dont une variable manque est retiré. C'est moins
 * puissant, et c'est exactement ce qu'il faut : personne n'écrit de logique
 * dans un document juridique.
 */
export const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

/** Les clés référencées par un texte, dans l'ordre, sans doublon. */
export function referencedKeys(text) {
  const found = [];
  const source = String(text ?? '');
  VARIABLE_PATTERN.lastIndex = 0;
  let match = VARIABLE_PATTERN.exec(source);
  while (match) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = VARIABLE_PATTERN.exec(source);
  }
  return found;
}

/**
 * Les `{{…}}` qui RESSEMBLENT à une variable sans en être une.
 *
 * `referencedKeys` ne retient que ce qui satisfait la syntaxe ; une faute de
 * frappe comme `{{client.siret` ou `{{ client siret }}` passerait donc à
 * travers et finirait telle quelle sur la page publique. Ce balayage-là est
 * DÉLIBÉRÉMENT plus large : il attrape toute ouverture `{{`, et le validateur
 * refuse celles qui ne se résolvent pas en clé connue.
 */
const OPENING_PATTERN = /\{\{/g;

/**
 * Le contrôle part de CHAQUE `{{` et exige qu'une variable VALIDE commence
 * exactement là.
 *
 * ── POURQUOI PAS UNE EXPRESSION « LARGE » ───────────────────────────────────
 *
 * La première version cherchait `\{\{([^}]*)\}?\}?` : sur `{{client.siret` —
 * une accolade fermante oubliée en fin de ligne — elle capturait
 * `client.siret`, une clé parfaitement connue, et ne signalait donc RIEN. La
 * chaîne `{{client.siret` serait partie telle quelle sur la page publique.
 *
 * En partant de l'ouverture, la question devient : « ce `{{` est-il le début
 * d'une variable complète et connue ? ». Un oubli de fermeture y répond non,
 * et une clé inconnue aussi.
 */
export function suspiciousTokens(text) {
  const source = String(text ?? '');
  const bad = [];

  OPENING_PATTERN.lastIndex = 0;
  let opening = OPENING_PATTERN.exec(source);
  while (opening) {
    // Une variable valide DOIT commencer à cet index précis.
    VARIABLE_PATTERN.lastIndex = opening.index;
    const candidate = VARIABLE_PATTERN.exec(source);
    const valide = candidate
      && candidate.index === opening.index
      && isKnownVariable(candidate[1]);

    if (!valide) {
      // On rend un extrait BORNÉ : le texte fautif peut être un paragraphe
      // entier, et un message d'erreur ne doit pas le recopier.
      bad.push(source.slice(opening.index, opening.index + 40));
    }
    opening = OPENING_PATTERN.exec(source);
  }
  return bad;
}

export default {
  LEGAL_VARIABLES,
  VARIABLE_SOURCES,
  VARIABLE_SOURCE_LABELS,
  VARIABLE_TYPES,
  isKnownVariable,
  getVariable,
  variableKeys,
  referencedKeys,
  suspiciousTokens,
};
