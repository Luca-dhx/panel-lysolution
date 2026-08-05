import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../../config/env.js';
import { resolveBackendUrl } from '../network/networkConfig.service.js';

/**
 * MÉDIAS DU PANEL — le logo de l'entreprise, et rien d'autre pour l'instant.
 *
 * ── POURQUOI LE PANEL HÉBERGE MAINTENANT DES FICHIERS ───────────────────────
 * Le Panel est l'autorité de l'identité développeur, mais il n'avait aucun
 * stockage : le logo se saisissait en collant une URL, là où le Manager
 * proposait un import. Une différence d'expérience née d'une limite technique,
 * pas d'un choix — et c'est le Panel qui devait s'aligner, pas l'inverse.
 *
 * ── LE CHEMIN STOCKÉ EST RELATIF, L'URL PUBLIÉE EST ABSOLUE ─────────────────
 * On stocke `/uploads/<fichier>` : un changement de domaine ne casse alors
 * aucune fiche. Mais ce logo est affiché par les PROJETS, sur d'autres
 * origines : un chemin relatif y pointerait sur le site du client. La
 * résolution en URL absolue se fait donc au moment de publier
 * (`resolvePublicMediaUrl`), à partir de l'adresse publique du Panel.
 */
export const UPLOADS_PUBLIC_PREFIX = '/uploads';

/** Dossier de stockage — créé à la demande, jamais supposé présent. */
export function uploadsDir() {
  return config.paths?.uploads || path.resolve(process.cwd(), 'uploads');
}

/**
 * Traite une image : rotation selon l'EXIF, redimensionnement borné, WebP.
 *
 * Le redimensionnement n'est pas cosmétique : un logo de 12 Mo publié dans le
 * pied de page de chaque projet serait téléchargé par chaque visiteur.
 */
export async function processImage(buffer, { maxWidth = 1920, prefix = 'img' } = {}) {
  const dossier = uploadsDir();
  await fs.mkdir(dossier, { recursive: true });

  const unique = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
  const destination = path.join(dossier, unique);

  await sharp(buffer)
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(destination);

  return { url: `${UPLOADS_PUBLIC_PREFIX}/${unique}`, filename: unique };
}

/**
 * RETIRE un média — sur l'autorité, et nulle part ailleurs.
 *
 * ── LE NOM EST VALIDÉ, PAS NETTOYÉ ──────────────────────────────────────────
 * Le nom arrive d'une requête. Le « nettoyer » masquerait une tentative ; on
 * exige donc exactement la forme que `processImage` produit — préfixe,
 * horodatage, aléa, extension `.webp` — et rien d'autre. Aucun séparateur, aucun
 * point isolé, aucune remontée possible.
 *
 * ── SUPPRIMER DEUX FOIS N’EST PAS UNE ERREUR ────────────────────────────────
 * Un double clic, deux onglets, une reprise après coupure : le média peut
 * avoir déjà disparu. On le dit (`alreadyGone`) plutôt que de lever — le
 * résultat voulu est atteint dans les deux cas.
 */
const NOM_MEDIA = /^[a-z0-9_-]{1,32}-\d{10,}-\d{1,12}\.webp$/i;

export async function deleteImage(filename) {
  const nom = String(filename ||'').trim();
  if (!NOM_MEDIA.test(nom)) {
    const err = new Error("Nom de média invalide.");
    err.status = 400;
    err.code = "PANEL_MEDIA_INVALID_NAME";
    throw err;
  }

  const dossier = uploadsDir();
  const cible = path.join(dossier, nom);

  // Ceinture et bretelles : après résolution, le chemin doit toujours être
  // DANS le dossier des médias. Une regex peut être contournée un jour ; la
  // comparaison de chemins résolus, non.
  const racine = path.resolve(dossier);
  if (path.dirname(path.resolve(cible)) !== racine) {
    const err = new Error("Chemin de média hors du dossier autorisé.");
    err.status = 400;
    err.code = "PANEL_MEDIA_PATH_ESCAPE";
    throw err;
  }

  try {
    await fs.unlink(cible);
    return { deleted: true, filename: nom, alreadyGone: false };
  } catch (err) {
    if (err?.code === "ENOENT") return { deleted: true, filename: nom, alreadyGone: true };
    throw err;
  }
}

/**
 * Rend une adresse publiable par les projets.
 *
 * ── L'ADRESSE VIENT DE LA CONFIGURATION EXISTANTE ─────────────────────────
 * Aucune variable d'environnement dédiée : le Panel connaît déjà son domaine.
 * `resolveBackendUrl()` applique la règle de priorité du projet — configuration
 * système (écrite par le déploiement, depuis le domaine de la cible), puis
 * repli d'environnement, puis défaut local — et refuse en PROD une adresse qui
 * ne serait pas publiquement joignable.
 *
 * Une valeur déjà absolue est rendue telle quelle : le champ accepte encore une
 * URL externe, et rien ne justifie de la réécrire. Sans adresse résolue, on
 * rend `null` plutôt qu'un lien qui pointerait chez le client.
 */
export async function resolvePublicMediaUrl(valeur) {
  const brut = String(valeur ?? '').trim();
  if (!brut) return null;
  if (/^https?:\/\//i.test(brut)) return brut;
  if (!brut.startsWith(UPLOADS_PUBLIC_PREFIX)) return null;

  const { url } = await resolveBackendUrl();
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}${brut}`;
}

export default { processImage, deleteImage, resolvePublicMediaUrl, UPLOADS_PUBLIC_PREFIX, uploadsDir };
