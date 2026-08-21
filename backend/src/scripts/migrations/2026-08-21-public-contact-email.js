// MIGRATION — donne un CHAMP à l'adresse de contact public, sans rien décider.
//
//   npm run migrate:public-contact-email
//   npm run migrate:public-contact-email -- --dry-run
//
// ── LE DÉFAUT QU'ELLE RÉPARE ────────────────────────────────────────────────
//
// L'adresse imprimée au bas de chaque e-mail client existait, mais DÉDUITE :
// les projets balayaient `references[]` — la liste de liens de l'agence — et
// retenaient la première valeur qui ressemblait à une adresse.
//
// Le contact public dépendait donc de l'ORDRE d'une liste que l'opérateur
// réorganise pour des raisons d'affichage. Glisser un lien LinkedIn en tête
// n'aurait rien changé ; y glisser une seconde adresse aurait tout changé, et
// aucun écran ne l'annonçait. Une donnée que personne ne peut ni voir ni
// choisir n'est pas une configuration : c'est un effet de bord.
//
// ── CE QU'ELLE NE FAIT PAS : DÉCIDER À LA PLACE DE L'OPÉRATEUR ──────────────
//
// Elle n'invente aucune adresse. Elle ne recopie PAS :
//
//   · `contacts.supportEmail` — c'est l'adresse transmise à Let's Encrypt pour
//     les alertes d'expiration de certificat. De l'exploitation, pas du
//     contact client ;
//   · `contacts.email` — l'adresse administrative de l'agence ;
//   · l'expéditeur du parc — un `From` peut être une boîte technique que
//     personne ne relève ;
//   · l'adresse d'un compte SUPER_ADMIN.
//
// Elle reprend UNIQUEMENT la valeur qui servait DÉJÀ à cet usage exact : la
// première adresse des références, celle que les projets affichaient hier. Ce
// n'est pas un choix nouveau, c'est le choix existant rendu explicite.
//
// Si aucune référence ne porte d'adresse, le champ reste VIDE et l'écran
// « Expéditeur e-mail » l'annonce « À renseigner ». Remplir à la place de
// l'opérateur publierait au nom de son entreprise une adresse qu'il n'a pas
// choisie.
//
// ── IDEMPOTENTE ─────────────────────────────────────────────────────────────
//
// Une entreprise dont le champ est déjà rempli n'est pas touchée : un second
// passage ne peut pas écraser une décision prise entre-temps.
import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import PanelCompany from '../../models/PanelCompany.model.js';
import logger from '../../utils/logger.js';

const DRY_RUN = process.argv.includes('--dry-run');

/** La même expression que le reste du Panel : une seconde règle divergerait. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * L'ancienne déduction, reproduite à l'identique.
 *
 * Volontairement recopiée plutôt qu'importée du projet : elle vit dans SB Auto,
 * et une migration du Panel ne doit pas dépendre du code d'un projet. Elle est
 * figée ici pour ce seul passage, et disparaîtra avec lui.
 */
function premiereAdresseDesReferences(references = []) {
  const triees = [...references].sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
  for (const r of triees) {
    const valeur = String(r?.value ?? '').trim().replace(/^mailto:/i, '');
    if (EMAIL_RE.test(valeur)) return valeur.toLowerCase();
  }
  return null;
}

export async function migratePublicContactEmail({ dryRun = false } = {}) {
  const entreprises = await PanelCompany.find().lean();
  const rapport = { examinees: entreprises.length, deja: 0, reprises: 0, vides: 0, details: [] };

  for (const c of entreprises) {
    const nom = c.identity?.name ?? c.companyId;

    if (String(c.contacts?.publicContactEmail ?? '').trim()) {
      rapport.deja += 1;
      rapport.details.push(`${nom} : déjà renseignée (${c.contacts.publicContactEmail})`);
      continue;
    }

    const heritee = premiereAdresseDesReferences(c.references);
    if (!heritee) {
      rapport.vides += 1;
      rapport.details.push(`${nom} : aucune adresse dans les références — laissée VIDE, à renseigner par l'opérateur`);
      continue;
    }

    rapport.reprises += 1;
    rapport.details.push(`${nom} : reprise de la première référence → ${heritee}`);
    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await PanelCompany.updateOne(
        { companyId: c.companyId },
        { $set: { 'contacts.publicContactEmail': heritee } },
      );
    }
  }

  return rapport;
}

/* Exécution directe seulement — l'import reste possible pour la recette. */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('2026-08-21-public-contact-email.js')) {
  await connectDatabase();
  const rapport = await migratePublicContactEmail({ dryRun: DRY_RUN });

  logger.info(`\n════ CONTACT PUBLIC ${DRY_RUN ? '— SIMULATION' : '— APPLIQUÉE'} ════`);
  logger.info(`entreprises examinées : ${rapport.examinees}`);
  logger.info(`déjà renseignées      : ${rapport.deja}`);
  logger.info(`reprises              : ${rapport.reprises}`);
  logger.info(`laissées vides        : ${rapport.vides}`);
  for (const d of rapport.details) logger.info(`   · ${d}`);
  if (DRY_RUN) logger.info('\nSIMULATION — relancer sans --dry-run.');

  await disconnectDatabase();
  await mongoose.disconnect().catch(() => {});
}

export default migratePublicContactEmail;
