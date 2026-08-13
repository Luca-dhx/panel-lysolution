# R10.1 — LA SIMULATION DIT CE QUE LE MOTEUR FAIT

> **Ce lot ne corrige pas une perte de données.** Le blocker R10.0
> (« `shared/storage` non persistant côté Panel ») était un **faux positif**,
> retiré du rapport R10.0 (§P) avec sa réfutation et la cause de l'erreur (§AH).
>
> Ce lot ferme ce qui a **rendu cette erreur possible** : `--dry-run` décrivait
> un déploiement que le moteur n'exécute pas.

---

## 1. Baseline et isolation

| dépôt | HEAD au démarrage | upstream | arbre |
|---|---|---|---|
| Panel | `6184e37` | `6184e37` | 1 fichier non suivi |
| SB Auto | `9ae2c50` | `9ae2c50` | propre — **non modifié par ce lot** |

Classification du non-suivi : `POST_MIGRATION_PRE_DEPLOYMENT_AUDIT.md` →
**`R10_0_REPORT`**, préservé et corrigé dans ce même lot. Aucun `UNKNOWN`.

---

## 2. Cause racine

`deploy/deploy.mjs` a **deux chemins**, et un seul atteint un serveur :

```js
if (executeMode) return execute(deployConfig, { mode });   // ← EXÉCUTION
printPlan(buildPlan(deployConfig, { releaseId: id }));      // ← SIMULATION
```

- **Exécution** : `execute()` délègue intégralement au `DeploymentEngine` →
  `runPipeline()` → `pipeline.js`.
- **Simulation** : `buildPlan()` — une liste d'étapes et de commandes shell
  écrites **à la main** dans `deploy/lib/plan.mjs`.

Les deux descriptions ont divergé sans que rien ne le signale :

| | simulation (avant) | exécution (réelle) |
|---|---|---|
| layout | `releases/<id>` + lien `current` | `backend/` **stable** |
| SPA | — | `.next` → cible, retour `.prev` |
| `.env` | `shared/.env` symlinké | écrit dans `<backend>/.env`, puis **relu** |
| `storage` | **absent** | `ln -sfn shared/storage` à chaque passage |
| purge | `releases.prune` | **aucune** |
| étapes | 15 inventées | 12 (`PIPELINE_STEPS`) |

Un audit pré-déploiement a lu la colonne de gauche en croyant lire celle de
droite, et a conclu à une perte de justificatifs comptables **inexistante**.

Aggravant : `tests/deploy.test.js` **verrouillait** la fiction — il exigeait
`releases.prune` en dernière étape, une bascule `ln -sfn .../releases/<id>`, une
rétention `tail -n +6`. Le garde-fou garantissait la divergence.

---

## 3. Le correctif : dériver, ne plus décrire

`deploy/lib/plan.mjs` ne **décrit** plus le déploiement, il le **lit** :

```js
import { PIPELINE_STEPS } from '../../backend/src/deployment-engine/pipeline.js';
import { planTopology }  from '../../backend/src/deployment-engine/topology.js';
```

- `STEPS` = étapes locales de qualité **+** `PIPELINE_STEPS`, dans l'ordre du
  moteur ;
- `describeRemoteLayout()` lit `planTopology()` — la même fonction que le
  pipeline ;
- `buildPlan()` rend une étape par étape du moteur, avec les **liens
  persistants** et les **bascules `.next`/`.prev`** ;
- **aucune commande shell n'est affichée** : elles appartiennent au pipeline,
  qui les compose à l'exécution à partir du transport. En recopier une
  recréerait exactement le défaut qu'on ferme.

Une étape ajoutée au moteur apparaît désormais dans la simulation **sans qu'on
y touche**. La divergence n'est plus possible : il n'y a plus deux sources.

### Ce que le `--dry-run` montre maintenant

```
▸ disposition distante (topologie du moteur)
  · racine du site   : /var/www/panel.exemple.com
  · backend (stable) : /var/www/panel.exemple.com/backend
  · partagé          : /var/www/panel.exemple.com/shared
  · médias publics   : /var/www/panel.exemple.com/shared/uploads
  · médias privés    : /var/www/panel.exemple.com/shared/storage

▸ dirs — Lier `uploads` et `storage` au partagé persistant, écrire puis RELIRE le `.env`
  · …/backend/uploads -> …/shared/uploads   (persistant)
  · …/backend/storage -> …/shared/storage   (persistant)
```

La question qui a fait dérailler R10.0 — « mes justificatifs survivent-ils ? » —
a maintenant sa réponse **imprimée**, à l'endroit où on la cherche.

---

## 4. Configuration

`deploy/lib/config.mjs` n'expose plus les chemins fictifs :

| champ | avant | après |
|---|---|---|
| `paths.releasesDir` | `<siteRoot>/releases` | **supprimé** |
| `paths.currentLink` | `<siteRoot>/current` | **supprimé** |
| `paths.envFile` | `<siteRoot>/shared/.env` | **supprimé** |
| `paths.sharedUploads` | ✅ | conservé |
| `paths.sharedStorage` | — | **ajouté** |
| `keepReleases` | pilotait la purge | **`@deprecated`**, toujours accepté |

