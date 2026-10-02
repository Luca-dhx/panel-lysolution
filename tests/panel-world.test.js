// MONDE PANEL D'UNE FICHE — une production rattachée aux comptes de recette.
//
// Ce que cette suite prouve :
//
//   RATTACHEMENT   `panelWorld` l'emporte pour les identifiants fournisseur et
//                  la livraison des données métier ; à défaut, rien ne change
//   IDENTITÉ       la reconnaissance de clé et la contradiction d'environnement
//                  continuent de lire l'environnement d'exécution
//   TRANSACTIONS   un paiement de commissions se nomme d'après son mois
//
// Aucun réseau ni base.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const env = await import('../backend/src/services/registry/projectEnvironment.js');
const ctx = await import('../backend/src/services/capabilities/invocationContext.js');
const projection = await import('../backend/src/services/finance/providerRevenue/revenueProjection.service.js');

const prod = { projectId: 'p-prod', declaredEnvironment: 'PROD', runtime: { environment: 'PROD' } };
const prodRattachee = { ...prod, panelWorld: 'TEST' };

section('RATTACHEMENT');
{
  check('sans rattachement : le monde est celui de la fiche (PROD)', env.panelWorldOf(prod) === 'PROD');
  check('rattachée à la recette : monde Panel TEST', env.panelWorldOf(prodRattachee) === 'TEST');
  check('…et les capacités résolvent les identifiants TEST', ctx.resolveInstanceEnvironment(prodRattachee) === 'TEST');
  check('sans rattachement, les capacités restent sur PROD', ctx.resolveInstanceEnvironment(prod) === 'PROD');
  check('valeur fantaisiste ignorée (repli sur la fiche)', env.panelWorldOf({ ...prod, panelWorld: 'staging' }) === 'PROD');
  check('fiche TEST sans rattachement : TEST', env.panelWorldOf({ declaredEnvironment: 'TEST' }) === 'TEST');
}

section('IDENTITÉ');
{
  check('l’environnement qui fait autorité reste PROD (clé <clé>-prod, fédération)', env.authoritativeEnvironmentOf(prodRattachee) === 'PROD');
  check('aucune contradiction signalée : le projet annonce bien PROD', env.environmentContradicted(prodRattachee) === false);
}

section('TRANSACTIONS');
{
  const fait = (corroboration, label = 'Commission vente BS-001') => ({ label, corroboration });
  check('paiement de commissions → « Commissions 2026-09 »', projection.labelOf(fait({ paymentType: 'COMMISSION', commissionPeriodKey: '2026-09' })) === 'Commissions 2026-09');
  check('…même si la facture nomme sa première vente', projection.labelOf(fait({ paymentType: 'COMMISSION', commissionPeriodKey: '2026-09' }, 'Commission vente BS-001')) === 'Commissions 2026-09');
  check('sans mois connu → « Commissions »', projection.labelOf(fait({ paymentType: 'COMMISSION' })) === 'Commissions');
  check('les frais de lancement gardent leur libellé', projection.labelOf({ label: null, corroboration: { paymentType: 'LAUNCH_FEE' } }) === 'Frais de mise en service');
  check('l’abonnement aussi', projection.labelOf({ label: null, corroboration: { paymentType: 'SUBSCRIPTION' } }) === 'Abonnement');
}

finish();
