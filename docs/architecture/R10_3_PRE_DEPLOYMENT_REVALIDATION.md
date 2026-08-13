# R10.3 — REVALIDATION PRÉ-DÉPLOIEMENT

> Audit **uniquement**. Aucun déploiement, aucun redémarrage, aucune donnée
> touchée, aucune correction appliquée.
>
> Objet : rejouer les invariants critiques de R10.0 sur les **nouveaux HEAD**,
> après R10.1 (alignement de la simulation) et R10.2 (rollback réel), et
> vérifier que ces deux lots n'ont rien cassé de ce qui était acquis.

---

## A. HEAD / upstream

| dépôt | HEAD | upstream | ahead/behind | arbre |
|---|---|---|---|---|
| Panel | `4cf5138` | `4cf5138` | 0 / 0 | **propre** |
| SB Auto | `f4e30f3` | `f4e30f3` | 0 / 0 | **propre** |

Aucun fichier modifié, aucun non suivi, **aucun `UNKNOWN`**.

Écart depuis l'audit R10.0 : trois commits Panel (`5386548`, `d1e05f0`,
`4cf5138`) et un commit SB Auto (`f4e30f3`).

---

## B. Ce que R10.1 et R10.2 ont touché — et ce qu'il fallait donc revérifier

| lot | fichiers | risque à revalider |
|---|---|---|
| R10.1 | `deploy/lib/{plan,config}.mjs`, `deploy.mjs`, `.gitignore` | simulation seule — aucun code d'exécution |
| **R10.2** | **`pipeline.js`**, `rollback.js`, `DeploymentEngine.js`, `index.js` (× 2 dépôts) | **le pipeline touche l'upload et la bascule du backend** |

R10.2 est le seul lot à modifier un chemin d'exécution réel. La question qui
comptait : **le backend passant désormais par `.next` → `.prev`, les liens
persistants sont-ils toujours posés ?**

---

## C. Persistance — l'invariant que R10.2 aurait pu casser

Séquence vérifiée dans `pipeline.js` :

```
 upload : rm -rf <apps>.next backend.next
          mkdir -p <apps>.next backend.next shared/uploads shared/storage/contracts
          uploadDir(artefact.backend → backend.next)
          swap : rm -rf <tous>.prev
                 if [ -d <cible> ]; then mv <cible> <cible>.prev; fi
                 mv <cible>.next <cible>
 dirs   : rm -rf backend/{uploads,storage}
          ln -sfn shared/uploads  backend/uploads
          ln -sfn shared/storage  backend/storage
          npm ci --omit=dev
```

| contrôle | résultat |
|---|---|
| `ln -sfn ${sharedRoot}/storage ${backendDir}/storage` présent | ✅ |
| `mkdir -p ${sharedRoot}/storage` présent | ✅ |
| étape `dirs` exécutée **après** la bascule | ✅ |
| `npm ci --omit=dev` toujours exécuté | ✅ |
| garde-fou L10.2 `finance-receipts` | ✅ **105/105** |

Le dossier `backend/` est neuf à chaque déploiement, et `dirs` y repose les deux
liens ensuite. **La persistance est intacte.**

### Une exposition nouvelle, analysée

`backend.prev` contient désormais `uploads` et `storage` — des **liens
symboliques vers le partagé**. Or chaque déploiement fait `rm -rf backend.prev`.

`rm -rf` **délie** un lien symbolique, il ne le suit jamais (POSIX). Les médias
partagés ne sont donc pas atteignables par cette purge.

**Réserve honnête** : c'est garanti par la sémantique de `rm`, **pas par notre
recette** — le double de test ne modélise pas les liens symboliques. La preuve
réelle est l'étape 22 du plan R10.0 : redéployer **deux fois** et relire le
justificatif déposé à l'étape 17. Si `rm -rf` suivait les liens, cette étape
échouerait. C'est le contrôle qui compte, et il est déjà au plan.

---

## D. Invariants R10.0 rejoués

| invariant | résultat |
|---|---|
| SDK Stripe absent du lockfile projet | ✅ |
| `stripe-local-surface` (8 compteurs à 0) | ✅ **71/71** |
| `stripe-final-control-plane-cutover` | ✅ 49/49 |
| `dead-provider-credentials-purge` | ✅ 61/61 |
| Hostinger : aucun client/credential local | ✅ |
| Brevo métier via `email.send_template` | ✅ |
| `SYNC_ENTITY_TYPES` identiques (18, même ordre) | ✅ |
| `CONTRACT_VERSION` 1.5.0 des deux côtés | ✅ |
| specs OpenAPI **byte-identiques** (× 2) | ✅ |
| `spec-drift` | ✅ vert |
| `bridge-conformity` Panel / SB Auto | ✅ 60/60 · 102/102 |
| médias privés : aucun `location` Nginx, aucun `express.static` | ✅ |
| `.gitignore` couvre `backend/storage/` et `storage/` | ✅ |
| `privateMedia` toujours `<backend>/storage/media` | ✅ |
| **miroir du moteur** (4 fichiers, byte-identiques) | ✅ |

---

## E. Invariants du NOUVEAU rollback

