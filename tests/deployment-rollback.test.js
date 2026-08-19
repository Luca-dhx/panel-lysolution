/**
 * ROLLBACK — le retour arrière, éprouvé sur un vrai système de fichiers simulé.
 *
 * ══ POURQUOI CE DOUBLE A ÉTÉ REFAIT (R10.2) ═════════════════════════════════
 *
 * L'ancien double répondait à `ls -1 …/releases` et `readlink -f …/current` :
 * il simulait une disposition que le pipeline ne produit PAS. Les contrôles
 * passaient donc au vert sur un mécanisme inexistant — un filet de sécurité
 * qui n'aurait pas retenu, et une recette qui l'affirmait pourtant.
 *
 * Celui-ci tient un VRAI système de fichiers en mémoire : `mkdir -p`, `rm -rf`,
 * `mv`, `test -d/-f`, `cat`. Les commandes que le moteur émet y agissent
 * réellement. Un déploiement se rejoue avec la commande d'échange EXACTE du
 * pipeline, et le retour arrière est prouvé en relisant ce qui est servi.
 *
 * Ce que ces contrôles verrouillent :
 *  - le pipeline met bien le backend de côté (`.prev`) — sans quoi il n'y a
 *    rien vers quoi revenir ;
 *  - un `.prev` incomplet n'est JAMAIS activé ;
 *  - l'échange est son propre inverse : aller-retour prouvé sur les octets ;
 *  - un rollback en échec RÉTABLIT la version d'origine ;
 *  - les données partagées ne bougent pas ;
 *  - les refus portent des codes stables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rollbackToPrevious,
  describeRollbackState,
  verifyPreviousIntegrity,
  rollbackSlots,
  listReleases,
  currentRelease,
} from '../backend/src/deployment-engine/rollback.js';
import { pm2AppName } from '../backend/src/deployment-engine/pm2.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}`); }
};
const section = (t) => console.log(`\n${t}`);

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'site.exemple.com';
const ROOT = '/var/www';
const SITE = `${ROOT}/${HOST}`;

/**
 * LA COMPOSITION VIENT DU PROFIL. Ce fichier est MIROIR entre les deux dépôts,
 * dont les profils diffèrent — une SPA d'un côté, deux de l'autre. Nommer une
 * application en dur le rendrait faux dans l'un des deux.
 */
const { slots: SLOTS } = rollbackSlots({ host: HOST, remoteRoot: ROOT });
const APPS = SLOTS.filter((s) => s.id !== 'backend').map((s) => s.id);
/** La première SPA du profil — celle dont on relit les octets servis. */
const APP = APPS[0];

/* -------------------------------------------------------------------------- */
/*  UN SYSTÈME DE FICHIERS DISTANT, EN MÉMOIRE                                */
/* -------------------------------------------------------------------------- */

/**
 * Le strict nécessaire pour que les commandes du moteur AGISSENT.
 *
 * Un double qui se contente de répondre « OK » prouve qu'on a posé la bonne
 * question, jamais qu'on obtient le bon résultat. Ici `mv` déplace vraiment, et
 * c'est ce qui permet d'affirmer qu'un aller-retour ramène les mêmes octets.
 */
function makeFs() {
  const dirs = new Set(['/', '/var', '/var/www']);
  const files = new Map();

  const sous = (p) => (chemin) => chemin === p || chemin.startsWith(`${p}/`);

  return {
    dirs,
    files,
    mkdirp(p) {
      const parts = p.split('/').filter(Boolean);
      let acc = '';
      for (const seg of parts) { acc += `/${seg}`; dirs.add(acc); }
    },
    rmrf(p) {
      const dedans = sous(p);
      for (const d of [...dirs]) if (dedans(d)) dirs.delete(d);
      for (const f of [...files.keys()]) if (dedans(f)) files.delete(f);
    },
    mv(a, b) {
      if (!dirs.has(a) && !files.has(a)) return false;
      const dedans = sous(a);
      const rebase = (chemin) => `${b}${chemin.slice(a.length)}`;
      for (const d of [...dirs]) if (dedans(d)) { dirs.delete(d); dirs.add(rebase(d)); }
      for (const f of [...files.keys()]) {
        if (dedans(f)) { const c = files.get(f); files.delete(f); files.set(rebase(f), c); }
      }
      return true;
    },
    write(p, contenu) {
      this.mkdirp(p.split('/').slice(0, -1).join('/'));
      files.set(p, contenu);
    },
    isDir: (p) => dirs.has(p),
    isFile: (p) => files.has(p),
    read: (p) => files.get(p) ?? '',
  };
}

