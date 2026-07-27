/**
 * Phase DNS du pipeline (fournisseur abstrait DnsProvider).
 *
 * Deux temps, pour respecter l'ordre sûr (§8) : AUCUNE mutation externe avant
 * que les validations non destructives indispensables (dont la connexion SSH)
 * soient passées.
 *
 *   planPhase()      : dns.zone → dns.provider → dns.read (LECTURE SEULE + plan +
 *                      détection de conflits). N'écrit rien.
 *   mutationPhase()  : dns.site → dns.manager → dns.verify (CRÉATION/CORRECTION
 *                      puis vérification de la résolution publique). Appelée
 *                      APRÈS le préflight SSH.
 *
 * Chaque étape émet un évènement canonique et alimente la section « Hostinger /
 * DNS provider » du rapport (sans secret).
 */
import { ensureDnsRecord } from './ensureDns.js';
import { relativeName } from './zoneResolver.js';
import { waitForResolution } from './propagation.js';
import { deriveManagerHost } from '../hostnames.js';

/** Détecte la zone, vérifie les credentials, lit l'existant et PLANIFIE (sans muter). */
export async function dnsPlanPhase({ provider, siteHost, expectedIp, ttl, emitStep, recorder }) {
  const managerHost = deriveManagerHost(siteHost);
  const section = {
    provider: provider.name,
    hostnames: [siteHost, managerHost],
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
    section.managerRelative = relativeName(managerHost, zone.zone);
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
    const mgrPlan = await ensureDnsRecord({ provider, zone: zone.zone, relativeName: section.managerRelative, expectedIp, ttl, records, dryRun: true });
    section.site = planSummary(sitePlan);
    section.manager = planSummary(mgrPlan);
    const conflict = [sitePlan, mgrPlan].find((p) => p.action === 'conflict');
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
    emitStep('dns.read', 'ok', { technicalMessage: `site=${sitePlan.action}, manager=${mgrPlan.action}` });
    return { ok: true, zone, records, sitePlan, mgrPlan, managerHost, section };
  } catch (err) {
    section.error = { code: err.code || 'DNS_READ_ERROR', message: err.message };
    recorder.setHostinger(section);
    emitStep('dns.read', 'error', { errorCode: err.code || 'DNS_READ_ERROR', technicalMessage: err.message });
    return { ok: false, failedStep: 'dns.read', section, errorCode: err.code || 'DNS_READ_ERROR' };
  }
}

/** Crée/corrige les enregistrements (site + Manager) puis vérifie la propagation. */
export async function dnsMutationPhase({ provider, plan, expectedIp, ttl, emitStep, recorder, resolutionOpts = {} }) {
  const section = recorder.sections.hostinger || {};
  section.actions = [];
  const zone = plan.zone.zone;
  const siteHostname = plan.zone.relativeName === '@' ? zone : `${plan.zone.relativeName}.${zone}`;
  const mgrRel = section.managerRelative;
  const mgrHostname = `${mgrRel}.${zone}`;

  // dns.site
  emitStep('dns.site', 'running', { publicMessage: 'Préparation de l’adresse du site…' });
  const siteRes = await ensureDnsRecord({ provider, zone, relativeName: plan.zone.relativeName, expectedIp, ttl });
  section.actions.push({ hostname: siteHostname, ...planSummary(siteRes) });
  emitStep('dns.site', actionStatus(siteRes), { technicalMessage: `action=${siteRes.action}` });

  // dns.manager
  emitStep('dns.manager', 'running', { publicMessage: 'Préparation de l’espace de gestion…' });
  const mgrRes = await ensureDnsRecord({ provider, zone, relativeName: mgrRel, expectedIp, ttl });
  section.actions.push({ hostname: mgrHostname, ...planSummary(mgrRes) });
  emitStep('dns.manager', actionStatus(mgrRes), { technicalMessage: `action=${mgrRes.action}` });

  // dns.verify (résolution publique des DEUX hôtes). On mesure via le fournisseur
  // (Hostinger : DNS réel ; Mock : stub) pour rester testable sans réseau.
  emitStep('dns.verify', 'running', { publicMessage: 'Vérification de la disponibilité des adresses…' });
  const resolveOpts = { resolver: (h, ip) => provider.verifyResolution(h, ip), ...resolutionOpts };
  const siteResolve = await waitForResolution(siteHostname, expectedIp, resolveOpts);
  const mgrResolve = await waitForResolution(mgrHostname, expectedIp, resolveOpts);
  section.resolution = { site: pick(siteResolve), manager: pick(mgrResolve) };
  section.timeline.push({ at: iso(), event: 'public_resolution', site: siteResolve.pointsToVps, manager: mgrResolve.pointsToVps });
  recorder.setHostinger(section);

  const both = siteResolve.pointsToVps && mgrResolve.pointsToVps;
  if (!both) {
    emitStep('dns.verify', 'warning', {
      publicMessage: 'Adresses préparées — propagation DNS encore en cours.',
      technicalMessage: `site résolu=${siteResolve.pointsToVps}, manager résolu=${mgrResolve.pointsToVps}`,
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
