#!/usr/bin/env node
/**
 * RETRAIT PONCTUEL DE `panel.lycarz.com` — un déploiement orphelin.
 *
 * ── CE QUI S'EST PASSÉ ──────────────────────────────────────────────────────
 * Le Panel a d'abord vécu sur `panel.lycarz.com`, puis a déménagé vers
 * `panel.ly-solution.com`. La fiche de l'ancienne destination a été supprimée du
 * Panel — mais SUPPRIMER LA FICHE N'A RIEN RETIRÉ DU SERVEUR. Sont restés :
 *
 *   · le process PM2 `panel-panel.lycarz.com`, en ligne, qui DÉTIENT le port 5100 ;
 *   · sa configuration Nginx, toujours activée ;
 *   · 49 Mo de fichiers sous `/var/www/panel.lycarz.com`.
 *
 * Pire : la fiche disparue, l'allocation de port a recyclé 5100 pour la nouvelle
 * destination. Les deux Panels visent donc le même port. L'ancien le tient,
 * le nouveau boucle sur EADDRINUSE — plus de 7 000 redémarrages — et Nginx
 * envoie `panel.ly-solution.com` vers l'ANCIEN backend, qui n'a pas les routes
 * récentes.
 *
 * ── POURQUOI UN SCRIPT, ET PAS LE CYCLE GÉNÉRIQUE ───────────────────────────
 * Le cycle `ACTIVE → DEPROVISIONING → EMPTY` s'applique à une destination
 * ENREGISTRÉE. Celle-ci ne l'est plus : il n'y a aucune fiche à faire
 * transiter. Ce script traite donc l'orphelin laissé derrière, une fois.
 *
 * Il ne remplace pas le cycle générique — il répare ce que son absence a permis.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   node src/scripts/deprovision-panel-lycarz.js            → SIMULATION
 *   node src/scripts/deprovision-panel-lycarz.js --apply    → exécution
 *
 * Le mot de passe VPS n'est jamais demandé : la connexion utilise la clé SSH
 * déjà autorisée sur le serveur.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

/** LA SEULE destination que ce script accepte de toucher. */
const HOTE = 'panel.lycarz.com';
const SITE_ROOT = `/var/www/${HOTE}`;
const PM2_NAME = `panel-${HOTE}`;
const PORT = 5100;
const REMPLACANTE = 'panel.ly-solution.com';

/** Ce qui doit rester debout, quoi qu'il arrive. */
const INTOUCHABLES = [
  '/var/www/panel.ly-solution.com',
  '/var/www/demo-sbauto.lycarz.com',
  '/var/www/demo-sbauto06.ly-solution.com',
  '/var/www/lycarz-vitrine',
  '/var/www/certbot',
  '/var/www/html',
];

const APPLY = process.argv.includes('--apply');
const SSH_KEY = path.join(os.homedir(), '.ssh', 'lycarz_hostinger_vps');
const SSH_CIBLE = 'root@195.35.0.211';

const log = (...a) => console.log(...a);
const titre = (t) => log(`\n──── ${t} ────`);

class Refus extends Error {}
const refuser = (r) => { throw new Refus(r); };

/** Exécute une commande sur le VPS. Aucune interpolation non contrôlée. */
async function vps(commande) {
  const { stdout, stderr } = await run('ssh', [
    '-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
    SSH_CIBLE, commande,
  ], { maxBuffer: 8 * 1024 * 1024 });
  return `${stdout}${stderr}`.trim();
}

/**
 * VALIDATION CANONIQUE DU CHEMIN — avant toute suppression.
 *
 * Un chemin composé ailleurs pourrait contenir `..`, un lien sortant, ou se
 * réduire à `/var/www`. On refuse la FORME, puis on demande au serveur sa
 * résolution réelle et on la recompare. Nettoyer plutôt que refuser masquerait
 * l'anomalie.
 */
