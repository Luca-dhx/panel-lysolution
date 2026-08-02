/**
 * Rendu Markdown d'un rapport de déploiement structuré.
 *
 * Lisible sans l'application, directement collable dans une conversation
 * Claude Code. Commence par un résumé, puis les sections détaillées, et se
 * termine par un bloc « Demande d'audit ».
 */

const OPERATION_LABEL = {
  PRECHECK: 'Vérification préalable (préflight)',
  DEPLOYMENT: 'Déploiement',
  ROLLBACK: 'Restauration',
  HEALTHCHECK: 'Contrôle de santé',
  BACKUP: 'Sauvegarde',
};

const STATUS_LABEL = {
  ok: '✅ Réussi',
  error: '❌ Échec',
  warning: '⚠️ Avertissement',
  skipped: '⊘ Ignoré',
  cancelled: '⊗ Annulé',
  running: '⏳ En cours',
  interrupted: '⚠️ Interrompu',
  pending: '○ En attente',
};

const STEP_MARK = {
  ok: '✓',
  error: '✗',
  warning: '⚠',
  skipped: '⊘',
  cancelled: '⊗',
  running: '…',
  pending: '○',
};

const AUDIT_PROMPT = `## Demande d'audit

Analyse ce rapport de déploiement, identifie la cause racine exacte, propose la
correction minimale, ajoute les tests de non-régression puis relance les
validations concernées.`;

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

function codeBlock(content, lang = '') {
  const c = String(content ?? '').trimEnd();
  if (!c) return '';
  return `\n\`\`\`${lang}\n${c}\n\`\`\`\n`;
}