/**
 * Transport simulé — exécute réellement les commandes sur le faux disque.
 *
 * `healthyVersions` : les versions dont le backend répond au contrôle de santé.
 * `failSwapFor` : identifiant d'emplacement dont l'échange doit échouer.
 */
function makeTransport(disque, { healthyVersions = null, failSwapFor = null } = {}) {
  const state = { commands: [], restarts: 0, pm2Path: null };

  /** La version SERVIE : celle du manifeste présent dans le backend déployé. */
  const versionServie = () => {
    const brut = disque.read(`${SITE}/backend/build-manifest.json`);
    try { return JSON.parse(brut).shortCommit; } catch { return null; }
  };

  const runOne = (cmd) => {
    const c = cmd.trim();

    let m = c.match(/^if \[ -d (\S+) \]; then mv (\S+) (\S+); fi$/);
    if (m) { if (disque.isDir(m[1])) disque.mv(m[2], m[3]); return { code: 0, stdout: '', stderr: '' }; }

    m = c.match(/^mkdir -p (.+)$/);
    if (m) { for (const p of m[1].split(/\s+/)) disque.mkdirp(p); return { code: 0, stdout: '', stderr: '' }; }

    m = c.match(/^rm -rf (.+)$/);
    if (m) { for (const p of m[1].split(/\s+/)) disque.rmrf(p); return { code: 0, stdout: '', stderr: '' }; }

    m = c.match(/^mv (\S+) (\S+)$/);
    if (m) {
      if (failSwapFor && m[1].includes(failSwapFor)) {
        return { code: 1, stdout: '', stderr: 'permission denied' };
      }
      return disque.mv(m[1], m[2])
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: 'no such file' };
    }

    m = c.match(/^test -([df]) (\S+)$/);
    if (m) {
      const ok = m[1] === 'd' ? disque.isDir(m[2]) : disque.isFile(m[2]);
      return { code: ok ? 0 : 1, stdout: '', stderr: '' };
    }

    m = c.match(/^cat (\S+)/);
    if (m) return { code: 0, stdout: disque.read(m[1]), stderr: '' };

    return { code: 0, stdout: '', stderr: '' };
  };

  const tx = {
    kind: 'fake',
    async exec(cmd) {
      state.commands.push(cmd);

      /**
       * `test -d X && echo OK || echo KO` — L'IDIOME DU MOTEUR.
       *
       * Intercepté AVANT le découpage sur `&&` : c'est une seule question, pas
       * une chaîne de commandes. Le découper rendait la réponse du dernier
       * maillon (`echo`), donc toujours vide — et tout paraissait absent.
       */
      const sonde = cmd.trim().match(/^test -([df]) (\S+) && echo OK \|\| echo KO$/);
      if (sonde) {
        const ok = sonde[1] === 'd' ? disque.isDir(sonde[2]) : disque.isFile(sonde[2]);
        return { code: 0, stdout: ok ? 'OK' : 'KO', stderr: '' };
      }

      if (/pm2 jlist/.test(cmd)) {
        const liste = state.pm2Path === null ? [] : [{
          name: pm2AppName(HOST),
          pid: 4242,
          pm2_env: {
            pm_exec_path: state.pm2Path,
            pm_cwd: state.pm2Path.replace(/\/src\/server\.js$/, ''),
            status: 'online',
            restart_time: 0,
            env: { PORT: '4100' },
          },
        }];
        return { code: 0, stdout: JSON.stringify(liste), stderr: '' };
      }
      if (/pm2 delete/.test(cmd)) { state.pm2Path = null; return { code: 0, stdout: '', stderr: '' }; }
      if (/pm2 (start|reload|restart)/.test(cmd)) {
        state.restarts += 1;
        const dem = cmd.match(/cd (\S+) &&[\s\S]*pm2 start (\S+) --name/);
        if (dem) state.pm2Path = `${dem[1]}/${dem[2]}`;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (/pm2 save/.test(cmd)) return { code: 0, stdout: '', stderr: '' };
      if (/curl .*\/health/.test(cmd)) {
        const v = versionServie();
        const ok = healthyVersions === null || healthyVersions.includes(v);
        return { code: 0, stdout: ok ? '200' : '000', stderr: '' };
      }

      // Le reste : chaînes `A && B && C`, exécutées dans l'ordre, arrêt au 1er échec.
      /**
       * UNE CHAÎNE, exécutée dans l'ordre, arrêt au premier échec.
       *
       * Le double ne découpait que sur `&&`. Depuis que l'échange de rollback
       * passe sous shell strict (`set -euo pipefail`, séparateurs `;`), il doit
       * modéliser ce qu'un vrai shell fait de ces deux séparateurs sous
       * `set -e` : la même chose.
       */
      const sansPreambule = cmd.replace(/^\s*set -euo pipefail;\s*/, '');
      let dernier = { code: 0, stdout: '', stderr: '' };
      for (const part of sansPreambule.split(/&&|;/)) {
        if (!part.trim()) continue;
        dernier = runOne(part);
        if (dernier.code !== 0) return dernier;
      }
      return dernier;
    },
    async writeFile(p, contenu) { disque.write(p, contenu); },
    async close() {},
  };
  return { tx, state, versionServie };
}

