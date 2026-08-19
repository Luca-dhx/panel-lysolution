import { ok } from '../utils/apiResponse.js';
import { buildHealth, buildVersion } from '../services/health/health.service.js';
import { describeReadiness } from '../services/health/readiness.service.js';

export function health(_req, res) {
  return ok(res, buildHealth());
}

/**
 * VIVACITÉ — « ce process répond-il ? », et rien d'autre.
 *
 * Aucune dépendance n'est consultée, volontairement. Un `/livez` qui échouerait
 * parce que Mongo est tombée ferait redémarrer en boucle un backend
 * parfaitement sain dont seule la base est absente — le redémarrage ne
 * réparant évidemment pas la base, on obtiendrait une panne permanente à
 * partir d'une panne passagère.
 *
 * Toujours 200 tant que le process peut écrire une réponse.
 */
export function livez(_req, res) {
  return res.status(200).json({
    success: true,
    data: { status: 'alive', uptimeS: Math.round(process.uptime()) },
  });
}

/**
 * APTITUDE — « puis-je traiter une requête métier ? ».
 *
 * Le STATUT HTTP porte la réponse : 200 quand tout est prêt, 503 sinon. C'est
 * ce qui permet à un proxy, à une sonde de déploiement ou à l'interface de
 * reconnexion de décider sans lire le corps.
 *
 * Le corps, lui, DÉTAILLE : il dit laquelle des dépendances manque. Sans ce
 * détail, « pas prêt » envoie chercher partout.
 */
export function readyz(_req, res) {
  const etat = describeReadiness();
  res.set('Cache-Control', 'no-store');
  if (!etat.ready) res.set('Retry-After', '2');
  return res.status(etat.ready ? 200 : 503).json({ success: etat.ready, data: etat });
}

export async function version(_req, res) {
  return ok(res, await buildVersion());
}