/** @param {object} report structuré (RunRecorder.toStructured) */
export function renderMarkdown(report) {
  const id = report.identification || {};
  const L = [];
  L.push('# Rapport de déploiement');
  L.push('');
  L.push('## Résumé');
  L.push(`- **Opération** : ${OPERATION_LABEL[id.operationType] || id.operationType || 'Déploiement'}`);
  L.push(`- **Résultat** : ${STATUS_LABEL[id.result] || id.result || '—'}`);
  L.push(`- **Étape finale** : ${id.finalStepId || '—'}`);
  L.push(`- **Site** : ${id.siteUrl || '—'}`);
  L.push(`- **Serveur** : ${id.sshUser || 'root'}@${id.sshHost || '—'}`);
  L.push(`- **Début** : ${id.startedAt || '—'}`);
  L.push(`- **Fin** : ${id.finishedAt || '—'}`);
  L.push(`- **Durée** : ${fmtDuration(id.durationMs)}`);
  L.push(`- **Version** : ${id.version || '—'}`);
  if (report.errorSummary?.message) L.push(`- **Erreur** : ${report.errorSummary.message}`);
  L.push('');

  // Identification complète
  L.push('## Identification');
  L.push(kv({
    reportVersion: id.reportVersion,
    deploymentRunId: id.deploymentRunId,
    deploymentTargetId: id.deploymentTargetId,
    destination: id.targetName,
    hostnameSite: id.siteHost,
    environnement: id.env,
    branche: id.branch,
    commit: id.commit,
  }));
  L.push('');

  // Contexte local
  if (report.context && Object.keys(report.context).length) {
    L.push('## Contexte local');
    L.push(kv(report.context));
    L.push('');
  }

  // DNS
  if (report.dns) {
    L.push('## DNS');
    L.push(kv(report.dns));
    L.push('');
  }

  // Hostinger / fournisseur DNS (sans secret)
  if (report.hostinger) {
    const h = report.hostinger;
    L.push('## Hostinger / DNS provider');
    if (h.configured === false) {
      L.push(`- **Intégration** : non configurée (${h.reason || '—'})`);
    } else {
      L.push(kv({
        provider: h.provider,
        zone: h.zone,
        stratégieZone: h.zoneSource,
        nomRelatifSite: h.siteRelative,
        nomsRelatifsApplications: (h.derivedRelatives ?? []).map((d) => `${d.appId}:${d.relativeName}`).join(', ') || null,
        credentialsVérifiés: h.credentials?.verified,
        domainesAccessibles: h.credentials?.domainsCount,
        ttlDemandé: h.ttlRequested,
      }));
      for (const [label, rec] of [['Site', h.site], ...(h.derived ?? []).map((d) => [d.appId, d])]) {
        if (!rec) continue;
        L.push(`- **${label}** (${rec.action}) : ${rec.previous ? `précédent ${JSON.stringify(rec.previous)} → ` : ''}attendu ${rec.expected}${rec.ttlApplied ? ` · TTL ${rec.ttlApplied}` : ''}${rec.message ? ` — ${rec.message}` : ''}`);
      }
      if (h.resolution) {
        const r = (x) => (x ? `résolu=${x.pointsToVps} (${x.attempts} essais, ${x.elapsedMs} ms${x.timedOut ? ', timeout' : ''})` : '—');
        for (const [label, rec] of Object.entries(h.resolution)) {
          L.push(`- **Résolution publique — ${label}** : ${r(rec)}`);
        }
      }
      if (h.error) L.push(`- **Erreur** : ${h.error.code} — ${h.error.message}`);
      if (h.timeline?.length) {
        L.push('- **Chronologie** :');
        for (const t of h.timeline) L.push(`  - ${t.at} · ${t.event}${t.correlationId ? ` · req ${t.correlationId}` : ''}`);
      }
    }
    L.push('');
  }

  // SSH
  if (report.ssh) {
    L.push('## Connexion SSH');
    L.push(kv(report.ssh));
    L.push('');
  }

  // Prérequis VPS
  if (report.prereqs?.length) {
    L.push('## Prérequis du serveur');
    for (const c of report.prereqs) {
      const mark = c.ok ? '✓' : c.required ? '✗' : '⚠';
      L.push(`- ${mark} **${c.label || c.id}**${c.detail ? ` — ${c.detail}` : ''}${c.required ? '' : ' _(non bloquant)_'}`);
    }
    L.push('');
  }

  // Pipeline détaillé
  L.push('## Pipeline');
  for (const s of report.steps || []) {
    L.push(`### ${STEP_MARK[s.status] || '•'} ${s.label} \`${s.id}\``);
    L.push(kv({
      statut: s.status,
      début: s.startedAt,
      fin: s.finishedAt,
      durée: fmtDuration(s.durationMs),
      message: s.publicMessage,
      technique: s.technicalMessage,
      codeErreur: s.errorCode,
    }));
    if (s.warnings?.length) s.warnings.forEach((w) => L.push(`- ⚠ ${w}`));
    for (const e of s.execs || []) {
      L.push(`- commande (exit ${e.code}) :`);
      L.push(codeBlock(e.command, 'bash'));
      if (e.stdout) L.push(`  stdout :${codeBlock(e.stdout)}`);
      if (e.stderr) L.push(`  stderr :${codeBlock(e.stderr)}`);
    }
    L.push('');
  }

  // Commandes non rattachées à une étape (ex. sonde SSH du préflight) — cruciales
  // pour diagnostiquer un échec de connexion.
  if (report.looseExecs?.length) {
    L.push('## Commandes préliminaires');
    for (const e of report.looseExecs) {
      L.push(`- commande (exit ${e.code}) :`);
      L.push(codeBlock(e.command, 'bash'));
      if (e.stdout) L.push(`  stdout :${codeBlock(e.stdout)}`);
      if (e.stderr) L.push(`  stderr :${codeBlock(e.stderr)}`);
    }
    L.push('');
  }

  // Sections techniques ciblées
  section(L, 'Nginx', report.nginx);
  section(L, 'HTTPS', report.https);
  section(L, 'Services (PM2)', report.services);
  section(L, 'Tests publics', report.publicTests);

  // État distant / rollback
  const rs = report.remoteState || {};
  if ((rs.created?.length || rs.modified?.length || rs.started?.length || rs.rollback || rs.notes?.length)) {
    L.push('## État laissé sur le serveur');
    if (rs.created?.length) L.push(`- **Créé** : ${rs.created.join(', ')}`);
    if (rs.modified?.length) L.push(`- **Modifié** : ${rs.modified.join(', ')}`);
    if (rs.started?.length) L.push(`- **Démarré** : ${rs.started.join(', ')}`);
    if (rs.rollback) L.push(`- **Rollback** : ${JSON.stringify(rs.rollback)}`);
    if (rs.notes?.length) rs.notes.forEach((n) => L.push(`- ${n}`));
    L.push('');
  }

  // Avertissements
  if (report.warnings?.length) {
    L.push('## Avertissements');
    report.warnings.forEach((w) => L.push(`- ⚠ [${w.step || '—'}] ${w.message}`));
    L.push('');
  }

  // Diagnostic
  if (report.diagnosis && Object.keys(report.diagnosis).length) {
    L.push('## Diagnostic');
    L.push(kv(report.diagnosis));
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(AUDIT_PROMPT);
  L.push('');

  return L.join('\n');
}

function kv(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '') continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    lines.push(`- **${k}** : ${val}`);
  }
  return lines.join('\n') || '- _(aucune donnée)_';
}

function section(L, title, obj) {
  if (!obj || (typeof obj === 'object' && Object.keys(obj).length === 0)) return;
  L.push(`## ${title}`);
  L.push(kv(obj));
  L.push('');
}

export { AUDIT_PROMPT };
export default renderMarkdown;
