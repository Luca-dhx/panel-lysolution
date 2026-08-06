/**
 * RETRAIT D'UNE DESTINATION — l'opération inverse du déploiement.
 *
 * ══ LE DÉFAUT CORRIGÉ ═══════════════════════════════════════════════════════
 *
 * Supprimer la fiche d'une destination ne retirait RIEN du serveur. Après le
 * déménagement de `panel.lycarz.com` vers `panel.ly-solution.com`, sont restés
 * derrière : un process PM2 en ligne qui DÉTENAIT le port applicatif, sa
 * configuration Nginx toujours activée, et 49 Mo de fichiers. La fiche
 * disparue, l'allocation de port a recyclé le même numéro pour la destination
 * suivante : l'ancien backend le tenait, le nouveau bouclait sur EADDRINUSE —
 * plus de 7 000 redémarrages — et Nginx envoyait le nouveau domaine vers
 * l'ANCIEN code.
 *
 * Une fiche n'est donc pas la destination : elle la DÉCRIT. Tant que le
 * serveur porte encore le service, le port, le routage et les fichiers, la
 * destination existe. La supprimer avant de l'avoir vidée, c'est perdre la
 * seule trace de ce qu'il reste à nettoyer.
 *
 * ══ LE CYCLE ════════════════════════════════════════════════════════════════
 *
 *   ACTIVE → DEPROVISIONING → EMPTY → (suppression logique de la fiche)
 *                  ↓
 *          DEPROVISION_FAILED  (reprenable : on relance depuis le début, les
 *                               étapes déjà faites sont sans effet)
 *
 * Chaque étape est IDEMPOTENTE : la relancer sur une destination à moitié
 * retirée ne casse rien. C'est ce qui rend la reprise après interruption sûre
 * sans état intermédiaire à mémoriser.
 *
 * ══ CE QUE CE MODULE NE FAIT JAMAIS ═════════════════════════════════════════
 *
 *   · supprimer un chemin qu'il n'a pas VALIDÉ canoniquement, forme ET
 *     résolution réelle sur le serveur ;
 *   · suivre un lien symbolique sortant ;
 *   · effacer une donnée persistante (`shared/uploads`, `shared/storage`) sans
 *     confirmation EXPLICITE de l'appelant ;
 *   · laisser un domaine retomber sur le `default_server` de Nginx — la
 *     quarantaine 410 est posée AVANT la suppression des fichiers.
 *
 * Le module ne dépend que du Transport : il est vérifiable de bout en bout
 * avec un FakeTransport, sans VPS.
 */
import { DeploymentError } from './errors.js';
import { planTopology } from './topology.js';
import { nginxConfigPath, nginxEnabledPath } from './nginx.js';
import { serviceName } from './config/project.profile.js';

/**
 * Étapes du retrait, dans l'ordre d'exécution. Identités STABLES : elles
 * alimentent la checklist de l'interface, l'historique et le rapport.
 */
export const DEPROVISION_STEPS = Object.freeze([
  Object.freeze({ id: 'deprovision.lock', label: 'Verrouillage de la destination', critical: true }),
  Object.freeze({ id: 'deprovision.inventory', label: 'Inventaire du serveur', critical: true }),
  Object.freeze({ id: 'deprovision.services.stop', label: 'Arrêt du service applicatif', critical: true }),
  Object.freeze({ id: 'deprovision.services.verify', label: 'Vérification de l’arrêt', critical: true }),
  Object.freeze({ id: 'deprovision.port.release', label: 'Libération du port', critical: true }),
  Object.freeze({ id: 'deprovision.nginx.remove', label: 'Retrait du routage applicatif', critical: true }),
  Object.freeze({ id: 'deprovision.quarantine', label: 'Installation de la quarantaine (410)', critical: true }),
  Object.freeze({ id: 'deprovision.files.remove', label: 'Suppression des fichiers', critical: true }),
  Object.freeze({ id: 'deprovision.verify', label: 'Vérification finale', critical: true }),
  Object.freeze({ id: 'deprovision.finalize', label: 'Destination vidée', critical: false }),
]);

export const DEPROVISION_STEP_IDS = Object.freeze(DEPROVISION_STEPS.map((s) => s.id));

