/**
 * MIGRATION DES MÉDIAS PERSISTANTS entre deux emplacements d'un MÊME projet.
 *
 * ── LE CAS RÉEL ─────────────────────────────────────────────────────────────
 * Un projet change de domaine. Sa base le suit, ses médias non : ils vivent dans
 * le `shared/uploads` de l'ancienne destination, sur disque, hors dépôt. La
 * nouvelle vitrine référence des fichiers qui n'existent pas chez elle et
 * répond 404 sur chacun.
 *
 * ── LES RÈGLES, ET POURQUOI ─────────────────────────────────────────────────
 * 1. La source est FOURNIE, jamais cherchée. Ce module ne scanne pas
 *    `/var/www/*`, ne compare pas des noms de domaine, ne devine rien. Il reçoit
 *    des emplacements que l'historique du projet a enregistrés, tous porteurs de
 *    la MÊME identité déclarée que la destination. Sans cela, un jour, on
 *    copierait les photos d'un client chez un autre.
 * 2. On n'ÉCRASE JAMAIS. Un fichier déjà présent à destination reste tel quel.
 * 3. Un même chemin avec un contenu DIFFÉRENT arrête tout. Choisir à la place de
 *    l'opérateur reviendrait à détruire une version sans le dire.
 * 4. Rejouable sans effet : le second passage ne recopie rien.
 * 5. Tout est vérifié par SHA-256 APRÈS copie, sur le disque distant. Un octet
 *    manquant est une erreur, pas un avertissement.
 */
import { DeploymentError } from './errors.js';

/** Une empreinte SHA-256 en hexadécimal minuscule. */
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Protège une valeur destinée au shell distant.
 * Le guillemet simple est le seul caractère à neutraliser à l'intérieur d'une
 * chaîne entre guillemets simples.
 */
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Vérifie qu'un chemin distant est absolu, canonique et sous une racine donnée.
 *
 * Un chemin composé ailleurs (document ancien, saisie, historique) pourrait
 * contenir `..` et désigner, une fois résolu, n'importe quoi sur le serveur.
 * On refuse la forme, on ne « nettoie » pas : nettoyer masquerait l'anomalie.
 */
export function assertUploadsPath(value, { remoteRoot = '/var/www', field = 'path' } = {}) {
  const p = String(value || '');
  const racine = String(remoteRoot).replace(/\/+$/, '');
  const invalide = (raison) =>
    new DeploymentError('UNSAFE_UPLOADS_PATH', `Chemin de médias non sûr (${raison}).`, {
      step: 'uploads_migrate',
      details: { field, path: p, remoteRoot: racine },
    });

  if (!p.startsWith('/')) throw invalide('chemin relatif');
  if (p.includes('\0')) throw invalide('caractère nul');
  if (/\/\//.test(p)) throw invalide('séparateur doublé');
  if (p.split('/').includes('..')) throw invalide('remontée de répertoire');
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) throw invalide('caractère interdit');
  // Sous la racine ET distinct d'elle : jamais la racine entière.
  if (!p.startsWith(`${racine}/`) || p.length <= racine.length + 1) throw invalide('hors de la racine de déploiement');
  return p;
}

/**
 * Inventaire d'un dossier distant : chemin relatif → empreinte SHA-256.
 * Un dossier absent donne un inventaire vide — c'est le cas normal d'une
 * destination neuve, pas une erreur.
 */
export async function inventoryUploads(transport, dir) {
  const res = await transport.exec(
    `if [ -d ${q(dir)} ]; then cd ${q(dir)} && find . -type f -exec sha256sum {} + ; fi`,
  );
  const inventaire = new Map();
  for (const ligne of String(res.stdout || '').split('\n')) {
    if (!ligne.trim()) continue;
    const m = ligne.match(/^([0-9a-f]{64})\s+\.\/(.+)$/);
    if (!m) {
      // Un nom de fichier exotique (retour à la ligne, encodage) rendrait
      // l'inventaire partiel — donc les comparaisons fausses. On refuse de
      // travailler sur une vue incomplète.
      throw new DeploymentError('UPLOADS_INVENTORY_UNREADABLE', 'Inventaire des médias illisible : un nom de fichier ne peut pas être interprété.', {
        step: 'uploads_migrate',
        details: { dir, sample: ligne.slice(0, 120) },
      });
    }
    inventaire.set(m[2], m[1]);
  }
  return inventaire;
}

/**
 * Copie vers `destination` les fichiers présents dans les `sources` et absents
 * à destination. N'écrase rien, s'arrête au moindre désaccord.
 *
 * @param {object} transport
 * @param {object} args
 * @param {string} args.destination        `shared/uploads` de la destination courante.
 * @param {string} args.identityId         Identité DÉCLARÉE du projet déployé.
 * @param {Array<{host:string, sharedUploadsPath:string, projectIdentityId:string}>} args.sources
 *        Emplacements antérieurs, du plus récent au plus ancien.
 * @param {string} [args.remoteRoot]
 */