`keepReleases` reste **validé et accepté** : refuser une clé devenue inutile
transformerait un nettoyage en panne de déploiement pour tout
`deploy.config.json` existant. Il n'est simplement plus lu.

---

## 5. Médias privés dans Git

`.gitignore` couvrait `backend/uploads/*` — **pas** `backend/storage/`.

Or `config.paths.privateMedia` vaut `<backend>/storage/media` : un justificatif
déposé pendant un essai local y atterrit. Un `git add -A` aurait committé une
**pièce comptable** dans un dépôt distant, définitivement — et c'était le plus
sensible des deux dossiers qui n'était pas protégé.

```gitignore
backend/storage/
storage/
```

Le dossier n'existe pas localement aujourd'hui : **aucune fuite n'a eu lieu**.

---

## 6. Réserve découverte, non corrigée ici

`rollback.js` repointe un lien `current` vers `releases/<id>`. Le pipeline de
déploiement ne crée **ni l'un ni l'autre**. Sur une destination déployée par ce
pipeline, `listReleases()` ne trouve rien et **le rollback n'a aucune cible**.
Le filet réel est `.prev` par SPA, que `rollback.js` n'utilise pas.

Corriger cela changerait le **comportement du moteur** : cela appartient à son
propre lot, avec sa propre recette. Ce lot se contente de **cesser de mentir** :
la simulation de rollback affiche désormais la réserve en clair.

```
▸ rollback.delegate — Déléguer au moteur : engine.rollback({ releaseId: … })
  ⚠ Le moteur cherche `<siteRoot>/releases/<id>` et un lien `<siteRoot>/current`.
  ⚠ Le pipeline ne crée ni l'un ni l'autre : il uploade dans `…/backend` et
    bascule les SPA par `.next`/`.prev`.
  ⚠ Aucune release n'est donc listable et le rollback n'a pas de cible.
    À traiter dans un lot du moteur.
```

**Recommandation** : lot `R10.3` — soit faire du rollback un retour `.prev`,
soit introduire réellement les releases dans le pipeline. Ne pas déployer en
comptant sur un rollback tant que ce n'est pas tranché.

---

## 7. Tests

| suite | avant | après |
|---|---|---|
| `deploy` | 71 (verrouillaient la fiction) | **88/88** |
| `deployment-topology` | 131 (dont 9 sur le plan fictif) | **131/131** |
| `deployment-rollback` | 26/26 | 26/26 |
| `deployment-build` | 14/14 | 14/14 |
| `finance-receipts` | 105/105 | 105/105 |
| `architecture` | 31/31 | 31/31 |

Nouveaux garde-fous, tous dans `deploy.test.js` :

- les étapes du plan **sont** `PIPELINE_STEPS`, comparées à la source et non à
  une liste recopiée — une recette qui recopierait aurait le même défaut que le
  plan qu'elle éprouve ;
- le plan **n'invente aucune commande shell** ;
- **aucun** `releases/`, **aucun** `current`, **aucune** purge dans le plan ;
- les deux liens persistants (`uploads`, `storage`) sont **affichés** ;
- la bascule `.next` → `.prev` est décrite ;
- config et topologie **s'accordent** sur les deux partagés ;
- `releasesDir` / `currentLink` / `envFile` ont bien **disparu** ;
- `backend/storage/` et `storage/` sont **ignorés par Git**.

`deployment-topology` : la section « certificats » lisait le plan fictif ; elle
lit désormais `certbot.js` — un `certonly` par hôte, HTTP-01 sur webroot, aucun
wildcard, aucun challenge DNS, réutilisation d'un certificat existant.

---

## 8. Fichiers

| fichier | nature |
|---|---|
| `deploy/lib/plan.mjs` | réécrit — dérive du moteur |
| `deploy/lib/config.mjs` | chemins fictifs retirés, `sharedStorage` ajouté |
| `deploy/deploy.mjs` | affiche la disposition, les liens, les réserves |
| `.gitignore` | `backend/storage/` + `storage/` |
| `tests/deploy.test.js` | garde-fous anti-divergence |
| `tests/deployment-topology.test.js` | certificats éprouvés sur leur source |
| `docs/architecture/POST_MIGRATION_PRE_DEPLOYMENT_AUDIT.md` | rév. 2 — blocker retiré, §AH ajouté |
| `docs/architecture/R10_1_…_REPORT.md` | ce rapport |

**SB Auto n'est pas modifié.**

---

## 9. Réserves honnêtes

- Ce lot **ne teste pas le pipeline sur un serveur**. Il garantit que la
  simulation dit ce que le code du moteur fait — pas que le serveur obéit. La
  vérification réelle reste l'étape 3 de la recette R10.0
  (`ls -l <siteRoot>/backend/storage`).
- Le rollback reste **inopérant** sur ce layout (§6). C'est une réserve
  affichée, pas une réserve corrigée.
- `keepReleases` survit comme réglage sans effet. Le supprimer serait plus
  propre et casserait les configurations existantes ; le choix est documenté.

---

## 10. Verdict

```
R10.1 DEPLOY SIMULATION ALIGNMENT: PASS
R10.0 BLOCKER shared/storage: WITHDRAWN (faux positif)
GO PRE-DEPLOYMENT REVALIDATION: YES
```
