/**
 * Gestion du process backend via PM2.
 *
 * Chaque cible fait tourner une instance backend nommée de façon déterministe
 * (`<slug>-<host>`, le slug venant du profil de projet) sur un port local
 * dédié. On (re)démarre l'app, on persiste la liste PM2 (survie au reboot).
 */
import { serviceName } from './config/project.profile.js';

/** Nom PM2 déterministe d'une cible. */
export function pm2AppName(host) {
  return serviceName(host);
}

/**
 * Le chemin que PM2 exécute RÉELLEMENT pour un process donné.
 *
 * PM2 mémorise `pm_exec_path` au tout premier `start`. Ni `reload` ni
 * `restart` ne le recalculent : ils relancent le fichier enregistré.
 *
 * @returns {null|{execPath:string|null, cwd:string|null}} null si absent de PM2.
 */
export function readPm2Location(jlistStdout, name) {
  let liste = [];
  try { liste = JSON.parse(jlistStdout || '[]'); } catch { return null; }
  if (!Array.isArray(liste)) return null;
  const p = liste.find((x) => x?.name === name);
  if (!p) return null;
  return {
    execPath: p.pm2_env?.pm_exec_path ?? p.pm_exec_path ?? null,
    cwd: p.pm2_env?.pm_cwd ?? p.pm_cwd ?? null,
  };
}

/**
 * (Re)démarre le backend d'une cible sous PM2.
 *
 * ── LE DÉFAUT CORRIGÉ ───────────────────────────────────────────────────────
 * L'étape faisait `cd <backendDir> && pm2 reload <name>`. Le `cd` n'a AUCUN
 * effet sur le fichier relancé : PM2 exécute le chemin qu'il a mémorisé au
 * premier démarrage. Si ce chemin n'est plus celui où le déploiement écrit —
 * projet redéployé sous un autre domaine, racine changée, process créé à la
 * main — alors chaque déploiement suivant relance ÉTERNELLEMENT l'ancien code.
 *
 * Et il le fait en silence : le rechargement rend 0, l'ancien backend répond,
 * donc le contrôle de service et la vérification publique passent. Seul le
 * frontend est réellement mis à jour, puisque nginx sert ses fichiers
 * directement. On obtient une version publiée où l'interface est neuve et
 * l'API vieille de plusieurs semaines — sans le moindre signal.
 *
 * Constaté en production : une route ajoutée le jour même répondait
 * « Route inconnue » après deux déploiements verts consécutifs.
 *
 * On compare donc le chemin mémorisé par PM2 à celui où l'on vient d'écrire.
 * S'ils diffèrent, on SUPPRIME le process et on le recrée : c'est le seul
 * moyen de faire oublier un chemin à PM2.
 *
 * @param {object} args
 * @param {string} args.host        Hôte de la cible (nommage PM2).
 * @param {string} args.backendDir  Dossier backend déployé sur le VPS.
 * @param {number} args.port        Port local d'écoute.
 * @param {'PROD'|'TEST'} args.env  ENV applicatif (PROD par défaut en déploiement).
 * @returns {Promise<{name:string, action:'start'|'reload'|'recreate', previousPath:string|null}>}
 */
export async function restartBackend(transport, { host, backendDir, port, env = 'PROD' }) {
  const name = pm2AppName(host);
  const attendu = `${backendDir}/src/server.js`;

  const list = await transport.exec(`pm2 jlist 2>/dev/null || echo '[]'`);
  const emplacement = readPm2Location(list.stdout, name);

  // Le chemin mémorisé est-il bien celui où l'on vient d'écrire ? Les deux
  // formes sont acceptées : PM2 normalise différemment selon les versions.
  const memeChemin = emplacement !== null
    && [emplacement.execPath, emplacement.cwd].some((v) => {
      if (!v) return false;
      const norm = String(v).replace(/\\/g, '/').replace(/\/+$/, '');
      return norm === attendu || norm === backendDir;
    });

  let action;
  let commande;
  if (emplacement === null) {
    action = 'start';
    commande = `cd ${backendDir} && PORT=${port} ENV=${env} pm2 start src/server.js --name ${name} --update-env`;
  } else if (memeChemin) {
    action = 'reload';
    commande = `cd ${backendDir} && PORT=${port} ENV=${env} pm2 reload ${name} --update-env`;
  } else {
    // PM2 pointe ailleurs. Recharger relancerait l'ancien fichier : on efface
    // la définition et on la recrée sur le dossier réellement déployé.
    action = 'recreate';
    commande = `pm2 delete ${name} >/dev/null 2>&1; cd ${backendDir} && PORT=${port} ENV=${env} pm2 start src/server.js --name ${name} --update-env`;
  }

  const res = await transport.exec(commande, { timeoutMs: 60_000 });
  if (res.code !== 0) {
    const { DeploymentError } = await import('./errors.js');
    throw new DeploymentError('PM2_RESTART_FAILED', `Échec du (re)démarrage PM2 de ${name}.`, {
      step: 'pm2',
      details: { action, output: (res.stderr || res.stdout).slice(0, 500) },
    });
  }

  /**
   * PREUVE APRÈS COUP — on relit PM2 plutôt que de croire le code de sortie.
   *
   * C'est précisément la vérification qui manquait : le rechargement rendait 0
   * en relançant un autre fichier. Un déploiement ne peut pas se déclarer
   * réussi sans avoir constaté QUEL fichier tourne.
   */
  const apres = await transport.exec(`pm2 jlist 2>/dev/null || echo '[]'`);
  const final = readPm2Location(apres.stdout, name);
  const conforme = final !== null
    && [final.execPath, final.cwd].some((v) => {
      if (!v) return false;
      const norm = String(v).replace(/\\/g, '/').replace(/\/+$/, '');
      return norm === attendu || norm === backendDir;
    });
  if (!conforme) {
    const { DeploymentError } = await import('./errors.js');
    throw new DeploymentError('PM2_STALE_PATH', `PM2 exécute un autre fichier que celui déployé pour ${name}.`, {
      step: 'pm2',
      details: { expected: attendu, running: final?.execPath ?? null, cwd: final?.cwd ?? null, action },
    });
  }

  await transport.exec('pm2 save');
  return { name, action, previousPath: emplacement?.execPath ?? null };
}

export default { restartBackend, pm2AppName, readPm2Location };