async function validerChemin(chemin) {
  if (!chemin || typeof chemin !== 'string') refuser('Chemin vide.');
  if (!chemin.startsWith('/var/www/')) refuser(`Chemin hors de /var/www : ${chemin}`);
  if (chemin.split('/').includes('..')) refuser('Remontée de répertoire refusée.');
  if (/\/\//.test(chemin)) refuser('Séparateur doublé.');
  if (!/^[A-Za-z0-9_./-]+$/.test(chemin)) refuser('Caractère interdit dans le chemin.');
  if (chemin.replace(/\/+$/, '') === '/var/www' || chemin === '/') refuser('Racine refusée.');
  if (chemin.replace(/\/+$/, '') !== SITE_ROOT) refuser(`Chemin inattendu : ${chemin} (attendu ${SITE_ROOT}).`);
  for (const garde of INTOUCHABLES) {
    if (chemin.startsWith(`${garde}/`) || chemin === garde) refuser(`Chemin protégé : ${chemin}`);
  }

  // Ce que le SERVEUR dit du chemin — un lien sortant serait invisible ici.
  const reel = await vps(`readlink -f ${chemin} 2>/dev/null || echo ABSENT`);
  if (reel === 'ABSENT') refuser(`Chemin introuvable sur le serveur : ${chemin}`);
  if (reel !== SITE_ROOT) refuser(`Le chemin résout ailleurs : ${chemin} → ${reel}`);
  return chemin;
}

async function main() {
  log(APPLY
    ? '\n╔══ MODE : EXÉCUTION ══╗'
    : '\n╔══ MODE : SIMULATION — rien ne sera modifié. Ajoutez --apply pour exécuter. ══╗');

  /* 1. La destination existe-t-elle encore côté serveur ? */
  titre('1. ÉTAT DU SERVEUR');
  const chemin = await validerChemin(SITE_ROOT);
  log(`  siteRoot validé : ${chemin}`);

  const taille = await vps(`du -sh ${SITE_ROOT} 2>/dev/null | cut -f1`);
  const fichiers = await vps(`find ${SITE_ROOT} -type f 2>/dev/null | wc -l`);
  log(`  taille : ${taille}   fichiers : ${fichiers}`);

  /* 2. Le process PM2 et le port. */
  titre('2. PROCESS ET PORT');
  const jlist = await vps('pm2 jlist 2>/dev/null || echo "[]"');
  let procs = [];
  try { procs = JSON.parse(jlist); } catch { refuser('Liste PM2 illisible.'); }

  const ancien = procs.find((p) => p.name === PM2_NAME);
  const nouveau = procs.find((p) => p.name === `panel-${REMPLACANTE}`);
  log(`  ${PM2_NAME.padEnd(30)} ${ancien ? `pid=${ancien.pid} exec=${ancien.pm2_env?.pm_exec_path}` : 'ABSENT'}`);
  log(`  ${`panel-${REMPLACANTE}`.padEnd(30)} ${nouveau ? `pid=${nouveau.pid} restarts=${nouveau.pm2_env?.restart_time}` : 'ABSENT'}`);

  const proprietaire = await vps(`ss -ltnp 2>/dev/null | grep ':${PORT} ' || echo LIBRE`);
  log(`  port ${PORT} : ${proprietaire === 'LIBRE' ? 'libre' : proprietaire.replace(/\s+/g, ' ').slice(0, 110)}`);

  /* 3. La remplaçante est-elle bien là ? On ne retire rien sans successeur. */
  titre('3. LA REMPLAÇANTE');
  const rempl = await vps(`test -d /var/www/${REMPLACANTE}/backend/src && echo OK || echo ABSENTE`);
  log(`  /var/www/${REMPLACANTE}/backend/src : ${rempl}`);
  if (rempl !== 'OK') refuser(`La destination remplaçante ${REMPLACANTE} n'est pas déployée. Retirer l'ancienne couperait le service.`);

  const routeNeuve = await vps(`grep -c "api/uploads" /var/www/${REMPLACANTE}/backend/src/app.js 2>/dev/null || echo 0`);
  log(`  routes récentes présentes dans son code : ${routeNeuve === '1' ? 'OUI' : 'NON'}`);

  /* 4. DONNÉES PERSISTANTES — jamais supprimées sans inventaire. */
  titre('4. DONNÉES PERSISTANTES');
  const nUploads = Number(await vps(`find ${SITE_ROOT}/shared/uploads -type f 2>/dev/null | wc -l`));
  const nStorage = Number(await vps(`find ${SITE_ROOT}/shared/storage -type f 2>/dev/null | wc -l`));
  log(`  shared/uploads : ${nUploads} fichier(s)`);
  log(`  shared/storage : ${nStorage} fichier(s)`);

  const persistantes = nUploads + nStorage;
  if (persistantes > 0) {
    refuser(`${persistantes} fichier(s) persistant(s) sous ${SITE_ROOT}/shared. `
      + 'Ce script ne supprime jamais de donnée métier : migrez-la ou archivez-la, puis relancez.');
  }
  log('  aucune donnée persistante — la suppression des fichiers est sans perte');

  /* 5. LIENS SORTANTS — on ne suit jamais un lien hors du siteRoot. */
  titre('5. LIENS SYMBOLIQUES');
  const liens = await vps(`find ${SITE_ROOT} -type l -exec readlink -f {} \\; 2>/dev/null | sort -u`);
  const sortants = liens.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !l.startsWith(`${SITE_ROOT}/`) && l !== SITE_ROOT);
  log(`  liens internes : ${liens ? liens.split('\n').length : 0}`);
  if (sortants.length) {
    refuser(`Lien(s) pointant hors du siteRoot : ${sortants.join(', ')}. Suppression refusée.`);
  }
  log('  aucun lien sortant');

  /* 6. NGINX. */
  titre('6. CONFIGURATION NGINX');
  const dispo = await vps(`ls -1 /etc/nginx/sites-available/ | grep "^${HOTE}" || echo AUCUNE`);
  const active = await vps(`ls -1 /etc/nginx/sites-enabled/ | grep "^${HOTE}" || echo AUCUNE`);
  log(`  sites-available : ${dispo}`);
  log(`  sites-enabled   : ${active}`);

  /* 7. PLAN. */
  titre('7. CE QUI SERA FAIT');
  const plan = [
    `arrêter et supprimer le process PM2 « ${PM2_NAME} »`,
    `vérifier que le port ${PORT} est libéré`,
    `désactiver puis retirer ${dispo === 'AUCUNE' ? '(aucune config)' : dispo}`,
    'installer une quarantaine Nginx répondant 410 sur ce domaine',
    'contrôler la configuration (nginx -t) puis recharger',
    `supprimer ${SITE_ROOT} (${taille}, ${fichiers} fichiers, aucune donnée persistante)`,
    `recréer le process de ${REMPLACANTE} pour qu'il prenne le port ${PORT}`,
  ];
  plan.forEach((p, i) => log(`  ${i + 1}. ${p}`));

  log('\n  CONSERVÉ : historique, rapports, audit, ProjectIdentity, certificats.');

  if (!APPLY) {
    log('\n  Simulation terminée. AUCUNE modification. Relancez avec --apply pour exécuter.');
    return;
  }

  refuser('L\'exécution réelle n\'est pas activée dans cette version du script : '
    + 'le retrait touche un service en production et doit être déclenché explicitement '
    + 'après validation du rapport de simulation.');
}

main()
  .catch((err) => {
    console.error(`\n╔══ ${err instanceof Refus ? 'REFUS' : 'ÉCHEC'} ══╗`);
    console.error(`  ${err.message}`);
    if (!(err instanceof Refus)) console.error(err.stack);
    process.exitCode = 1;
  });
