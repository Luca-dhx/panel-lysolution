/**
 * Phase DNS du pipeline (fournisseur abstrait DnsProvider).
 *
 * Deux temps, pour respecter l'ordre sûr (§8) : AUCUNE mutation externe avant
 * que les validations non destructives indispensables (dont la connexion SSH)
 * soient passées.
 *
 *   planPhase()      : dns.zone → dns.provider → dns.read (LECTURE SEULE + plan +
 *                      détection de conflits). N'écrit rien.
 *   mutationPhase()  : dns.site → dns.apps → dns.verify (CRÉATION/CORRECTION
 *                      puis vérification de la résolution publique). Appelée
 *                      APRÈS le préflight SSH.
 *
 * Chaque étape émet un évènement canonique et alimente la section « Hostinger /
 * DNS provider » du rapport (sans secret).
 */
import { ensureDnsRecord } from './ensureDns.js';
import { relativeName } from './zoneResolver.js';
import { waitForResolution } from './propagation.js';
import { planTopology } from '../topology.js';

/** Détecte la zone, vérifie les credentials, lit l'existant et PLANIFIE (sans muter). */
export async function dnsPlanPhase({ provider, siteHost, expectedIp, ttl, emitStep, recorder, profile }) {
  // Les hôtes à publier viennent de la TOPOLOGIE : l'hôte du site + un par
  // application servie sur un sous-domaine. Aucun nom en dur.
  const topo = planTopology({ host: siteHost, profile });
  const derivedHosts = topo.dnsHosts.filter((h) => h.host !== topo.host);
  const section = {
    provider: provider.name,
    hostnames: topo.dnsHosts.map((h) => h.host),
    expectedIp,
    ttlRequested: ttl ?? null,
    timeline: [],
  };

  // 1. dns.zone
  emitStep('dns.zone', 'running', { publicMessage: 'Détection du domaine…' });
  let zone;
  try {
    zone = await provider.findBestZone(siteHost);
    section.zone = zone.zone;
    section.zoneSource = zone.source;
    section.siteRelative = zone.relativeName;
    // Un nom relatif par hôte dérivé, indexé par application.
    section.derivedRelatives = derivedHosts.map((h) => ({ appId: h.appId, label: h.label, host: h.host, relativeName: relativeName(h.host, zone.zone) }));
    section.timeline.push({ at: iso(), event: 'zone_detected', zone: zone.zone, source: zone.source });
    emitStep('dns.zone', 'ok', { technicalMessage: `zone=${zone.zone} (${zone.source})` });
  } catch (err) {
    section.error = { code: err.code || 'ZONE_ERROR', message: err.message };
    recorder.setHostinger(section);
    emitStep('dns.zone', 'error', { errorCode: err.code || 'ZONE_ERROR', publicMessage: 'Domaine non pris en charge.', technicalMessage: err.message });
    return { ok: false, failedStep: 'dns.zone', section, errorCode: err.code || 'ZONE_ERROR' };
  }

  // 2. dns.provider (verify credentials)
  emitStep('dns.provider', 'running', { publicMessage: 'Connexion au gestionnaire de domaine…' });
  try {
    const v = await provider.verifyCredentials();
    if (!v.ok) {
      section.credentials = { verified: false };
      section.error = { code: 'HOSTINGER_AUTH_FAILED', message: v.message || 'Credentials invalides.' };
      recorder.setHostinger(section);
      emitStep('dns.provider', 'error', { errorCode: 'HOSTINGER_AUTH_FAILED', publicMessage: 'Connexion au gestionnaire de domaine impossible.', technicalMessage: v.message });
      return { ok: false, failedStep: 'dns.provider', section, errorCode: 'HOSTINGER_AUTH_FAILED' };
    }
    section.credentials = { verified: true, domainsCount: v.details?.domainsCount ?? null };
    section.timeline.push({ at: iso(), event: 'verify_credentials', correlationId: v.details?.correlationId || null });
    emitStep('dns.provider', 'ok', { publicMessage: 'Connexion au gestionnaire de domaine établie.' });
  } catch (err) {
    section.credentials = { verified: false, code: err.code, correlationId: err.correlationId };
    section.error = { code: err.code, message: err.message };
    recorder.setHostinger(section);
    emitStep('dns.provider', 'error', { errorCode: err.code, publicMessage: 'Connexion au gestionnaire de domaine impossible.', technicalMessage: err.message });
    return { ok: false, failedStep: 'dns.provider', section, errorCode: err.code };
  }

  // 3. dns.read (plan + conflits, non destructif)
  emitStep('dns.read', 'running', { publicMessage: 'Lecture de la configuration du domaine…' });
  try {
    const records = await provider.listRecords(zone.zone);
    const sitePlan = await ensureDnsRecord({ provider, zone: zone.zone, relativeName: zone.relativeName, expectedIp, ttl, records, dryRun: true });
    const derivedPlans = [];
    for (const d of section.derivedRelatives) {
      derivedPlans.push({ ...d, plan: await ensureDnsRecord({ provider, zone: zone.zone, relativeName: d.relativeName, expectedIp, ttl, records, dryRun: true }) });
    }
    section.site = planSummary(sitePlan);
    section.derived = derivedPlans.map((d) => ({ appId: d.appId, host: d.host, ...planSummary(d.plan) }));
    const conflict = [sitePlan, ...derivedPlans.map((d) => d.plan)].find((p) => p.action === 'conflict');
    if (conflict) {
      section.error = { code: 'HOSTINGER_RECORD_CONFLICT', reason: conflict.reason, message: conflict.message };
      recorder.setHostinger(section);
      emitStep('dns.read', 'error', {
        errorCode: 'HOSTINGER_RECORD_CONFLICT',
        publicMessage: 'Un conflit de configuration a été détecté sur l’adresse.',
        technicalMessage: conflict.message,
      });
      return { ok: false, failedStep: 'dns.read', section, conflict, needsConfirmation: true, errorCode: 'HOSTINGER_RECORD_CONFLICT' };
    }
    recorder.setHostinger(section);
    emitStep('dns.read', 'ok', { technicalMessage: [`site=${sitePlan.action}`, ...derivedPlans.map((d) => `${d.appId}=${d.plan.action}`)].join(', ') });
    return { ok: true, zone, records, sitePlan, derivedPlans, section };
  } catch (err) {
    section.error = { code: err.code || 'DNS_READ_ERROR', message: err.message };
    recorder.setHostinger(section);
    emitStep('dns.read', 'error', { errorCode: err.code || 'DNS_READ_ERROR', technicalMessage: err.message });
    return { ok: false, failedStep: 'dns.read', section, errorCode: err.code || 'DNS_READ_ERROR' };
  }
}

