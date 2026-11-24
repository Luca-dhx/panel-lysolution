/**
 * LES IDENTIFIANTS D'UNE ENTREPRISE CLIENTE — carnet d'accès par fiche.
 *
 * Ce que la suite verrouille :
 *   1. Le parcours : créer, lire, modifier, supprimer un identifiant et ses champs.
 *   2. Le secret : valeurs chiffrées en base, jamais exposées par la fiche ni
 *      par la vue publiée aux projets, lecture réservée aux comptes DEV.
 *   3. La garde : une fiche qui porte des identifiants ne se supprime pas.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv, createUser } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelClientCompany = (await import('../backend/src/models/PanelClientCompany.model.js')).default;
const { publishedProfile } = await import('../backend/src/services/clientCompany/clientCompany.service.js');

await seedFromEnv();
await createUser({
  email: 'admin@panel.test', password: 'motdepasse-admin', displayName: 'Gestion', role: 'ADMIN',
});

const { call, close } = await startServer(createApp());
const connexion = async (email, password) => {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  return `Bearer ${res.json.data.token}`;
};
const DEV = await connexion('dev@panel.test', 'motdepasse-test');
const ADMIN = await connexion('admin@panel.test', 'motdepasse-admin');
const h = (auth) => ({ headers: { authorization: auth } });

const fiche = await call('POST', '/api/client-companies', { ...h(DEV), body: { legalName: 'SARL CARNET' } });
const id = fiche.json.data.clientCompany.clientCompanyId;
const base = `/api/client-companies/${id}/credentials`;

section('1. Le parcours');
{
  const vide = await call('GET', base, h(DEV));
  check('liste vide au départ', vide.status === 200 && vide.json.data.credentials.length === 0);
  check('le nom de la fiche accompagne la liste', vide.json.data.legalName === 'SARL CARNET');

  const cree = await call('POST', base, {
    ...h(DEV),
    body: {
      name: 'Stripe',
      fields: [
        { name: 'mail', value: 'compta@carnet.test' },
        { name: 'mot de passe', value: 'S3cr3t!' },
        { name: '', value: '' },
      ],
    },
  });
  check('création → 201', cree.status === 201);
  const c = cree.json.data.credential;
  check('la ligne vide est écartée', c.fields.length === 2);
  check('la valeur revient en clair à un DEV', c.fields[1].value === 'S3cr3t!');

  const maj = await call('PUT', `${base}/${c.credentialId}`, {
    ...h(DEV),
    body: {
      name: 'Stripe (prod)',
      fields: [
        { fieldId: c.fields[0].fieldId, name: 'mail', value: 'neuf@carnet.test' },
        { name: 'clé API', value: 'sk_live_xxx' },
      ],
    },
  });
  check('modification → 200', maj.status === 200);
  check('nom modifié', maj.json.data.credential.name === 'Stripe (prod)');
  check('le fieldId fourni est conservé', maj.json.data.credential.fields[0].fieldId === c.fields[0].fieldId);
  check('le champ retiré a disparu', maj.json.data.credential.fields.length === 2);

  const sansNom = await call('POST', base, { ...h(DEV), body: { name: '  ', fields: [] } });
  check('identifiant sans nom → 400', sansNom.status === 400);
  const valeurOrpheline = await call('POST', base, { ...h(DEV), body: { name: 'X', fields: [{ name: '', value: 'abc' }] } });
  check('valeur sans nom de champ → 400', valeurOrpheline.status === 400);

  const inconnu = await call('PUT', `${base}/inexistant`, { ...h(DEV), body: { name: 'Y' } });
  check('identifiant inconnu → 404', inconnu.status === 404);
}

section('2. Le secret');
{
  const brut = await PanelClientCompany.findOne({ clientCompanyId: id }).lean();
  const enBase = JSON.stringify(brut.credentials);
  check('aucune valeur en clair dans la base', !enBase.includes('neuf@carnet.test') && !enBase.includes('sk_live_xxx'));
  check('les noms restent lisibles en base', enBase.includes('clé API'));

  const detail = await call('GET', `/api/client-companies/${id}`, h(DEV));
  check('la fiche n’expose pas les identifiants', !JSON.stringify(detail.json).includes('credentials'));
  check('la vue publiée aux projets non plus', !JSON.stringify(publishedProfile(brut)).includes('credential'));

  const admin = await call('GET', base, h(ADMIN));
  check('un compte ADMIN (non DEV) ne lit pas les identifiants', admin.status === 403);
  const anonyme = await call('GET', base);
  check('sans jeton → 401', anonyme.status === 401);
}

section('3. La garde de suppression');
{
  const refus = await call('DELETE', `/api/client-companies/${id}`, h(DEV));
  check('fiche avec identifiants → suppression refusée (409)', refus.status === 409);

  const liste = await call('GET', base, h(DEV));
  for (const c of liste.json.data.credentials) {
    const del = await call('DELETE', `${base}/${c.credentialId}`, h(DEV));
    check(`suppression de « ${c.name} »`, del.status === 200);
  }
  const ok = await call('DELETE', `/api/client-companies/${id}`, h(DEV));
  check('fiche vidée → suppression acceptée', ok.status === 200);
}

await close();
await stopMemoryMongo();
finish();