/**
 * REJOUE UN DÉPLOIEMENT — avec la commande d'échange EXACTE du pipeline.
 *
 * C'est ce qui donne sa valeur à la recette : si le pipeline cesse un jour de
 * mettre le backend de côté, ce n'est pas ce fichier qu'il faudra corriger,
 * c'est le rollback qui n'aura plus rien — et le contrôle statique en fin de
 * fichier rougira.
 */
function deployer(disque, version) {
  /**
   * LES EMPLACEMENTS VIENNENT DU PROFIL, jamais d'une liste écrite ici. Ce
   * fichier est MIROIR entre les deux dépôts, dont les compositions diffèrent
   * (une SPA d'un côté, deux de l'autre) : une liste en dur y serait fausse
   * dans l'un des deux.
   */
  const { slots: reels } = rollbackSlots({ host: HOST, remoteRoot: ROOT });
  const apps = reels.filter((s) => s.id !== 'backend').map((s) => s.id);
  const slots = [
    ...apps.map((id) => ({ target: `${SITE}/${id}`, next: `${SITE}/${id}.next`, prev: `${SITE}/${id}.prev` })),
    { target: `${SITE}/backend`, next: `${SITE}/backend.next`, prev: `${SITE}/backend.prev` },
  ];

  // 1. dossiers `.next` neufs
  for (const s of slots) { disque.rmrf(s.next); disque.mkdirp(s.next); }

  // 2. contenu de l'artefact
  const manifeste = JSON.stringify({ shortCommit: version, commitHash: `${version}0000`, builtAt: version });
  for (const id of apps) {
    disque.write(`${SITE}/${id}.next/index.html`, `<html>${version}</html>`);
    disque.write(`${SITE}/${id}.next/version.json`, manifeste);
  }
  disque.write(`${SITE}/backend.next/package.json`, '{"name":"panel-backend"}');
  disque.write(`${SITE}/backend.next/src/server.js`, `// ${version}`);
  disque.write(`${SITE}/backend.next/build-manifest.json`, manifeste);

  // 3. LA BASCULE — même forme que `pipeline.js`
  for (const s of slots) disque.rmrf(s.prev);
  for (const s of slots) {
    if (disque.isDir(s.target)) disque.mv(s.target, s.prev);
    disque.mv(s.next, s.target);
  }

  // 4. étape `dirs` : liens persistants + dépendances installées côté serveur
  disque.mkdirp(`${SITE}/shared/uploads`);
  disque.mkdirp(`${SITE}/shared/storage/media`);
  disque.mkdirp(`${SITE}/backend/uploads`);
  disque.mkdirp(`${SITE}/backend/storage`);
  disque.mkdirp(`${SITE}/backend/node_modules`);
  disque.write(`${SITE}/backend/.env`, `ENV=TEST\n# ${version}`);
}