| contrôle | résultat |
|---|---|
| emplacements dérivés de `planTopology()` | ✅ `frontend`, `backend` |
| le backend a bien un `.prev` | ✅ `…/backend.prev` |
| aucun `releases/` ni `current` dans les chemins | ✅ |
| aller-retour prouvé sur les octets servis | ✅ |
| second rollback ramène au point de départ | ✅ |
| données partagées intactes après retour | ✅ |
| `.prev` incomplet ⇒ refus `ROLLBACK_PREVIOUS_CORRUPT` | ✅ |
| santé rouge ⇒ version d'origine rétablie | ✅ |
| échange interrompu ⇒ rétablissement partiel | ✅ |
| `deployment-rollback` Panel **et** SB Auto | ✅ **55/55** des deux côtés |
| `engine-genericity-e2e` (backend uploadé en `.next`) | ✅ 38/38 |
| `deployment-transactionality` (garde du miroir) | ✅ 12/12 |

---

## F. Tests, typechecks, builds

| cible | résultat |
|---|---|
| **Suite complète Panel** | **113/113 fichiers · 8051 contrôles · 0 rouge · exit 0** |
| **Suite complète SB Auto** | **86 blocs · 5119 contrôles · 0 rouge · exit 0** |
| Manager (unitaires) | exit 0 |
| Vitrine (unitaires) | exit 0 |
| Panel frontend — typecheck / build | ✅ / ✅ |
| Manager — typecheck / build | ✅ / ✅ |
| Vitrine — build | ✅ |

**13 170 contrôles, aucun rouge, aucun `UNKNOWN`.**

---

## G. Conditions d'arrêt du §27 R10.0 — revue une à une

| condition | état |
|---|---|
| HEAD non synchronisé | non |
| arbre sale non expliqué | non |
| test complet rouge non classé | non |
| drift de contrat Bridge | non |
| appel Stripe runtime local | non |
| appel Hostinger runtime local | non |
| `sendTemplate()` peut utiliser Brevo localement | non |
| credential mort requis au boot | non |
| Panel manque un credential global | non |
| TEST/PROD ambigu | non |
| webhook Stripe invérifiable | non |
| média privé servi publiquement | non |
| `shared/storage` non persistant | non |
| migration DB obligatoire non planifiée | non |
| données historiques incompatibles | non |
| scheduler financier non démarré | non |
| ledger peut doubler un revenu | non |
| refund confondu avec un cost | non |
| facture ponctuelle peut suspendre | non |
| `UNKNOWN` subsistant | non |

**Aucune condition d'arrêt n'est remplie.**

---

## H. Risques résiduels — aucun bloquant

| # | risque | gravité | traitement |
|---|---|---|---|
| 1 | Ressources Stripe **historiques** sans binding → portail/résiliation refusés | MOYENNE | à constater en recette, adoption si besoin |
| 2 | Écran « Configuration e-mail » affiche *Non configuré* sans clé Brevo locale | MOYENNE | cosmétique ; l'envoi métier fonctionne |
| 3 | **Premier déploiement : aucun `.prev` backend** → rollback indisponible | MOYENNE | **il en faut deux** ; refus explicite et nommé |
| 4 | `backend.prev` double l'espace disque du backend (`node_modules` inclus) | FAIBLE | surveiller l'espace du VPS |
| 5 | Plafond d'endpoints webhook Stripe par compte | FAIBLE | à surveiller |
| 6 | `_resetStub()` orphelin (`stripe.service.js`) | NULLE | nettoyage |
| 7 | `STRIPE_PROVIDER` mort dans `.env.example` | NULLE | dette documentaire |

Le risque **3** mérite d'être dit clairement à l'opérateur : le premier
déploiement TEST **n'aura pas de retour arrière**. C'est normal — il n'y a rien
derrière lui — et c'est précisément pourquoi le déploiement TEST doit précéder
tout déploiement PROD.

---

## I. Ce que cette revalidation ne prouve pas

- **Rien sur un serveur.** Tout est statique ou simulé. Le premier contact réel
  reste le déploiement TEST.
- **Le rollback n'a jamais tourné sur un VPS.** Sa logique est prouvée sur un
  système de fichiers fidèle ; son comportement réel se constate à la recette.
- **Les données de la démo n'ont pas été inspectées.** Les bindings Stripe
  historiques (risque 1) restent à constater sur les données réelles.

---

## J. Ordre de déploiement recommandé

1. **Panel** d'abord — il détient les capacités dont le projet dépend ;
2. vérifier `/health`, les amorçages au boot, et **`ls -l <siteRoot>/backend/storage`** ;
3. **SB Auto** ensuite ;
4. dérouler la recette R10.0 §AF, étapes 5 à 21 ;
5. **redéployer les deux une seconde fois** (étape 22) — c'est le contrôle qui
   prouve à la fois la persistance et l'existence d'un `.prev` ;
6. **puis seulement** éprouver un rollback, une fois qu'il a une cible.

---

## K. Verdict

Les deux dépôts sont synchronisés avec leur amont, propres, construisibles,
testés à **13 170 contrôles sans un rouge**, mirrorés là où la gouvernance
l'exige, sans migration obligatoire, sans credential mort requis au boot, sans
appel fournisseur local résiduel, sans drift de contrat, avec un stockage
public et privé persistant et jamais exposé — et, pour la première fois, avec
un retour arrière qui existe réellement.

Aucune condition d'arrêt n'est remplie. Les risques résiduels sont connus,
nommés, et aucun n'interdit un déploiement **TEST**.

```
PRE-DEPLOYMENT REVALIDATION: PASS
GO DEPLOYMENT TEST: YES
GO DEPLOYMENT PROD: NOT YET — subordonné à la recette TEST
```
