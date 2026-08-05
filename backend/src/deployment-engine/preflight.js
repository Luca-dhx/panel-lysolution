/**
 * PRÉFLIGHT — contrôles AVANT tout déploiement.
 *
 * Règle du cahier des charges : « Ne jamais faire un demi-déploiement. » Si un
 * contrôle bloquant échoue, on refuse complètement le déploiement.
 *
 * Chaque contrôle retourne { id, label, ok, required, detail }. Le préflight
 * global échoue dès qu'un contrôle `required` est en échec.
 *
 * Le préflight parle au VPS UNIQUEMENT via le Transport (donc testable sans
 * serveur). Les contrôles DNS utilisent le module dns (réseau local au backend).
 */
import { parseTargetUrl } from './url.js';
import { certPaths } from './nginx.js';
import { checkDomainPointsToVps, resolveVpsIp } from './dns.js';

/**
 * Petite fabrique de résultat de contrôle.
 *
 * `scope: 'remote'` : TOUS les contrôles de ce module portent sur le SERVEUR
 * cible et exigent un transport. Les prérequis de la machine qui pilote
 * (source Git…) vivent dans `localPreflight.js` et portent `scope: 'local'`.
 * La distinction remonte jusqu'à l'interface : l'opérateur sait immédiatement
 * s'il doit agir sur sa machine ou sur l'infrastructure.
 */
function check(id, label, ok, { required = true, detail = null } = {}) {
  return { id, label, ok: Boolean(ok), required, detail, scope: 'remote' };
}

/**
 * Décrit précisément une erreur SSH (ssh2) pour le rapport : cause probable +
 * message brut. Ne révèle jamais de secret (le message ssh2 n'en contient pas).
 */
export function describeSshError(err) {
  const msg = (err && (err.message || String(err))) || 'connexion impossible';
  const code = err && err.code ? String(err.code) : '';
  const lower = `${code} ${msg}`.toLowerCase();
  let cause = '';
  if (lower.includes('econnrefused')) cause = 'connexion refusée (SSH injoignable sur ce port)';
  else if (lower.includes('etimedout') || lower.includes('timed out') || lower.includes('timeout')) cause = 'délai dépassé (hôte/port injoignable ou pare-feu)';
  else if (lower.includes('ehostunreach') || lower.includes('enetunreach')) cause = 'hôte injoignable (adresse/réseau)';
  else if (lower.includes('enotfound') || lower.includes('getaddrinfo')) cause = 'adresse serveur introuvable (DNS)';
  else if (lower.includes('authentication') || lower.includes('permission denied')) cause = 'authentification refusée (identifiants ou connexion par mot de passe désactivée)';
  else if (lower.includes('handshake')) cause = 'échec de la négociation SSH';
  return (cause ? `${cause} — ` : '') + msg.slice(0, 280);
}

/** `command -v X` : l'outil X est-il présent sur le VPS ? */
async function hasCommand(transport, bin) {
  const res = await transport.exec(`command -v ${bin} >/dev/null 2>&1 && echo OK || echo NO`);
  return res.stdout.trim().endsWith('OK');
}

/**
 * Exécute la batterie de contrôles préflight.
 *
 * @param {object} args
 * @param {import('./transport/Transport.js').Transport} args.transport
 * @param {string} args.url            URL complète de la cible.
 * @param {string} args.sshHost        Hôte SSH du VPS (pour résoudre son IP).
 * @param {string} [args.remoteRoot]   Racine de déploiement (test de permissions).
 * @param {string[]} [args.wildcardBases]
 * @returns {Promise<{ok:boolean, target:object, checks:object[], failedChecks:object[]}>}
 */