/**
 * Chemins qui ne doivent JAMAIS être supprimés, quelle que soit la fiche qui
 * les désigne. Un `siteRoot` mal renseigné, une racine distante erronée, une
 * fiche importée : la garde ne dépend pas de la qualité de la donnée d'entrée.
 */
export const NEVER_DELETE = Object.freeze([
  '/',
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/opt', '/proc', '/root',
  '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var',
  '/var/www',
  '/var/www/html',
  '/var/www/certbot',
]);

/** Forme d'un chemin de déploiement acceptable. Volontairement étroite. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * VALIDATION CANONIQUE DE LA FORME d'un `siteRoot`, avant toute commande.
 *
 * On refuse plutôt que de nettoyer : nettoyer un chemin douteux masquerait
 * l'anomalie qui l'a produit, et transformerait une erreur de donnée en
 * suppression silencieuse d'autre chose.
 *
 * @param {string} siteRoot
 * @param {object} args
 * @param {string} args.remoteRoot  Racine des déploiements (ex. /var/www).
 * @param {string} args.host        Hôte de la destination.
 * @param {string[]} [args.protectedPaths] Chemins supplémentaires à protéger.
 * @returns {string} le chemin normalisé (sans slash final)
 */
export function assertSafeSiteRoot(siteRoot, { remoteRoot, host, protectedPaths = [] } = {}) {
  const refuse = (raison, details = {}) => {
    throw new DeploymentError('UNSAFE_SITE_ROOT', `Suppression refusée : ${raison}`, {
      step: 'deprovision.files.remove',
      details: { siteRoot, remoteRoot, host, ...details },
    });
  };

  if (typeof siteRoot !== 'string' || siteRoot.trim().length === 0) refuse('chemin vide.');
  if (typeof remoteRoot !== 'string' || !remoteRoot.startsWith('/')) refuse('racine distante invalide.');
  if (typeof host !== 'string' || host.trim().length === 0) refuse('hôte de destination absent.');

  const clean = siteRoot.trim().replace(/\/+$/, '');
  const root = remoteRoot.trim().replace(/\/+$/, '');

  if (!clean.startsWith('/')) refuse('chemin relatif refusé.');
  if (/\/\//.test(siteRoot)) refuse('séparateur doublé.');
  if (clean.split('/').includes('..')) refuse('remontée de répertoire refusée.');
  if (!/^[A-Za-z0-9_./-]+$/.test(clean)) refuse('caractère interdit dans le chemin.');

  const interdits = new Set([...NEVER_DELETE, ...protectedPaths].map((p) => p.replace(/\/+$/, '')));
  if (interdits.has(clean)) refuse(`chemin protégé (${clean}).`);
  if (clean === root) refuse('le chemin est la racine des déploiements elle-même.');
  if (!clean.startsWith(`${root}/`)) refuse(`chemin hors de la racine des déploiements (${root}).`);

  // Le chemin doit être EXACTEMENT celui que la topologie dérive de l'hôte.
  // Toute autre valeur signifie que la fiche et le serveur ne parlent pas de
  // la même chose — et l'on ne supprime pas sur un désaccord.
  const attendu = `${root}/${String(host).toLowerCase()}`;
  if (clean !== attendu) refuse(`chemin inattendu (attendu ${attendu}).`);

  const reste = clean.slice(root.length + 1);
  if (!reste.split('/').every((segment) => SAFE_SEGMENT.test(segment))) {
    refuse('segment de chemin non conforme.');
  }
  return clean;
}

/** Rend la configuration Nginx de QUARANTAINE : 410 Gone sur chaque hôte. */
export function renderNginxQuarantine(hosts, { host } = {}) {
  const liste = [...new Set((hosts ?? []).filter(Boolean))];
  if (liste.length === 0) {
    throw new DeploymentError('QUARANTINE_NO_HOST', 'Quarantaine impossible : aucun hôte à neutraliser.', {
      step: 'deprovision.quarantine',
    });
  }
  return `# Généré par DeploymentEngine — QUARANTAINE de ${host ?? liste[0]}
# Hôtes neutralisés : ${liste.join(', ')}
# NE PAS éditer à la main.
#
# POURQUOI 410 ET NON UNE ABSENCE DE CONFIGURATION.
# Retirer purement la configuration ferait retomber ces noms sur le
# « default_server » du serveur : le visiteur recevrait le site d'un AUTRE
# projet, ou une page d'accueil Nginx, sans jamais apprendre que l'adresse
# n'existe plus. Un 410 Gone dit la vérité — définitivement, aux navigateurs
# comme aux moteurs d'indexation — et empêche toute fuite entre projets.
#
# Le bloc ACME reste servi : un certificat encore référencé ailleurs doit
# pouvoir être renouvelé sans exhumer la destination.
server {
    listen 80;
    listen [::]:80;
    server_name ${liste.join(' ')};

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    location / {
        add_header Cache-Control "no-store" always;
        return 410;
    }
}
`;
}

/** Chemin de la configuration de quarantaine d'un hôte. */
export function quarantineConfigPath(host) {
  return `/etc/nginx/sites-available/${host}.gone.conf`;
}

/** Chemin du lien actif de la quarantaine. */
export function quarantineEnabledPath(host) {
  return `/etc/nginx/sites-enabled/${host}.gone.conf`;
}

/** Nginx accepte-t-il la configuration en place ? */
async function nginxTestOk(transport) {
  const test = await transport.exec('sudo nginx -t 2>&1');
  const sortie = `${test.stdout ?? ''}${test.stderr ?? ''}`;
  return /syntax is ok/i.test(sortie) && /test is successful/i.test(sortie);
}

async function reloadNginx(transport) {
  await transport.exec('sudo systemctl reload nginx || sudo nginx -s reload');
}

/**
 * Installe la QUARANTAINE 410 sur les hôtes d'une destination, en retirant au
 * passage sa configuration applicative.
 *
 * L'ordre compte : on écrit la quarantaine, on retire l'applicative, on teste,
 * puis on recharge. Si le test échoue, on retire la quarantaine et l'on
 * s'arrête — Nginx doit rester rechargeable pour TOUS les autres sites du
 * serveur.
 */
export async function applyQuarantine(transport, { host, hosts }) {
  const contenu = renderNginxQuarantine(hosts ?? [host], { host });
  const tmp = `/tmp/${host}.gone.conf`;
  const conf = quarantineConfigPath(host);
  const lien = quarantineEnabledPath(host);

  await transport.writeFile(tmp, contenu);
  await transport.exec(`sudo mv ${tmp} ${conf}`);
  // La configuration APPLICATIVE part au même moment : deux blocs `server`
  // portant le même `server_name` feraient gagner le premier chargé — donc,
  // possiblement, l'ancien site.
  await transport.exec(`sudo rm -f ${nginxEnabledPath(host)}`);
  await transport.exec(`sudo ln -sf ${conf} ${lien}`);

  if (!(await nginxTestOk(transport))) {
    await transport.exec(`sudo rm -f ${lien}`).catch(() => {});
    throw new DeploymentError('QUARANTINE_CONFIG_INVALID',
      'La configuration de quarantaine est refusée par Nginx.', {
        step: 'deprovision.quarantine', details: { conf },
      });
  }
  await reloadNginx(transport);
  return { configPath: conf, enabledPath: lien, hosts: [...new Set(hosts ?? [host])] };
}

/**
 * LÈVE la quarantaine — uniquement au moment où la fiche disparaît pour de
 * bon. Tant qu'elle existe, le 410 est ce que la destination doit répondre.
 */
export async function removeQuarantine(transport, { host }) {
  const lien = quarantineEnabledPath(host);
  const conf = quarantineConfigPath(host);
  await transport.exec(`sudo rm -f ${lien}`);
  await transport.exec(`sudo rm -f ${conf}`);
  if (!(await nginxTestOk(transport))) {
    throw new DeploymentError('NGINX_CONFIG_INVALID',
      'Nginx refuse sa configuration après le retrait de la quarantaine.', {
        step: 'quarantine.release', details: { conf },
      });
  }
  await reloadNginx(transport);
  return { removed: [lien, conf] };
}

/** Retire la configuration APPLICATIVE (sites-available + sites-enabled). */
export async function removeApplicationSite(transport, { host }) {
  const lien = nginxEnabledPath(host);
  const conf = nginxConfigPath(host);
  await transport.exec(`sudo rm -f ${lien}`);
  await transport.exec(`sudo rm -f ${conf}`);
  return { removed: [lien, conf] };
}

/** Liste PM2 lue et analysée, ou `[]` si illisible. */
async function pm2List(transport) {
  const res = await transport.exec('pm2 jlist 2>/dev/null || echo "[]"');
  try {
    const liste = JSON.parse(res.stdout || '[]');
    return Array.isArray(liste) ? liste : [];
  } catch {
    return [];
  }
}

/**
 * INVENTAIRE de ce que la destination occupe RÉELLEMENT sur le serveur.
 *
 * Aucune écriture. C'est ce que l'opérateur doit voir avant de confirmer, et
 * ce sur quoi les gardes de sécurité se prononcent.
 */
export async function inspectDestination(transport, { host, remoteRoot = '/var/www', port, profile } = {}) {
  const topo = planTopology({ host, remoteRoot, profile });
  const siteRoot = topo.siteRoot;
  const name = serviceName(host);

  const lire = async (commande, defaut = '') => {
    const res = await transport.exec(commande).catch(() => null);
    return (res?.stdout ?? defaut).trim();
  };

  const exists = (await lire(`test -d ${siteRoot} && echo OUI || echo NON`)) === 'OUI';
  const resolved = exists ? await lire(`readlink -f ${siteRoot} 2>/dev/null || echo ABSENT`) : null;
  const size = exists ? await lire(`du -sh ${siteRoot} 2>/dev/null | cut -f1`) : null;
  const files = exists ? Number(await lire(`find ${siteRoot} -type f 2>/dev/null | wc -l`, '0')) : 0;
  const uploads = exists ? Number(await lire(`find ${topo.sharedUploads} -type f 2>/dev/null | wc -l`, '0')) : 0;
  const storage = exists ? Number(await lire(`find ${topo.sharedRoot}/storage -type f 2>/dev/null | wc -l`, '0')) : 0;

  // Liens sortants : ce que le serveur RÉSOUT, pas ce que la fiche suppose.
  const liensBruts = exists
    ? await lire(`find ${siteRoot} -type l -exec readlink -f {} \\; 2>/dev/null | sort -u`)
    : '';
  const outboundSymlinks = liensBruts.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => l !== siteRoot && !l.startsWith(`${siteRoot}/`));

  const processes = await pm2List(transport);
  const own = processes.find((p) => p?.name === name) ?? null;

  const portLine = port ? await lire(`ss -ltnp 2>/dev/null | grep ':${port} ' || echo LIBRE`) : 'LIBRE';
  const portFree = portLine === 'LIBRE' || portLine === '';

  return {
    host,
    siteRoot,
    sharedUploads: topo.sharedUploads,
    sharedStorage: `${topo.sharedRoot}/storage`,
    servedHosts: topo.servedHosts,
    pm2Name: name,
    exists,
    resolvedPath: resolved,
    size: size || null,
    files,
    persistentFiles: uploads + storage,
    uploads,
    storage,
    outboundSymlinks,
    pm2: own
      ? {
        present: true,
        pid: own.pid ?? null,
        status: own.pm2_env?.status ?? null,
        execPath: own.pm2_env?.pm_exec_path ?? null,
        restarts: own.pm2_env?.restart_time ?? null,
      }
      : { present: false },
    port: port ?? null,
    portFree,
    portHolder: portFree ? null : portLine.replace(/\s+/g, ' ').slice(0, 200),
  };
}

