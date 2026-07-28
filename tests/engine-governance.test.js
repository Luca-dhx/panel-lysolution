/**
 * GOUVERNANCE DES MOTEURS — versionnement, introspection, compatibilité,
 * migrations, et génération Nginx pilotée par le profil.
 *
 * Ces tests ne touchent ni réseau, ni base, ni serveur : ils vérifient le
 * CONTRAT des moteurs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeEngine, hasCapability, isProfileSupported, isEngineCompatible,
  validateManifest, compareVersions, parseVersion, REQUIRED_MANIFEST_FIELDS,
} from '../backend/src/deployment-engine/engineInfo.js';
import {
  MIGRATIONS, migrationsBetween, planMigration, runMigrations, renderMigrationReport,
} from '../backend/src/deployment-engine/migrations/index.js';
import { planSites, renderNginxConfig, renderNginxHttpOnly, servedHosts } from '../backend/src/deployment-engine/nginx.js';
import { parseTargetUrl } from '../backend/src/deployment-engine/url.js';
import { APPS } from '../backend/src/deployment-engine/config/project.profile.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}`); }
};
const section = (t) => console.log(`\n${t}`);

const engineDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'src', 'deployment-engine',
);

section('Introspection : « qui suis-je ? »');
{
  const info = describeEngine();
  check('le moteur se nomme', info.engine === 'deployment-engine');
  check('le moteur connaît sa version', /^\d+\.\d+\.\d+$/.test(info.version));
  check('version d’API du moteur déclarée', typeof info.engineApiVersion === 'string');
  check('version de contrat déclarée', /^\d+\.\d+\.\d+$/.test(info.contractVersion));
  check('version minimale compatible déclarée', /^\d+\.\d+\.\d+$/.test(info.minimumCompatibleVersion));
  check('version de layout déclarée', typeof info.layoutVersion === 'string');
  check('date de publication déclarée', /^\d{4}-\d{2}-\d{2}$/.test(info.releaseDate));
  check('le moteur sait quel profil il exécute', typeof info.activeProfile === 'string' && info.activeProfile.length > 0);
}

section('Introspection : « quelles capacités ai-je ? »');
{
  const info = describeEngine();
  check('capacités déclarées', Array.isArray(info.capabilities) && info.capabilities.length > 0);
  for (const capability of ['preflight', 'releases', 'nginx', 'rollback', 'health-check', 'backup-restore']) {
    check(`capacité « ${capability} » déclarée`, hasCapability(capability));
  }
  check('capacité inconnue : non déclarée', !hasCapability('teleportation'));
  check('les nouveautés 2E sont déclarées',
    hasCapability('nginx-profile-driven') && hasCapability('rollback-auto-restore')
    && hasCapability('engine-introspection') && hasCapability('engine-migrations'));
}

section('Introspection : « avec quoi suis-je compatible ? »');
{
  const info = describeEngine();
  check('le profil actif est supporté', isProfileSupported());
  check('profil inconnu : non supporté', !isProfileSupported('profil-inexistant'));

  check('même version : compatible', isEngineCompatible(info.version).compatible);
  check('version minimale : compatible', isEngineCompatible(info.minimumCompatibleVersion).compatible);
  check('majeure différente : incompatible',
    isEngineCompatible('2.0.0').reason === 'MAJOR_MISMATCH');
  check('version plus récente que le moteur : refusée',
    isEngineCompatible('1.99.0').reason === 'TOO_RECENT');
  check('version invalide : refusée', isEngineCompatible('pas-une-version').reason === 'VERSION_INVALID');
}

section('Versions sémantiques');
{
  check('parse correct', JSON.stringify(parseVersion('1.2.3')) === JSON.stringify({ major: 1, minor: 2, patch: 3 }));
  check('parse refuse une valeur libre', parseVersion('1.2') === null);
  check('comparaison ordonnée', compareVersions('1.0.0', '1.1.0') === -1
    && compareVersions('1.1.0', '1.0.0') === 1
    && compareVersions('1.1.0', '1.1.0') === 0);
  check('comparaison invalide → null', compareVersions('x', '1.0.0') === null);
}

section('Manifeste : jamais un moteur sans version');
{
  const manifestPath = path.join(engineDir, 'engine.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = validateManifest(manifest);
  check(`manifeste valide${result.errors.length ? ` — ${result.errors.join(', ')}` : ''}`, result.valid);
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    check(`champ obligatoire présent : ${field}`, manifest[field] !== undefined);
  }
  check('historique de versions tenu', Array.isArray(manifest.history) && manifest.history.length > 0);

  // Un manifeste amputé doit être refusé, champ par champ.
  for (const field of ['version', 'engineApiVersion', 'minimumCompatibleVersion']) {
    const broken = { ...manifest };
    delete broken[field];
    check(`manifeste sans ${field} : refusé`, !validateManifest(broken).valid);
  }
  check('version non semver : refusée', !validateManifest({ ...manifest, version: '1.0' }).valid);
  check('minimum > version : refusé',
    !validateManifest({ ...manifest, minimumCompatibleVersion: '9.0.0' }).valid);

  // Le moteur de duplication a lui aussi son manifeste.
  const dupPath = path.resolve(engineDir, '..', 'duplication-engine', 'engine.manifest.json');
  const dup = JSON.parse(fs.readFileSync(dupPath, 'utf8'));
  check('le moteur de duplication est versionné', validateManifest(dup).valid);
  check('les deux moteurs partagent la même majeure',
    parseVersion(dup.version).major === parseVersion(manifest.version).major);
}

section('Migrations : détection et sélection');
{
  check('catalogue non vide', MIGRATIONS.length > 0);
  check('chaque migration est complètement décrite', MIGRATIONS.every((m) =>
    m.id && m.from && m.to && m.title && m.description && typeof m.detect === 'function'));

  const between = migrationsBetween('1.0.0', '1.1.0');
  check('migrations 1.0.0 → 1.1.0 sélectionnées', between.length === MIGRATIONS.length);
  check('aucune migration si déjà à jour', migrationsBetween('1.1.0', '1.1.0').length === 0);
  check('aucune migration vers une version antérieure', migrationsBetween('1.1.0', '1.0.0').length === 0);
}

section('Migrations : un projet À JOUR n’a rien à faire');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(engineDir, 'engine.manifest.json'), 'utf8'));
  const context = {
    profile: { APPS },
    manifest,
    engineFiles: fs.readdirSync(engineDir),
  };
  const plan = planMigration({ fromVersion: '1.0.0', toVersion: '1.1.0', context });
  check('toutes les migrations sont détectées comme appliquées',
    plan.pending.length === 0);
  check('rien ne bloque', plan.blocked === false);

  const report = runMigrations({ fromVersion: '1.0.0', toVersion: '1.1.0', context });
  check('exécution sans échec', report.ok === true);
  check('tout est marqué « déjà appliquée »', report.skipped.length === MIGRATIONS.length);
  check('aucune migration appliquée inutilement', report.applied.length === 0);
  check('rapport lisible produit', renderMigrationReport(report).includes('Moteur à jour'));
}

section('Migrations : un projet ANCIEN reçoit un plan précis');
{
  // Projet fictif embarquant un moteur 1.0.0 : profil sans nginxRole,
  // manifeste minimal, pas de rollback.js.
  const oldContext = {
    profile: { APPS: [{ id: 'vitrine', role: 'web' }, { id: 'backend', role: 'server' }] },
    manifest: { engine: 'deployment-engine', version: '1.0.0', contractVersion: '1.1.0' },
    engineFiles: ['DeploymentEngine.js', 'pipeline.js', 'nginx.js'],
  };
  const plan = planMigration({ fromVersion: '1.0.0', toVersion: '1.1.0', context: oldContext });
  check('les trois migrations sont en attente', plan.pending.length === 3);
  check('le plan est bloquant (migrations requises)', plan.blocked === true);
  check('chaque attente est motivée', plan.pending.every((m) => typeof m.reason === 'string' && m.reason.length > 0));

  const report = runMigrations({ fromVersion: '1.0.0', toVersion: '1.1.0', context: oldContext });
  check('la migration automatique du manifeste s’applique',
    report.applied.some((r) => r.id === 'extended-engine-manifest'));
  check('le manifeste migré porte les nouveaux champs',
    report.context.manifest.engineApiVersion !== undefined
    && report.context.manifest.minimumCompatibleVersion !== undefined
    && Array.isArray(report.context.manifest.breakingChanges));
  check('la version d’origine n’est PAS écrasée', report.context.manifest.version === '1.0.0');
  check('les migrations non automatiques sont signalées comme manuelles',
    report.manual.length === 2);
  check('…avec leurs étapes concrètes',
    report.manual.every((m) => m.manualSteps.length > 0));
  check('le rapport distingue automatique et manuel',
    renderMigrationReport(report).includes('[applied]')
    && renderMigrationReport(report).includes('[manual]'));
  check('aucune erreur', report.failed.length === 0);
}

section('Migrations : le profil du projet n’est JAMAIS réécrit aveuglément');
{
  const profile = { APPS: [{ id: 'vitrine', role: 'web', nginxRole: 'web', custom: 'valeur-du-client' }] };
  const before = JSON.stringify(profile);
  runMigrations({
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    context: { profile, manifest: { version: '1.0.0' }, engineFiles: [] },
  });
  check('le profil fourni reste intact', JSON.stringify(profile) === before);
  check('la migration du profil n’a pas d’application automatique',
    MIGRATIONS.find((m) => m.id === 'nginx-profile-driven').apply === undefined);
}

section('Nginx : entièrement piloté par le profil');
{
  const target = parseTargetUrl('https://demo.ly-solution.com');
  const roots = Object.fromEntries(APPS.map((a) => [a.id, `/var/www/site/${a.dir}`]));
  const sites = planSites(target, { roots, backendPort: 5001 });

  const webApps = APPS.filter((a) => a.nginxRole === 'web' || a.role === 'web');
  const subApps = APPS.filter((a) => a.nginxRole === 'web-subdomain' || a.role === 'web-sub');
  check('un site par application front + un hôte API',
    sites.length === webApps.length + subApps.length + 1);
  check('le backend ne produit PAS de bloc serveur',
    !sites.some((s) => APPS.find((a) => a.id === s.id)?.role === 'server'));
  check('l’application principale est servie sur l’hôte',
    sites.some((s) => s.host === target.host && s.kind === 'static'));
  check('les applications de sous-domaine sont dérivées',
    subApps.every((a) => sites.some((s) => s.host === `${a.subdomain}.${target.host}`)));
  check('l’hôte API est un proxy pur',
    sites.some((s) => s.host === `api.${target.host}` && s.kind === 'proxy' && s.root === null));
  check('chaque site statique a une racine', sites.filter((s) => s.kind === 'static').every((s) => s.root));
  check('chaque site a un certificat', sites.every((s) => s.cert?.fullchain && s.cert?.privkey));
  check('un hôte dérivé a un certificat DÉDIÉ',
    sites.filter((s) => s.host !== target.host).every((s) => s.cert.shared === false));
  check('hôtes servis, sans doublon',
    servedHosts(target, { roots, backendPort: 5001 }).length === sites.length);

  const conf = renderNginxConfig(target, { roots, backendPort: 5001 });
  check('un bloc server par site + la redirection HTTP',
    (conf.match(/^server \{/gm) || []).length === sites.length + 1);
  check('redirection HTTP → HTTPS présente', conf.includes('return 301 https://$host$request_uri'));
  check('politique de cache correcte', conf.includes('Cache-Control "no-cache"') && conf.includes('public, immutable'));
  check('bannière de génération', conf.startsWith('# Généré par DeploymentEngine'));

  const http = renderNginxHttpOnly(target, { roots, backendPort: 5001 });
  check('phase HTTP : aucun certificat référencé', !http.includes('ssl_certificate'));
  check('phase HTTP : challenge ACME servi pour chaque hôte',
    (http.match(/acme-challenge/g) || []).length === sites.length);
}

section('Nginx : le moteur ne connaît AUCUN nom d’application');
{
  const source = fs.readFileSync(path.join(engineDir, 'nginx.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Une seule tolérance : `opts.managerRoot`, paramètre d'entrée conservé pour
  // les appelants antérieurs à la Phase 2E. Il est lu, jamais interprété.
  const withoutLegacyParam = source.replace(/opts\.managerRoot/g, 'opts.legacySubRoot');
  for (const forbidden of ['manager', 'vitrine', 'frontend', 'panel']) {
    const occurrences = (withoutLegacyParam.match(new RegExp(forbidden, 'gi')) || []).length;
    check(`aucun « ${forbidden} » codé en dur dans le générateur${occurrences ? ` (${occurrences})` : ''}`,
      occurrences === 0);
  }
  check('le générateur lit le profil', source.includes("from './config/project.profile.js'"));
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
