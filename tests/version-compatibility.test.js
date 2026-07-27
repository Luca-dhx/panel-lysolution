// Compatibilité de versions : semver, règle « même majeure », dérive du parc.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const {
  compareSemver,
  describeDrift,
  isContractCompatible,
  isValidSemver,
  parseSemver,
  sameMajor,
} = await import('../backend/src/services/versioning/versionCompatibility.js');

const contract = await import('../backend/src/bridge/bridgeContract.js');

section('Analyse semver');
{
  check('1.0.0 valide', isValidSemver('1.0.0'));
  check('12.34.56 valide', isValidSemver('12.34.56'));
  check('1.0 invalide', !isValidSemver('1.0'));
  check('v1.0.0 invalide', !isValidSemver('v1.0.0'));
  check('chaîne vide invalide', !isValidSemver(''));
  check('null invalide', !isValidSemver(null));
  const parsed = parseSemver('2.7.13');
  check('parse 2.7.13', parsed.major === 2 && parsed.minor === 7 && parsed.patch === 13);
  check('parse invalide → null', parseSemver('abc') === null);
}

section('Comparaison');
{
  check('1.0.0 < 1.0.1', compareSemver('1.0.0', '1.0.1') === -1);
  check('1.10.0 > 1.9.9', compareSemver('1.10.0', '1.9.9') === 1);
  check('2.0.0 > 1.99.99', compareSemver('2.0.0', '1.99.99') === 1);
  check('égalité', compareSemver('1.2.3', '1.2.3') === 0);
  check('opérande invalide → null', compareSemver('1.2.3', 'nope') === null);
}

section('Règle du contrat : même majeure');
{
  check('1.0.0 compatible 1.4.2', isContractCompatible('1.0.0', '1.4.2'));
  check('1.9.0 compatible 1.0.0 (mineure supérieure côté client tolérée)', isContractCompatible('1.9.0', '1.0.0'));
  check('2.0.0 incompatible 1.x', !isContractCompatible('2.0.0', '1.4.2'));
  check('invalide incompatible', !isContractCompatible('abc', '1.0.0'));
  check('sameMajor(1.1.1, 1.9.9)', sameMajor('1.1.1', '1.9.9'));
  check('miroir : version de contrat du Panel elle-même compatible', contract.isContractCompatible(contract.CONTRACT_VERSION));
  check('miroir : majeure supérieure refusée', !contract.isContractCompatible('2.0.0'));
  check('miroir : en-tête manquant refusé', !contract.isContractCompatible(undefined));
}

section('Dérive du parc');
{
  const drift = describeDrift(['1.2.0', '1.2.0', '1.3.0', null, 'garbage']);
  check('total', drift.total === 5);
  check('2 versions inconnues (« jamais vu »)', drift.unknown === 2);
  check('dernière version : 1.3.0', drift.latest === '1.3.0');
  check('2 projets en retard', drift.outdated === 2);
  check('distinct compte 1.2.0 deux fois', drift.distinct['1.2.0'] === 2);
  const empty = describeDrift([]);
  check('parc vide : latest null, rien en retard', empty.latest === null && empty.outdated === 0);
}

finish();