/**
 * RETRAIT COMPLET d'une destination.
 *
 * @param {object} args
 * @param {import('./transport/Transport.js').Transport} args.transport
 * @param {string} args.host          Hôte de la destination.
 * @param {string} [args.remoteRoot]  Racine des déploiements.
 * @param {number} [args.port]        Port applicatif à libérer.
 * @param {object} [args.profile]     Profil de topologie (injectable).
 * @param {boolean} [args.removePersistentData] Autorise la perte de
 *        `shared/uploads` et `shared/storage`. FAUX par défaut : sans cette
 *        confirmation, une destination porteuse de données métier est REFUSÉE.
 * @param {string[]} [args.protectedPaths] Chemins d'autres projets à protéger.
 * @param {(evt:object)=>void} [args.onStep]
 * @returns {Promise<{ok:boolean, steps:object[], failedStep:string|null, inventory:object|null, error?:object}>}
 */
export async function runDeprovision({
  transport, host, remoteRoot = '/var/www', port = null, profile,
  removePersistentData = false, protectedPaths = [], onStep = () => {},
}) {
  const steps = [];
  let failedStep = null;
  let inventory = null;

  const step = async (id, fn) => {
    const meta = DEPROVISION_STEPS.find((s) => s.id === id) ?? { id, label: id };
    const debut = clock();
    onStep({ step: id, label: meta.label, status: 'running' });
    try {
      const detail = await fn();
      const done = { step: id, label: meta.label, status: 'ok', durationMs: clock() - debut, detail: detail ?? null };
      steps.push(done);
      onStep({ ...done });
      return detail;
    } catch (err) {
      const failed = {
        step: id, label: meta.label, status: 'error', durationMs: clock() - debut,
        error: { code: err.code || 'ERROR', message: err.message },
      };
      steps.push(failed);
      onStep({ ...failed });
      failedStep = id;
      throw err;
    }
  };

  try {
    const topo = planTopology({ host, remoteRoot, profile });
    const pm2Name = serviceName(host);

    // 1. VERROU — la forme du chemin est validée AVANT toute commande. Une
    //    fiche incohérente est refusée sans que rien n'ait été touché.
    const siteRoot = await step('deprovision.lock', async () => {
      const valide = assertSafeSiteRoot(topo.siteRoot, { remoteRoot, host, protectedPaths });
      return { siteRoot: valide, pm2Name, servedHosts: topo.servedHosts };
    }).then((d) => d.siteRoot);

    // 2. INVENTAIRE — puis les refus qui en découlent. On ne supprime pas ce
    //    qu'on n'a pas regardé.
    inventory = await step('deprovision.inventory', async () => {
      const inv = await inspectDestination(transport, { host, remoteRoot, port, profile });

      if (inv.exists && inv.resolvedPath && inv.resolvedPath !== siteRoot) {
        throw new DeploymentError('SITE_ROOT_RESOLVES_ELSEWHERE',
          `Le chemin ${siteRoot} résout vers ${inv.resolvedPath} sur le serveur.`, {
            step: 'deprovision.inventory', details: { siteRoot, resolved: inv.resolvedPath },
          });
      }
      if (inv.outboundSymlinks.length > 0) {
        throw new DeploymentError('OUTBOUND_SYMLINK',
          `Lien(s) symbolique(s) pointant hors de la destination : ${inv.outboundSymlinks.join(', ')}.`, {
            step: 'deprovision.inventory', details: { outboundSymlinks: inv.outboundSymlinks },
          });
      }
      if (inv.persistentFiles > 0 && removePersistentData !== true) {
        throw new DeploymentError('DEPROVISION_PERSISTENT_DATA',
          `${inv.persistentFiles} fichier(s) persistant(s) sous shared/ (uploads : ${inv.uploads}, storage : ${inv.storage}). `
          + 'Le retrait ne détruit aucune donnée métier sans confirmation explicite.', {
            step: 'deprovision.inventory',
            details: { uploads: inv.uploads, storage: inv.storage, sharedUploads: inv.sharedUploads },
          });
      }
      return inv;
    });

    // 3. ARRÊT PUIS SUPPRESSION DU PROCESS. `stop` puis `delete` : supprimer
    //    sans arrêter laisserait, sur certaines versions de PM2, un processus
    //    orphelin détenant toujours le port.
    await step('deprovision.services.stop', async () => {
      await transport.exec(`pm2 stop ${pm2Name} >/dev/null 2>&1 || true`);
      await transport.exec(`pm2 delete ${pm2Name} >/dev/null 2>&1 || true`);
      await transport.exec('pm2 save >/dev/null 2>&1 || true');
      return { pm2Name, stopped: true };
    });

    // 4. PREUVE que le process a bien disparu — on relit PM2 plutôt que de
    //    croire un code de sortie masqué par `|| true`.
    await step('deprovision.services.verify', async () => {
      const restants = await pm2List(transport);
      const encore = restants.find((p) => p?.name === pm2Name);
      if (encore) {
        throw new DeploymentError('PM2_PROCESS_STILL_PRESENT',
          `Le process PM2 « ${pm2Name} » est toujours déclaré après suppression.`, {
            step: 'deprovision.services.verify',
            details: { pm2Name, status: encore.pm2_env?.status ?? null, pid: encore.pid ?? null },
          });
      }
      return { pm2Name, absent: true };
    });

    // 5. LIBÉRATION DU PORT — vérifiée sur les sockets réelles, pas sur PM2.
    //    Un port encore détenu signifie qu'un autre processus l'occupe : on
    //    s'arrête plutôt que de laisser croire qu'il est libre.
    await step('deprovision.port.release', async () => {
      if (!port) return { skipped: true, reason: 'aucun port applicatif déclaré' };
      const res = await transport.exec(`ss -ltnp 2>/dev/null | grep ':${port} ' || echo LIBRE`);
      const ligne = (res.stdout ?? '').trim();
      if (ligne !== 'LIBRE' && ligne !== '') {
        throw new DeploymentError('PORT_STILL_HELD',
          `Le port ${port} est encore détenu après l'arrêt du service.`, {
            step: 'deprovision.port.release',
            details: { port, holder: ligne.replace(/\s+/g, ' ').slice(0, 200) },
          });
      }
      return { port, released: true };
    });

    // 6. RETRAIT DU ROUTAGE APPLICATIF.
    await step('deprovision.nginx.remove', async () => removeApplicationSite(transport, { host }));

    // 7. QUARANTAINE 410 — posée AVANT la suppression des fichiers. Entre les
    //    deux, le domaine ne doit à aucun moment retomber sur un autre site.
    await step('deprovision.quarantine', async () =>
      applyQuarantine(transport, { host, hosts: topo.servedHosts }));

    // 8. SUPPRESSION DES FICHIERS — sur le chemin VALIDÉ, jamais sur une
    //    valeur recomposée ici.
    await step('deprovision.files.remove', async () => {
      const verrou = assertSafeSiteRoot(siteRoot, { remoteRoot, host, protectedPaths });
      // `test -d` avant `rm -rf` : une destination déjà vidée doit produire un
      // retrait « déjà fait », pas une commande destructive de plus.
      const present = await transport.exec(`test -d ${verrou} && echo OUI || echo NON`);
      if ((present.stdout ?? '').trim() !== 'OUI') {
        return { siteRoot: verrou, alreadyAbsent: true };
      }
      await transport.exec(`rm -rf ${verrou}`);
      return { siteRoot: verrou, removed: true, files: inventory?.files ?? null, size: inventory?.size ?? null };
    });

    // 9. VÉRIFICATION FINALE — plus de fichiers, plus de process, plus de
    //    routage applicatif. C'est cette étape, et elle seule, qui autorise
    //    l'état EMPTY.
    const verification = await step('deprovision.verify', async () => {
      const reste = await transport.exec(`test -d ${siteRoot} && echo OUI || echo NON`);
      const dossierPresent = (reste.stdout ?? '').trim() === 'OUI';
      const restants = await pm2List(transport);
      const processPresent = restants.some((p) => p?.name === pm2Name);
      const conf = await transport.exec(`test -e ${nginxEnabledPath(host)} && echo OUI || echo NON`);
      const routagePresent = (conf.stdout ?? '').trim() === 'OUI';

      const anomalies = [
        dossierPresent ? `le dossier ${siteRoot} existe encore` : null,
        processPresent ? `le process PM2 « ${pm2Name} » est encore déclaré` : null,
        routagePresent ? 'la configuration Nginx applicative est encore active' : null,
      ].filter(Boolean);
      if (anomalies.length > 0) {
        throw new DeploymentError('DEPROVISION_INCOMPLETE',
          `Le retrait n'est pas complet : ${anomalies.join(' · ')}.`, {
            step: 'deprovision.verify', details: { anomalies },
          });
      }
      return { siteRootAbsent: true, pm2Absent: true, applicationRoutingRemoved: true };
    });

    await step('deprovision.finalize', async () => ({
      host, siteRoot, pm2Name, port: port ?? null, quarantine: true,
    }));

    return { ok: true, steps, failedStep: null, inventory, verification };
  } catch (err) {
    return {
      ok: false,
      steps,
      failedStep,
      inventory,
      error: { code: err.code || 'ERROR', message: err.message, details: err.details ?? null },
    };
  }
}

function clock() {
  // Monotone, disponible partout — jamais Date.now pour une durée.
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export default {
  DEPROVISION_STEPS,
  DEPROVISION_STEP_IDS,
  NEVER_DELETE,
  assertSafeSiteRoot,
  renderNginxQuarantine,
  quarantineConfigPath,
  quarantineEnabledPath,
  applyQuarantine,
  removeQuarantine,
  removeApplicationSite,
  inspectDestination,
  runDeprovision,
};
