// OÙ L'ANCIEN FOURNISSEUR SUBSISTE — la matrice, classée, sans indulgence.
//
// Campagne de migration Yousign → OpenSign, lot 8.
//
//   node tools/opensign/inventaireYousign.mjs [--json]
//
// ══ POURQUOI UN OUTIL PLUTÔT QU'UN `grep` ═══════════════════════════════════
//
// « Il ne reste plus de Yousign » est une phrase qu'on écrit facilement et
// qu'on vérifie mal. Un `grep` rend 300 lignes indistinctes : le nom dans un
// commentaire qui EXPLIQUE la bascule y côtoie l'appel qui la contredit.
//
// Ce qui compte n'est pas le nombre d'occurrences, c'est leur NATURE. Cet outil
// les classe, et la seule catégorie qui doit être vide est celle qui exécute.
//
//   ACTIVE_RUNTIME    du code qui APPELLE le fournisseur, ou lit sa credential.
//                     Doit être vide à la fin du lot 8.
//   HISTORICAL_COMPAT du code qui sait LIRE ce qui a été écrit avant la
//                     bascule. Doit rester : les contrats de 2025 existent.
//   TEST              une suite qui éprouve l'un ou l'autre. Légitime.
//   DOC               un commentaire, un document. Légitime, et précieux : il
//                     dit POURQUOI un champ porte encore ce nom.
//   DEAD              plus aucun appelant. À supprimer.
//
// ══ CE QUE L'OUTIL NE FAIT PAS ══════════════════════════════════════════════
//
// Il ne classe pas tout seul ce qu'il ne sait pas décider. Un fichier qu'aucune
// règle ne reconnaît sort en `À CLASSER` — et c'est un résultat, pas un échec :
// mieux vaut une ligne à regarder qu'un classement inventé.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JSON_SEUL = process.argv.includes('--json');
const journal = (...a) => { if (!JSON_SEUL) console.log(...a); };

const RACINE = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const DEPOTS = [
  { nom: 'Panel', racines: ['Panel/backend/src', 'Panel/frontend/src', 'Panel/tests', 'Panel/tools', 'Panel/docs'] },
  { nom: 'SB Auto', racines: ['SB Auto 06/backend/src', 'SB Auto 06/manager/src', 'SB Auto 06/docs'] },
];

const MOTIF = /yousign/i;

/** Les fichiers d'un dossier, en profondeur, hors dépendances et artefacts. */
function fichiers(racine) {
  const trouves = [];
  const parcourir = (dossier) => {
    let entrees;
    try { entrees = readdirSync(dossier); } catch { return; }
    for (const nom of entrees) {
      if (['node_modules', '.git', 'dist', 'build', 'coverage', '.campaign', 'test-results'].includes(nom)) continue;
      const complet = path.join(dossier, nom);
      let s;
      try { s = statSync(complet); } catch { continue; }
      if (s.isDirectory()) parcourir(complet);
      else if (/\.(js|mjs|cjs|ts|tsx|md|json)$/.test(nom)) trouves.push(complet);
    }
  };
  parcourir(racine);
  return trouves;
}

/**
 * Le code, débarrassé de ses commentaires.
 *
 * C'est LA distinction qui rend l'inventaire utile : un nom dans un
 * commentaire explique l'histoire — le retirer coûterait la mémoire de ce qui
 * s'est passé. Un nom dans le code, lui, fait quelque chose.
 */
const sansCommentaires = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*\*.*$/gm, '');

/**
 * Les gestes qui parlent RÉELLEMENT au fournisseur, ou lisent sa clé.
 *
 * On ne cherche pas le mot : on cherche l'ACTE. `yousignFetch(`, un import de
 * son transport, une lecture de credential nommée. C'est ce qui distingue « ce
 * fichier mentionne Yousign » de « ce fichier appelle Yousign ».
 */