const ARGS = {
  host: HOST, backendPort: 4100, remoteRoot: ROOT, env: 'TEST',
  healthRetries: 1, healthDelayMs: 1,
};

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. Les emplacements qui basculent — dérivés du profil');
{
  const { slots, topo } = rollbackSlots({ host: HOST, remoteRoot: ROOT });
  const ids = slots.map((s) => s.id);

  check('le BACKEND fait partie des emplacements', ids.includes('backend'));
  check('…et au moins une application publiable aussi', slots.length >= 2);
  check('chaque emplacement a son `.prev`',
    slots.every((s) => s.prev === `${s.target}.prev`));
  check('les chemins viennent de la topologie',
    slots.find((s) => s.id === 'backend').target === topo.backendDir);
  check('aucun `releases/` ni `current` dans les chemins',
    slots.every((s) => !/releases|\/current$/.test(s.target)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Un seul déploiement — aucun retour arrière possible');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  const { tx } = makeTransport(disque);

  const state = await describeRollbackState(tx, ARGS);
  check('la version déployée est lue', state.current === 'aaaaaaa');
  check('aucune version précédente', state.previous === null);
  check('le retour arrière est REFUSÉ', state.canRollback === false);
  check('…et les emplacements manquants sont nommés', state.missingPrevious.length > 0);

  let code = null;
  try { await rollbackToPrevious({ transport: tx, ...ARGS }); } catch (err) { code = err.code; }
  check('le refus porte un code stable', code === 'ROLLBACK_NO_PREVIOUS_VERSION');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. Deux déploiements — le `.prev` existe, backend compris');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  deployer(disque, 'bbbbbbb');
  const { tx } = makeTransport(disque);

  check('LE BACKEND A BIEN UN `.prev`', disque.isDir(`${SITE}/backend.prev`));
  check('…avec ses dépendances', disque.isDir(`${SITE}/backend.prev/node_modules`));
  check('…et son point d’entrée', disque.isFile(`${SITE}/backend.prev/src/server.js`));
  check('la SPA aussi', disque.isDir(`${SITE}/${APP}.prev`));

  const state = await describeRollbackState(tx, ARGS);
  check('la version servie est la dernière', state.current === 'bbbbbbb');
  check('la précédente est identifiée', state.previous === 'aaaaaaa');
  check('le retour arrière est POSSIBLE', state.canRollback === true);

  const integrity = await verifyPreviousIntegrity(tx, ARGS);
  check('la version de secours est intègre', integrity.ok === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. ALLER-RETOUR — prouvé sur les octets servis');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  deployer(disque, 'bbbbbbb');
  const { tx, versionServie, state: txState } = makeTransport(disque);

  check('avant : la version B est servie', versionServie() === 'bbbbbbb');
  check('…et le HTML aussi', disque.read(`${SITE}/${APP}/index.html`).includes('bbbbbbb'));

  const aller = await rollbackToPrevious({ transport: tx, ...ARGS });
  check('le rollback réussit', aller.ok === true);
  check('…et NOMME d’où l’on vient', aller.from === 'bbbbbbb');
  check('…et où l’on va', aller.to === 'aaaaaaa');

  check('APRÈS : la version A est servie', versionServie() === 'aaaaaaa');
  check('…le HTML de la SPA aussi', disque.read(`${SITE}/${APP}/index.html`).includes('aaaaaaa'));
  check('…et le service a été relancé', txState.restarts > 0);

  /**
   * L'ÉCHANGE EST SON PROPRE INVERSE : ce qu'on vient de quitter est devenu le
   * `.prev`. C'est ce qui rend un rollback réversible sans second chemin de
   * code — et ce qui permet à la restauration de rejouer la même opération.
   */
  const apres = await describeRollbackState(tx, ARGS);
  check('la version quittée devient la précédente', apres.previous === 'bbbbbbb');
  check('…et un second retour est possible', apres.canRollback === true);

  const retour = await rollbackToPrevious({ transport: tx, ...ARGS });
  check('le second rollback ramène en avant', retour.ok === true && retour.to === 'bbbbbbb');
  check('LES OCTETS SONT CEUX DU DÉPART', versionServie() === 'bbbbbbb');
  check('…y compris pour la SPA',
    disque.read(`${SITE}/${APP}/index.html`).includes('bbbbbbb'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. Les DONNÉES ne bougent jamais');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  deployer(disque, 'bbbbbbb');

  // Un justificatif déposé APRÈS le dernier déploiement, dans le partagé.
  disque.write(`${SITE}/shared/storage/media/justificatif.pdf`, 'PDF-OCTETS');
  disque.write(`${SITE}/shared/uploads/logo.webp`, 'IMG-OCTETS');

  const { tx } = makeTransport(disque);
  await rollbackToPrevious({ transport: tx, ...ARGS });

  check('LE JUSTIFICATIF PRIVÉ EST INTACT',
    disque.read(`${SITE}/shared/storage/media/justificatif.pdf`) === 'PDF-OCTETS');
  check('…et le média public aussi',
    disque.read(`${SITE}/shared/uploads/logo.webp`) === 'IMG-OCTETS');
  check('le partagé n’a pas été déplacé', disque.isDir(`${SITE}/shared/storage/media`));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. Un `.prev` incomplet n’est JAMAIS activé');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  deployer(disque, 'bbbbbbb');
  // Les dépendances de la version de secours ont disparu : elle ne démarrerait pas.
  disque.rmrf(`${SITE}/backend.prev/node_modules`);

  const { tx, versionServie } = makeTransport(disque);
  const integrity = await verifyPreviousIntegrity(tx, ARGS);
  check('l’intégrité est refusée', integrity.ok === false);
  check('…en nommant l’emplacement et la cause',
    integrity.failed.some((f) => f.id === 'backend' && /dépendances/.test(f.message)));

  let code = null;
  try { await rollbackToPrevious({ transport: tx, ...ARGS }); } catch (err) { code = err.code; }
  check('le rollback est REFUSÉ', code === 'ROLLBACK_PREVIOUS_CORRUPT');
  check('…et RIEN n’a bougé', versionServie() === 'bbbbbbb');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. Santé rouge après bascule — la version d’origine est RÉTABLIE');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  deployer(disque, 'bbbbbbb');

  // Seule B répond : revenir à A produira un contrôle de santé rouge.
  const { tx, versionServie } = makeTransport(disque, { healthyVersions: ['bbbbbbb'] });

  let code = null;
  try { await rollbackToPrevious({ transport: tx, ...ARGS }); } catch (err) { code = err.code; }

  check('l’échec est signalé', code === 'ROLLBACK_FAILED_RESTORED');
  check('LA VERSION D’ORIGINE EST RÉTABLIE', versionServie() === 'bbbbbbb');
  check('…et la SPA avec elle',
    disque.read(`${SITE}/${APP}/index.html`).includes('bbbbbbb'));
  check('…le `.prev` est de nouveau la version A',
    disque.read(`${SITE}/backend.prev/build-manifest.json`).includes('aaaaaaa'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. Échange impossible en cours de route — rétablissement partiel');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  deployer(disque, 'bbbbbbb');

  // Le backend refuse de bouger : les SPA ont déjà basculé quand l'échec tombe.
  const { tx, versionServie } = makeTransport(disque, { failSwapFor: `${SITE}/backend` });

  let code = null;
  try { await rollbackToPrevious({ transport: tx, ...ARGS }); } catch (err) { code = err.code; }

  check('l’échec est signalé', code === 'ROLLBACK_FAILED_RESTORED');
  check('le backend n’a pas bougé', versionServie() === 'bbbbbbb');
  /**
   * LA SPA EST REVENUE À SA PLACE. Sans rétablissement, on servirait
   * l'interface d'hier à l'API d'aujourd'hui — le pire des deux mondes.
   */
  check('LA SPA A ÉTÉ RÉTABLIE',
    disque.read(`${SITE}/${APP}/index.html`).includes('bbbbbbb'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. Adaptateurs historiques — le vocabulaire tient, le mécanisme est réel');
{
  const disque = makeFs();
  deployer(disque, 'aaaaaaa');
  deployer(disque, 'bbbbbbb');
  const { tx } = makeTransport(disque);

  const liste = await listReleases(tx, ARGS);
  check('listReleases rend les versions réellement présentes',
    JSON.stringify(liste) === JSON.stringify(['bbbbbbb', 'aaaaaaa']));
  check('currentRelease rend la version servie',
    (await currentRelease(tx, ARGS)) === 'bbbbbbb');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. GARDE-FOUS — le pipeline doit continuer de préparer le retour');
{
  const pipeline = fs.readFileSync(
    path.join(racine, 'backend/src/deployment-engine/pipeline.js'), 'utf8',
  );

  /**
   * SANS CECI, IL N'Y A RIEN VERS QUOI REVENIR. Le backend était uploadé
   * directement par-dessus la version en place : aucun `.prev` n'existait, et
   * le rollback n'avait aucune cible. C'est le défaut que R10.2 a fermé, et
   * c'est le premier à pouvoir se rouvrir sans qu'on s'en aperçoive.
   */
  check('le backend est uploadé dans un `.next`',
    /backendNext\s*=\s*`\$\{backendDir\}\.next`/.test(pipeline)
    && /uploadDir\(artifact\.backendDir,\s*backendNext\)/.test(pipeline));
  check('…et il figure dans la bascule, avec son `.prev`',
    /\{\s*target:\s*backendDir,\s*next:\s*backendNext,\s*prev:\s*backendPrev\s*\}/.test(pipeline));
  check('la bascule met l’ancienne version de côté',
    /if \[ -d \$\{s\.target\} \]; then mv \$\{s\.target\} \$\{s\.prev\}; fi/.test(pipeline));

  const rollbackBrut = fs.readFileSync(
    path.join(racine, 'backend/src/deployment-engine/rollback.js'), 'utf8',
  );
  /**
   * LA GARDE LIT LE CODE, PAS LA PROSE. Ce fichier EXPLIQUE longuement le
   * mécanisme `releases/` qu'il a remplacé — une garde naïve rougirait sur la
   * documentation de l'interdit qu'elle défend, et quelqu'un supprimerait le
   * commentaire pour faire passer le test.
   */
  const rollback = rollbackBrut
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** Le mécanisme fictif ne doit pas revenir par la porte de derrière. */
  check('le rollback ne construit plus de chemin `releases/`', !/releases\//.test(rollback));
  check('…ni de lien `current`', !/currentLink/.test(rollback));
  check('…et n’appelle plus `readlink -f`', !/readlink -f/.test(rollback));
  check('l’échange est bien son propre inverse',
    /mv \$\{slot\.target\} \$\{tmp\}[\s\S]*mv \$\{slot\.prev\} \$\{slot\.target\}[\s\S]*mv \$\{tmp\} \$\{slot\.prev\}/
      .test(rollback));
  check('les emplacements viennent de la topologie, jamais codés en dur',
    /planTopology\(/.test(rollback));
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