/** Crée/corrige les enregistrements (site + hôtes dérivés) puis vérifie la propagation. */
export async function dnsMutationPhase({ provider, plan, expectedIp, ttl, emitStep, recorder, resolutionOpts = {} }) {
  const section = recorder.sections.hostinger || {};
  section.actions = [];
  const zone = plan.zone.zone;
  const siteHostname = plan.zone.relativeName === '@' ? zone : `${plan.zone.relativeName}.${zone}`;
  const derived = section.derivedRelatives ?? [];

  // dns.site
  emitStep('dns.site', 'running', { publicMessage: 'Préparation de l’adresse du site…' });
  const siteRes = await ensureDnsRecord({ provider, zone, relativeName: plan.zone.relativeName, expectedIp, ttl });
  section.actions.push({ hostname: siteHostname, ...planSummary(siteRes) });
  emitStep('dns.site', actionStatus(siteRes), { technicalMessage: `action=${siteRes.action}` });

  // dns.apps : une adresse par application servie sur un sous-domaine. L'étape
  // est SAUTÉE — et le dit — quand le profil n'en déclare aucune.
  const derivedResults = [];
  if (!derived.length) {
    emitStep('dns.apps', 'skipped', { technicalMessage: 'aucune application sur sous-domaine dans le profil' });
  } else {
    emitStep('dns.apps', 'running', { publicMessage: 'Préparation des adresses des applications…' });
    for (const d of derived) {
      const res = await ensureDnsRecord({ provider, zone, relativeName: d.relativeName, expectedIp, ttl });
      const hostname = `${d.relativeName}.${zone}`;
      section.actions.push({ hostname, appId: d.appId, ...planSummary(res) });
      derivedResults.push({ ...d, hostname, res });
    }
    const worst = derivedResults.map((d) => actionStatus(d.res)).includes('error') ? 'error' : 'ok';
    emitStep('dns.apps', worst, { technicalMessage: derivedResults.map((d) => `${d.appId}=${d.res.action}`).join(', ') });
  }

  // dns.verify (résolution publique de TOUS les hôtes). On mesure via le
  // fournisseur (Hostinger : DNS réel ; Mock : stub) pour rester testable.
  emitStep('dns.verify', 'running', { publicMessage: 'Vérification de la disponibilité des adresses…' });
  const resolveOpts = { resolver: (h, ip) => provider.verifyResolution(h, ip), ...resolutionOpts };
  const siteResolve = await waitForResolution(siteHostname, expectedIp, resolveOpts);
  const resolutions = { site: pick(siteResolve) };
  let allResolved = siteResolve.pointsToVps;
  for (const d of derivedResults) {
    const r = await waitForResolution(d.hostname, expectedIp, resolveOpts);
    resolutions[d.appId] = pick(r);
    allResolved = allResolved && r.pointsToVps;
  }
  section.resolution = resolutions;
  section.timeline.push({ at: iso(), event: 'public_resolution', ...Object.fromEntries(Object.entries(resolutions).map(([k, v]) => [k, v.pointsToVps])) });
  recorder.setHostinger(section);

  if (!allResolved) {
    emitStep('dns.verify', 'warning', {
      publicMessage: 'Adresses préparées — propagation DNS encore en cours.',
      technicalMessage: Object.entries(resolutions).map(([k, v]) => `${k} résolu=${v.pointsToVps}`).join(', '),
    });
    return { ok: true, propagated: false, section };
  }
  emitStep('dns.verify', 'ok', { publicMessage: 'Adresses disponibles.' });
  return { ok: true, propagated: true, section };
}

function planSummary(p) {
  return {
    action: p.action,
    reason: p.reason,
    type: p.type,
    previous: p.previous ?? null,
    expected: p.expectedIp,
    recordId: p.recordId ?? null,
    ttlRequested: p.ttlRequested ?? null,
    ttlApplied: p.ttlApplied ?? null,
    managedByEngine: Boolean(p.managedByEngine),
    message: p.message ?? null,
  };
}
function actionStatus(res) {
  if (res.action === 'conflict') return 'error';
  if (res.action === 'wildcard_covers') return 'warning';
  return 'ok';
}
function pick(r) {
  return { resolved: r.resolved, pointsToVps: r.pointsToVps, addresses: r.addresses, attempts: r.attempts, elapsedMs: r.elapsedMs, timedOut: r.timedOut };
}
function iso() {
  return new Date().toISOString();
}

export default { dnsPlanPhase, dnsMutationPhase };