const GESTES_ACTIFS = [
  /yousignFetch\s*\(/i,
  /from\s+['"][^'"]*yousignTransport\.js['"]/i,
  /getCredential\(\s*['"]YOUSIGN/i,
  /tryGetCredential\(\s*['"]YOUSIGN/i,
  /api\.yousign\.com|yousign\.app/i,
];

/**
 * Les gestes qui LISENT l'héritage sans rien appeler.
 *
 * Chacun a été ajouté après avoir REGARDÉ le fichier qu'il décrit — jamais
 * pour vider la colonne « à classer ». Élargir un motif jusqu'à ce que tout
 * passe transformerait cet inventaire en tampon, c'est-à-dire en son
 * contraire.
 */
const GESTES_HISTORIQUES = [
  /LEGACY_SIGNATURE_PROVIDER/,
  /RETIRED_SIGNATURE_(ADAPTERS|PROVIDER)/,
  /STORABLE_PROVIDER_VALUES|LEGACY_PROVIDER_VALUES/,
  /'YOUSIGN'/,
  /"YOUSIGN"/,
  /\.yousign\b/,
  /** Une CLÉ de table indexée par fournisseur : `YOUSIGN: …`. */
  /\bYOUSIGN\s*:/,
  /** Le champ hérité d'un document Mongo : `yousign: { … }`. */
  /\byousign\s*:/,
  /** Un chemin Mongo ou un champ surveillé : `'yousign.signatureRequestId'`. */
  /['"]yousign[.'"]/,
];

function classer(chemin, source) {
  const rel = path.relative(RACINE, chemin).replace(/\\/g, '/');
  const code = sansCommentaires(source);
  const dansLeCode = MOTIF.test(code);

  if (/\.md$/.test(rel)) return { rel, classe: 'DOC', motif: 'document' };
  if (!dansLeCode) return { rel, classe: 'DOC', motif: 'commentaire seulement' };
  if (/\.test\.(js|mjs|ts|tsx)$|\/tests\/|\/scripts\/.*\.test\./.test(rel)) {
    return { rel, classe: 'TEST', motif: 'suite de contrôle' };
  }
  if (/\/tools\//.test(rel)) return { rel, classe: 'TEST', motif: 'outillage de campagne' };

  const actif = GESTES_ACTIFS.find((g) => g.test(code));
  if (actif) return { rel, classe: 'ACTIVE_RUNTIME', motif: `geste : ${actif.source.slice(0, 40)}` };

  const historique = GESTES_HISTORIQUES.find((g) => g.test(code));
  if (historique) return { rel, classe: 'HISTORICAL_COMPAT', motif: `lecture : ${historique.source.slice(0, 40)}` };

  return { rel, classe: 'À CLASSER', motif: 'le nom apparaît dans le code, sans geste reconnu' };
}

const resultats = [];
for (const depot of DEPOTS) {
  for (const racineRelative of depot.racines) {
    const racine = path.join(RACINE, racineRelative);
    for (const fichier of fichiers(racine)) {
      let source;
      try { source = readFileSync(fichier, 'utf8'); } catch { continue; }
      if (!MOTIF.test(source)) continue;
      resultats.push({ depot: depot.nom, ...classer(fichier, source) });
    }
  }
}

const parClasse = {};
for (const r of resultats) (parClasse[r.classe] ??= []).push(r);

const ORDRE = ['ACTIVE_RUNTIME', 'À CLASSER', 'DEAD', 'HISTORICAL_COMPAT', 'TEST', 'DOC'];
journal('\n=== OÙ L’ANCIEN FOURNISSEUR SUBSISTE ===\n');
for (const classe of ORDRE) {
  const lignes = parClasse[classe] ?? [];
  journal(`── ${classe} : ${lignes.length}`);
  for (const l of lignes) journal(`     ${l.depot.padEnd(8)} ${l.rel}${classe === 'ACTIVE_RUNTIME' || classe === 'À CLASSER' ? `  (${l.motif})` : ''}`);
  journal('');
}

const bloquants = (parClasse.ACTIVE_RUNTIME ?? []).length + (parClasse['À CLASSER'] ?? []).length
  + (parClasse.DEAD ?? []).length;
journal(bloquants === 0
  ? '✓ AUCUN chemin d’exécution ne subsiste — il ne reste que de la lecture, des tests et de la mémoire.'
  : `✗ ${bloquants} fichier(s) à traiter avant de déclarer le retrait fait.`);

const DOSSIER = path.resolve(fileURLToPath(new URL('../../.campaign/', import.meta.url)));
mkdirSync(DOSSIER, { recursive: true });
const artefact = path.join(DOSSIER, 'inventaire-yousign.json');
writeFileSync(artefact, JSON.stringify({
  total: resultats.length,
  parClasse: Object.fromEntries(ORDRE.map((c) => [c, (parClasse[c] ?? []).map((l) => l.rel)])),
  bloquants,
}, null, 1), 'utf8');
if (JSON_SEUL) console.log(readFileSync(artefact, 'utf8'));
else journal(`\nartefact : ${artefact}`);

process.exit(bloquants === 0 ? 0 : 1);