export async function migrateUploads(transport, { destination, identityId, sources = [], remoteRoot = '/var/www' }) {
  if (!identityId) {
    throw new DeploymentError('UPLOADS_MIGRATION_NO_IDENTITY', 'Migration des médias refusée : aucune identité de projet déclarée.', {
      step: 'uploads_migrate',
    });
  }
  const dst = assertUploadsPath(destination, { remoteRoot, field: 'destination' });

  // Chaque source doit porter la MÊME identité déclarée. Un écart n'est pas
  // filtré silencieusement : c'est le signe que l'appelant s'est trompé de
  // projet, et il doit l'apprendre maintenant.
  const retenues = [];
  for (const s of sources) {
    if (s.projectIdentityId !== identityId) {
      throw new DeploymentError('UPLOADS_MIGRATION_IDENTITY_MISMATCH', 'Migration des médias refusée : une source appartient à un autre projet.', {
        step: 'uploads_migrate',
        details: { expected: identityId, found: s.projectIdentityId || null, host: s.host || null },
      });
    }
    const chemin = assertUploadsPath(s.sharedUploadsPath, { remoteRoot, field: 'source' });
    if (chemin === dst) continue; // la destination elle-même : rien à migrer
    retenues.push({ ...s, sharedUploadsPath: chemin });
  }

  if (!retenues.length) {
    return { migrated: 0, alreadyPresent: 0, sources: [], reason: 'aucun emplacement antérieur pour ce projet' };
  }

  const aDestination = await inventoryUploads(transport, dst);

  /** Ce que la migration doit produire : chemin relatif → { hash, source }. */
  const aCopier = new Map();
  let dejaPresents = 0;
  const parSource = [];

  for (const src of retenues) {
    const inventaire = await inventoryUploads(transport, src.sharedUploadsPath);
    let copiesSource = 0;
    let identiques = 0;

    for (const [rel, hash] of inventaire) {
      if (!SHA256.test(hash)) {
        throw new DeploymentError('UPLOADS_INVENTORY_UNREADABLE', 'Empreinte de média invalide dans l’inventaire source.', {
          step: 'uploads_migrate', details: { source: src.sharedUploadsPath, file: rel },
        });
      }

      const existant = aDestination.get(rel) ?? aCopier.get(rel)?.hash ?? null;
      if (existant !== null) {
        if (existant === hash) { identiques += 1; dejaPresents += 1; continue; }
        // MÊME NOM, CONTENU DIFFÉRENT. Recopier détruirait une version ;
        // ignorer laisserait un média faux en ligne. Seul un humain peut
        // trancher, et il lui faut les deux empreintes pour le faire.
        throw new DeploymentError('UPLOADS_MIGRATION_CONFLICT', `Conflit de contenu sur « ${rel} » : le fichier existe déjà avec une empreinte différente.`, {
          step: 'uploads_migrate',
          details: {
            file: rel,
            source: src.sharedUploadsPath,
            sourceHash: hash,
            destination: dst,
            destinationHash: existant,
          },
        });
      }
      aCopier.set(rel, { hash, from: src.sharedUploadsPath });
      copiesSource += 1;
    }

    parSource.push({
      host: src.host || null,
      path: src.sharedUploadsPath,
      files: inventaire.size,
      toCopy: copiesSource,
      alreadyPresent: identiques,
    });
  }

  if (!aCopier.size) {
    return { migrated: 0, alreadyPresent: dejaPresents, sources: parSource, idempotent: true };
  }

  // COPIE — `cp -n` ne remplace jamais un fichier existant. Même si un fichier
  // apparaissait à destination entre l'inventaire et ici, il serait préservé.
  for (const [rel, { from }] of aCopier) {
    const source = `${from}/${rel}`;
    const cible = `${dst}/${rel}`;
    const r = await transport.exec(
      `mkdir -p ${q(dirname(cible))} && cp -n --preserve=timestamps -- ${q(source)} ${q(cible)}`,
    );
    if (r.code !== 0) {
      throw new DeploymentError('UPLOADS_MIGRATION_COPY_FAILED', `Échec de copie du média « ${rel} ».`, {
        step: 'uploads_migrate', details: { file: rel, from, to: dst, stderr: String(r.stderr || '').slice(0, 300) },
      });
    }
  }

  // PREUVE — on relit le disque distant. Ce qui compte n'est pas que la commande
  // ait rendu 0, c'est que le fichier soit là, avec le bon contenu.
  const apres = await inventoryUploads(transport, dst);
  const manquants = [];
  const divergents = [];
  for (const [rel, { hash }] of aCopier) {
    const obtenu = apres.get(rel);
    if (!obtenu) manquants.push(rel);
    else if (obtenu !== hash) divergents.push(rel);
  }
  if (manquants.length || divergents.length) {
    throw new DeploymentError('UPLOADS_MIGRATION_VERIFY_FAILED', 'Migration des médias incomplète : le contrôle d’empreinte après copie a échoué.', {
      step: 'uploads_migrate',
      details: { missing: manquants.slice(0, 10), mismatched: divergents.slice(0, 10), expected: aCopier.size },
    });
  }

  return {
    migrated: aCopier.size,
    alreadyPresent: dejaPresents,
    sources: parSource,
    verified: true,
  };
}

/** Répertoire parent d'un chemin POSIX (les chemins distants sont toujours POSIX). */
function dirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export default { migrateUploads, inventoryUploads, assertUploadsPath };
