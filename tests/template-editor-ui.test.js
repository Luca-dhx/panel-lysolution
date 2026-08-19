import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const app = read('frontend/src/App.tsx');
const nav = read('frontend/src/config/nav.ts');
const api = read('frontend/src/lib/api.ts');
const helper = read('frontend/src/lib/emailTemplates.ts');
const page = read('frontend/src/pages/EmailTemplatesPage.tsx');
const styles = read('frontend/src/styles.css');

section('Branchement global');
{
  check('la route DEV est declaree',
    app.includes('path="/email-templates" element={dev(<EmailTemplatesPage />)}'));
  check('la navigation DEV expose les templates',
    nav.includes("to: '/email-templates'") && nav.includes('Templates e-mail'));
  check('le client API expose liste/detail/preview/save/versions/test-send',
    api.includes('/api/email-templates')
    && api.includes('/preview')
    && api.includes('/readiness')
    && api.includes('/test-send')
    && api.includes('/versions/${version}/restore'));

  /**
   * LA PORTÉE VOYAGE EN QUERY, JAMAIS DANS LE CORPS (L11.1).
   *
   * Le serveur refuse tout champ de portée trouvé dans un corps
   * (`PANEL_EMAIL_TEMPLATE_SCOPE_IN_BODY`), parce que c'est exactement par là
   * qu'un `PUT` créait un document invisible de l'IHM et pourtant servi en
   * production. Ce contrôle garde le CLIENT du même côté de la règle : une
   * seule fonction sérialise la portée, et elle produit une query.
   */
  check('la portée est sérialisée en query, en UN SEUL endroit',
    api.includes('function scopeQuery(') && api.includes("params = new URLSearchParams({ scope: 'PROJECT'"));
  /**
   * Le contrôle porte sur la SECTION des modèles, pas sur tout le client :
   * d'autres surfaces du Panel passent légitimement un `projectId` dans un
   * corps (préparation d'exécution, médias). Élargir la règle à tout le fichier
   * la rendrait fausse, donc désactivée au premier faux positif.
   */
  const sectionModeles = api.slice(
    api.indexOf('listEmailTemplateScopes'),
    api.indexOf('getTheme:'),
  );
  check('la section des modèles est bien isolée pour ce contrôle', sectionModeles.length > 500);
  check('aucun champ de portée n’est glissé dans un corps de requête',
    !/body:\s*\{[^}]*\bprojectId\b/.test(sectionModeles)
    && !/body:\s*\{[^}]*\bscope/i.test(sectionModeles));
  check('les portées administrables sont demandées AU SERVEUR',
    api.includes('listEmailTemplateScopes') && api.includes('/api/email-templates/scopes'));
}

section('Fonctions editor');
{
  check('les onglets canoniques existent',
    helper.includes("['editor', 'preview', 'variables', 'versions', 'guide']"));
  check('l’insertion de variable est supportee cote client',
    helper.includes('insertVariable(') && helper.includes('`{{${key}}}`'));
  check('les modifications sont calculees champ par champ',
    helper.includes('changedFields(') && helper.includes('patch.html = draft.html'));
}

section('Page template editor');
{
  check('la page charge le detail et la readiness du template',
    page.includes('api.getEmailTemplate(templateId, scope)')
    && page.includes('api.getEmailTemplateReadiness(templateId, scope)'));
  check('l’aperçu live passe par une iframe sandboxee',
    page.includes('sandbox=""') && page.includes('srcDoc={html}'));
  check('les variables sont visibles et inserables',
    page.includes('VariablesTab') && page.includes('Inserer'));
  check('le test d’envoi est disponible dans l’editeur',
    page.includes('Envoyer un test')
    && page.includes('api.sendEmailTemplateTest(templateId, testEmail.trim(), scope)'));
  check('l’historique permet aperçu et restauration',
    page.includes('api.listEmailTemplateVersions(templateId, scope)')
    && page.includes('api.getEmailTemplateVersion(templateId, version, scope)')
    && page.includes('api.restoreEmailTemplateVersion(templateId, version, scope)'));
}

/* ══════════════════════════════════════════════════════════════════════════
   PORTÉE — la surface qui manquait, et dont l'absence faisait tout le défaut.
   ══════════════════════════════════════════════════════════════════════════ */
section('Sélecteur de portée');
{
  /**
   * Le modèle « par projet » existait en base depuis toujours ; aucun écran ne
   * permettait d'en écrire un. C'est pourquoi tout le parc partageait un seul
   * document : un héritage qu'aucune interface ne peut rompre n'est pas un
   * héritage, c'est une valeur unique.
   */
  check('l’écran propose un sélecteur de portée',
    page.includes('template-scope-picker') && page.includes('onScopeChange'));
  check('la liste des portées vient du serveur',
    page.includes('api.listEmailTemplateScopes()'));
  check('le défaut est la portée PANEL, jamais un client',
    page.includes("PANEL_SCOPE: EmailTemplateScopeRef = { scopeType: 'PANEL' }"));

  /**
   * CHANGER DE PORTÉE DOIT RELIRE. Sans `scopeKey` en dépendance, l'écran
   * garderait le contenu du projet précédent tout en affichant le badge du
   * nouveau — l'illusion exacte que ce lot supprime.
   */
  check('changer de portée relit le catalogue et le modèle',
    page.includes('[selected, scopeKey]') && page.includes('[templateId, scopeKey]'));

  check('la portée est rappelée par un badge, y compris dans l’éditeur',
    page.includes('function ScopeBadge(') && page.split('<ScopeBadge').length >= 3);

  /**
   * L'ABSENCE D'INSTANCE EST MONTRÉE, PAS MASQUÉE. Afficher un contenu par
   * défaut d'apparence normale ferait croire qu'un envoi partirait.
   */
  check('un modèle non configuré est signalé comme tel',
    page.includes('Non configuré') && page.includes('!template.configured'));
  check('…et l’éditeur avertit que l’envoi serait REFUSÉ',
    page.includes('aucun modèle') && page.includes('refusé'));
}

section('Styles dedies');
{
  check('les classes principales de la surface templates existent',
    styles.includes('.template-list')
    && styles.includes('.template-grid')
    && styles.includes('.template-preview-frame')
    && styles.includes('.template-validation-group'));
}

finish();