export async function runPreflight({
  transport,
  url,
  sshHost,
  remoteRoot = '/var/www',
  wildcardBases,
  skipDnsCheck = false,
}) {
  const target = parseTargetUrl(url, { wildcardBases });
  const checks = [];

  // 1. Connexion + authentification VPS : une commande triviale doit réussir.
  // En cas d'échec on remonte l'ERREUR EXACTE (message ssh2 : ECONNREFUSED,
  // timeout, "All configured authentication methods failed"…) afin que le
  // rapport permette d'identifier précisément la cause.
  let sshOk = false;
  try {
    const who = await transport.exec('id -un');
    sshOk = who.code === 0 && who.stdout.trim().length > 0;
    const detail = sshOk
      ? who.stdout.trim()
      : (who.stderr || '').trim().slice(0, 300) || `commande terminée avec le code ${who.code}`;
    checks.push(check('ssh', 'Connexion & authentification VPS', sshOk, { detail }));
  } catch (err) {
    const detail = describeSshError(err);
    checks.push(check('ssh', 'Connexion & authentification VPS', false, { detail }));
  }

  // Si le SSH ne répond pas, inutile de tester le reste côté serveur.
  if (!sshOk) {
    const failed = checks.filter((c) => c.required && !c.ok);
    return { ok: false, target, checks, failedChecks: failed };
  }

  // 2. Outils système requis.
  const [hasNginx, hasCertbot, hasPm2, hasNode, hasMongo] = await Promise.all([
    hasCommand(transport, 'nginx'),
    hasCommand(transport, 'certbot'),
    hasCommand(transport, 'pm2'),
    hasCommand(transport, 'node'),
    hasCommand(transport, 'mongod').then((v) => v || hasCommand(transport, 'mongosh')),
  ]);
  checks.push(check('nginx', 'Nginx installé', hasNginx));
  checks.push(check('node', 'Node.js installé', hasNode));
  checks.push(check('pm2', 'PM2 installé', hasPm2));
  // Certbot est toujours requis : même pour un sous-domaine wildcard, le Manager
  // (manager.<host>, deux niveaux) exige un certificat DÉDIÉ non couvert par le
  // wildcard *.base.
  checks.push(check('certbot', 'Certbot présent (Let’s Encrypt)', hasCertbot, { required: true }));
  checks.push(check('mongo', 'MongoDB accessible (mongod/mongosh)', hasMongo, { required: false }));

  // 3. Build nginx : la configuration existante est-elle valide ? (`nginx -t`)
  const nginxTest = await transport.exec('nginx -t 2>&1 || sudo nginx -t 2>&1');
  const nginxOut = `${nginxTest.stdout}${nginxTest.stderr}`;
  const nginxSyntaxOk = /syntax is ok/i.test(nginxOut) || nginxTest.code === 0;
  // Tolérance : si `nginx -t` échoue UNIQUEMENT à cause de la configuration de
  // CETTE cible (laissée invalide par un déploiement précédent interrompu, avant
  // le nettoyage atomique), ce n'est PAS bloquant — le déploiement la régénère et
  // l'écrase (phase HTTP puis HTTPS). On ne bloque que si une configuration TIERCE
  // (un AUTRE fichier) casse le test : on ne déploie jamais sur un Nginx cassé
  // par un site qu'on ne gère pas.
  const ownConf = `${target.host}.conf`;
  const brokenFiles = [...nginxOut.matchAll(/\bin\s+(\/etc\/nginx\/\S+?):\d+/g)].map((m) => m[1]);
  const onlyOwnConfBroken = !nginxSyntaxOk && brokenFiles.length > 0 && brokenFiles.every((f) => f.endsWith(`/${ownConf}`));
  checks.push(
    check('nginx-config', 'Configuration Nginx valide (nginx -t)', nginxSyntaxOk, {
      required: hasNginx && !onlyOwnConfBroken,
      detail: onlyOwnConfBroken
        ? 'une configuration précédente de ce site était invalide — elle sera régénérée et remplacée'
        : nginxSyntaxOk
          ? null
          : (nginxOut.split('\n').find((l) => /emerg|error/i.test(l)) || '').trim() || null,
    })
  );

  // 4. Permissions d'écriture sur la racine de déploiement.
  const permProbe = `test -w ${remoteRoot} && echo WRITABLE || (sudo -n test -w ${remoteRoot} 2>/dev/null && echo SUDO || echo NO)`;
  const perm = await transport.exec(permProbe);
  const permOk = /WRITABLE|SUDO/.test(perm.stdout);
  checks.push(check('permissions', `Écriture possible sur ${remoteRoot}`, permOk, { detail: perm.stdout.trim() }));

  // 5. Disponibilité disque : au moins ~500 Mo libres sur la racine.
  const disk = await transport.exec(`df -Pk ${remoteRoot} | tail -1 | awk '{print $4}'`);
  const freeKb = Number(disk.stdout.trim()) || 0;
  const diskOk = freeKb >= 500 * 1024;
  checks.push(
    check('disk', 'Espace disque suffisant (≥ 500 Mo)', diskOk, {
      detail: freeKb ? `${Math.round(freeKb / 1024)} Mo libres` : null,
    })
  );

  // 6. L'adresse est-elle déjà occupée par un AUTRE site (non géré par cet outil) ?
  //    On lit la conf Nginx éventuelle : la nôtre porte un marqueur. Une conf
  //    étrangère = refus (on ne veut jamais écraser un site tiers). Un
  //    redéploiement de NOTRE site (marqueur présent) reste autorisé.
  const confPath = `/etc/nginx/sites-available/${target.host}.conf`;
  const confRes = await transport.exec(`test -f ${confPath} && cat ${confPath} || echo __NONE__`);
  const confBody = confRes.stdout || '';
  const confPresent = /server_name|listen\s/.test(confBody);
  const foreign = confPresent && !/Généré par DeploymentEngine/.test(confBody);
  checks.push(
    check('occupied', 'L’adresse n’est pas déjà utilisée par un autre site', !foreign, {
      detail: foreign ? 'une configuration existante non gérée par cet outil occupe cette adresse' : null,
    })
  );

  /**
   * 7. Certificat de l'hôte — INFORMATIF, jamais bloquant.
   *
   * ── LE DÉFAUT SUPPRIMÉ ────────────────────────────────────────────────────
   * Ce contrôle exigeait (`required: true`) qu'un certificat `*.base` existe
   * DÉJÀ sur le VPS. Un domaine vierge était donc impossible à déployer : le
   * seul moyen d'obtenir ce fichier aurait été un déploiement antérieur, que
   * ce même contrôle refusait. Un préflight ne doit pas exiger le résultat de
   * l'étape qu'il précède.
   *
   * Ce qui compte AVANT d'émettre, c'est que l'émission soit possible : le
   * nom résout (contrôle DNS), et le port 80 sert le challenge ACME
   * (`/var/www/certbot`, vérifié ci-dessus par la configuration Nginx). La
   * présence du certificat n'est plus qu'une information : elle dit si ce
   * déploiement émettra ou réutilisera.
   */
  const certFile = certPaths(target).fullchain;
  const certRes = await transport.exec(`test -f ${certFile} && echo OK || echo NO`);
  const certPresent = certRes.stdout.trim().endsWith('OK');
  checks.push(
    check('host-cert', `Certificat de ${target.host}`, certPresent, {
      required: false,
      detail: certPresent
        ? `présent : ${certFile}`
        : `absent — il sera émis par HTTP-01 pendant ce déploiement (${certFile})`,
    })
  );

  // 8. Analyse DNS — SAUTÉE si une phase DNS dédiée s'en charge (fournisseur
  // Hostinger : le DNS est vérifié/créé par le moteur, pas ici).
  if (!skipDnsCheck) {
    if (target.type === 'subdomain') {
      checks.push(
        check('dns', `Couvert par le wildcard *.${target.wildcardBase} — aucun DNS à créer`, true, {
          required: false,
          detail: `${target.subdomain}.${target.wildcardBase}`,
        })
      );
    } else {
      const vpsIp = await resolveVpsIp(sshHost).catch(() => null);
      const dnsRes = await checkDomainPointsToVps(target.host, vpsIp);
      checks.push(
        check('dns-resolves', `Le domaine ${target.host} résout`, dnsRes.resolves, {
          detail: dnsRes.addresses.join(', ') || 'aucune adresse',
        })
      );
      checks.push(
        check('dns-points', `Le domaine pointe vers le VPS (${vpsIp || '?'})`, dnsRes.pointsToVps, {
          detail: dnsRes.pointsToVps ? 'OK' : `attendu ${vpsIp}, obtenu ${dnsRes.addresses.join(', ') || '—'}`,
        })
      );
    }
  }

  const failedChecks = checks.filter((c) => c.required && !c.ok);
  return { ok: failedChecks.length === 0, target, checks, failedChecks };
}

export default runPreflight;
