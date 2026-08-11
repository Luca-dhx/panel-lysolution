# Hostinger — rapport de cutover final (L9.2)

> **Verdict en tête de page :** voir §13. Le reste du document est la preuve.

---

## 1. Le chemin Hostinger AVANT L9.2

Trois chemins coexistaient, et c'est un de trop.

```
① NOMINAL — déjà en place depuis L9.1, prouvé en production le 2026-08-11
   DeploymentEngine → CapabilityDnsProvider → pont → Capability Gateway
   → Panel → credential Hostinger global chiffré → API Hostinger

② REPLI — fenêtre de déploiement progressif
   DeploymentEngine → HostingerDnsProvider → HostingerClient
   → clé du PROJET → API Hostinger
   déclenché par CAPABILITY_UNKNOWN | CAPABILITY_NOT_AVAILABLE

③ DIAGNOSTICS — jamais migrés
   « Tester Hostinger » (projet non appairé)  → clé du PROJET → Hostinger
   garde-fou avant publication                → lit l'état de la clé du PROJET
```

Le chemin ① était la réalité de tous les déploiements réels. Les chemins ② et ③
étaient des restes, et un reste finit toujours par servir.

## 2. Les chemins legacy qui existaient encore

| # | Surface | Ce qu'elle faisait | Déclencheur |
|---|---|---|---|
| L1 | `dnsProviderResolution.withLocal()` | instanciait le provider local | `CAPABILITY_UNKNOWN`, `CAPABILITY_NOT_AVAILABLE`, projet non appairé |
| L2 | `hostinger.service.resolveHostingerProvider()` | déchiffrait la clé du projet, fabriquait le client | appelé par L1 |
| L3 | `hostinger.client.js` | HTTP direct vers `hostinger.com` | appelé par L2 |
| L4 | `hostinger.dnsProvider.js` | implémentation locale de `DnsProvider` | appelé par L2 |
| L5 | `providerConnectionTest.testHostinger()` | branche locale si projet non appairé | bouton « Tester » |
| L6 | `hostinger.service.hostingerStatus()` | lisait `configured`/`verified` de la clé LOCALE | garde-fou de publication |
| L7 | `integratedApiCatalog.HOSTINGER.fields` | champ de saisie `apiToken` | page Intégrations |
| L8 | `PUT /integrated-apis/HOSTINGER/modes/:mode` | écrivait un secret Hostinger réel en base projet | route ouverte |

**L6 était le plus nuisible**, et il ne ressemblait pas à un problème. Un projet
sans clé locale — l'état cible — se voyait annoncer « la gestion automatique du
domaine n'est pas configurée » et renvoyer vers un écran de saisie de secret,
pendant que le déploiement fonctionnait parfaitement par le Panel. Le lot
précédent avait retiré la dépendance sans retirer le message qui l'annonçait.

## 3. Ce qui a été supprimé

**L1 à L4 — supprimés physiquement.** `withLocal()`, `hostinger.service.js`,
`hostinger.client.js` et `hostinger.dnsProvider.js` n'existent plus dans le
dépôt du projet.

> Un repli désactivé par un drapeau reste un repli : le jour d'un incident,
> quelqu'un le rallume « le temps de dépanner », et la centralisation qu'on
> croyait acquise n'existe plus sans que rien ne le signale. C'est la doctrine
> appliquée au pilote Brevo local en L8.2 — *retiré, pas contourné*.

**L5 et L6 — remplacés** par une source unique,
`integrations/hostinger/dnsControlPlaneDiagnostic.js`, qui passe par la
passerelle. Trois écrans partageaient trois implémentations ; ils en partagent
une, sans quoi c'est celle qui rassure qui aurait survécu.

**L7 et L8 — fermés à la porte.** Le catalogue déclare
`HOSTINGER: { authority: 'PANEL', fields: [] }`, et l'API **refuse** toute
écriture de credential pour un fournisseur d'autorité plateforme. Masquer
seulement le champ n'aurait fermé qu'une des deux entrées — pas celle qu'un
ancien onglet, un script de reprise ou un client HTTP emprunte.

`DNS_PATH.LOCAL` a disparu du vocabulaire : il ne reste que `PANEL_CAPABILITY`
et `NONE`.

## 4. Architecture finale

```
DeploymentEngine  (autorité d'orchestration — inchangée)
      │  interface DnsProvider
      ▼
CapabilityDnsProvider          aucun credential, aucune planification
      │  verbe + entrée métier
      ▼
Capability Gateway (Panel)     droit · ouverture commerciale · appartenance
      │
      ▼
credential Hostinger PANEL_GLOBAL, chiffré au repos
      │
      ▼
API Hostinger
```

Et son absence :

```
Panel indisponible → DNS_PATH_NONE, motif nommé, déploiement poursuivi
                     SANS DNS automatique. Jamais de contournement.
```

## 5. Reste-t-il un appel Hostinger direct depuis le projet ?

**Non.** Trois contrôles statiques l'établissent, sur l'arborescence complète du
runtime, commentaires retirés :

1. aucun module ne contient `HostingerClient`, `HostingerDnsProvider` ou
   `resolveHostingerProvider` ;
2. aucun module ne contient l'**adresse** du fournisseur — `hostinger.com`,
   `api/dns/v1`, `api/domains/v1`. Ce contrôle-là ne dépend d'aucun nom de
   classe : renommer un client ne le contourne pas ;
3. aucun module ne lit un credential Hostinger (`HOSTINGER` + `apiToken`).

`HOSTINGER_LOCAL_RUNTIME_CALLS = 0`.

## 6. Reste-t-il un credential Hostinger utilisé au runtime côté projet ?

**Non — et la donnée persistée n'a pas été détruite.**

Le document `IntegratedApi { provider: 'HOSTINGER' }` d'une instance déjà
déployée conserve son `apiToken` chiffré. Il n'est **lu par aucun chemin
d'exécution**, il ne peut plus être **écrit** (l'API refuse), et il ne peut plus
être **supprimé** par l'écran non plus — la même garde ferme les deux verbes.

C'est délibéré : supprimer une donnée chiffrée au repos n'améliore rien tant que
personne ne la lit, et une suppression est irréversible. Elle appartient au
nettoyage de données du lot L10 (« retrait des credentials projet »), avec les
autres fournisseurs, quand `IntegratedApi` disparaîtra en bloc.

**Dépréciation déclarée :** `IntegratedApi.modes.*.credentials.apiToken` pour
`HOSTINGER` est mort depuis L9.2. Aucun code ne le lit. À supprimer au lot L10.

## 7. Le Manager permet-il encore de saisir un secret Hostinger ?

**Non.** Le fournisseur reste visible sur la page Intégrations — le retirer
ferait chercher longtemps qui administre les domaines — mais :

- badge **« Aucune clé locale »** au lieu de « Configuré / Non configuré », qui
  ne voudrait rien dire pour un fournisseur sans champ ;
- **aucun** bouton « Configurer », **aucun** bouton « Supprimer » ;
- une phrase qui dit qui détient la clé et ce que fait réellement le test ;
- le bouton devient **« Gestion des domaines par la plateforme »**.

L'écran ne fait que refléter la garde : c'est l'API qui refuse.

## 8. Le diagnostic passe-t-il exclusivement par le Panel ?

**Oui**, et il distingue neuf causes, parce qu'elles ne se réparent pas au même
endroit :

| État | Qui doit agir |
|---|---|
| `PANEL_NOT_PAIRED` | appairer le projet |
| `PANEL_UNREACHABLE` | exploitation plateforme |
| `CAPABILITY_MISSING` | mettre à jour le Panel |
| `CAPABILITY_NOT_GRANTED` | accorder la capacité, ou rattacher le domaine au projet |
| `PANEL_CREDENTIAL_MISSING` | renseigner la clé **du Panel** |
| `PROVIDER_UNAVAILABLE` | fournisseur |
| `PROVIDER_TIMEOUT` | arbitrage humain — issue indéterminée |
| `ZONE_NOT_MANAGED` | DNS manuel, le domaine n'est pas au portefeuille |
| `OK` | rien, et la wildcard est signalée si elle couvre déjà l'hôte |

La résolution publique reste locale et le restera : elle interroge un résolveur
public, n'exige aucun credential et ne touche pas Hostinger. La faire passer par
le Panel ajouterait un aller-retour et un point de panne pour une capacité qui
n'administre rien.

Aucun message, aucun détail rendu ne contient de secret — un test le vérifie sur
chacun des états.

## 9. Ce qui empêche le retour du repli

| Contrôle | Où | Ce qu'il casse |
|---|---|---|
| `HOSTINGER_LOCAL_RUNTIME_CALLS = 0` | `hostinger.test.js` | réintroduction d'un client, quel que soit son nom |
| adresse du fournisseur interdite | idem | un client renommé qui parlerait quand même à `hostinger.com` |
| aucun credential lu | idem | relecture de l'`apiToken` du projet |
| `DNS_PATH` = `{PANEL, NONE}` | idem | réapparition d'une troisième voie |
| onze codes de refus → `NONE` | idem | une liste blanche qui repousserait, code par code |
| catalogue `authority: 'PANEL'`, `fields: []` | idem | retour du champ de saisie |
| `PUT` credential → **400** | E2E Panel, par la vraie route | réouverture de l'écriture par un script |

## 10. Le DeploymentEngine conserve-t-il toutes ses fonctions ?

**Oui — il n'a pas été touché.** Il dépend de l'interface `DnsProvider`, et
c'est précisément la couture prévue pour changer de chemin sans le modifier.

Vérifié : détection de zone (PSL et portefeuille), détection de wildcard,
`ensureDns` idempotent avec ses conflits (`WRONG_IP`, `CNAME_CONFLICT`,
`MULTIPLE_A`, `wildcard_covers`, `dryRun`), phase DNS complète, préflight,
Nginx, HTTPS, PM2, healthcheck public, `runtime.sync`, médias, `version.json`.

Le déploiement réel du **2026-08-11** (`demo-sbauto06.ly-solution.com`, TEST,
`195.35.0.211`, commit `5c615ae`) reste la baseline fonctionnelle : provider
`hostinger (via Panel)`, zone `ly-solution.com` en `managed`, wildcard comprise,
résolutions publiques du site et du Manager vérifiées, `deployment.finalize = OK`.

## 11. Warnings hors périmètre — audités, non refondus

### 11.1 Preflight MongoDB — le contrôle est bien faux · **non corrigé, et voici pourquoi**

**Le diagnostic est confirmé.** Le contrôle s'appelle « MongoDB accessible
(mongod/mongosh) » et n'observe qu'une chose : la présence d'un **binaire** sur
le serveur. Or l'application ne se connecte pas à un binaire, elle se connecte à
un `MONGODB_URI` — qui désigne le plus souvent une base distante. Un serveur
parfaitement sain, servant une application qui lit et écrit sans difficulté,
produit donc un avertissement permanent. Et un avertissement qui se déclenche
toujours n'avertit plus de rien : on apprend à le sauter, et le jour où il dit
quelque chose, personne ne le lit.

**La correction a été écrite, puis retirée.** Le libellé a d'abord été rendu
honnête (*« Outils MongoDB locaux (facultatif — une base distante n'en requiert
aucun) »*). Le contrôle de dérive des moteurs l'a immédiatement refusée, et il
avait raison : `deployment-engine/preflight.js` appartient au **cœur d'un moteur
standard versionné**, qui doit rester octet pour octet identique entre le Panel
et chaque projet. Le modifier n'est donc pas une correction locale — c'est une
**publication de moteur** : version bumpée, entrée d'historique,
`minimumCompatibleVersion` réévaluée, propagation à tous les projets
(`32_ENGINE_RELEASE_PROCESS.md`).

La mission autorisait la correction « si elle est simple, locale et sûre ». Elle
n'est aucune des trois. Elle est donc documentée ici, et rien n'a été modifié.

**Correctif recommandé, en deux temps.**

1. *Immédiat, sans risque* — au prochain passage de moteur : renommer le libellé
   pour qu'il décrive ce qu'il observe, et rien de plus.
2. *La vraie réponse* — remplacer la présence de binaire par une sonde de
   connectivité applicative. Elle n'est pas triviale : il faut extraire l'URI du
   `.env` distant (absent au premier déploiement), résoudre un
   `mongodb+srv://` par une requête DNS SRV, et borner le tout. À traiter comme
   une évolution de moteur, pas comme un correctif.

**Ce qui rend l'attente acceptable :** la vraie vérification existe déjà sur le
chemin réel. Le backend démarré échoue explicitement s'il ne joint pas sa base,
et `/health` le constate après la mise en service — c'est ce qui a été vert le
2026-08-11.

### 11.2 Nginx — `protocol options redefined` · **cause identifiée, non corrigé**

**Cause exacte.** Les options de protocole d'une directive `listen` (`ssl`,
`http2`) ne sont prises en compte que sur le **premier** bloc `server` déclaré
pour un couple adresse:port donné. Le générateur écrit `listen 443 ssl http2;`
dans **chaque** bloc — vitrine, manager, API — et chaque fichier de site en
ajoute d'autres. Nginx émet donc un `[warn] protocol options redefined for
0.0.0.0:443` par bloc surnuméraire. `nginx -t` reste *successful*, et les
options du premier bloc s'appliquent : le comportement est correct.

**Correctif recommandé (hors lot).** Émettre `listen 443 ssl http2;` une seule
fois et `listen 443 ssl;` ensuite. Attention : la portée du problème est
**globale au serveur**, pas locale à un fichier — plusieurs sites déployés
partagent le port 443. Un correctif par fichier réduirait le bruit sans le
supprimer. Le vrai correctif suppose soit un bloc `server` de référence unique,
soit `http2 on;` (nginx ≥ 1.25.1 seulement — le générateur documente déjà
pourquoi il ne l'utilise pas : `[emerg] unknown directive` sur Ubuntu 20.04/22.04).

### 11.3 PM2 `restarts: 17` · **normal, et déjà surveillé**

`restart_time` est un compteur **cumulé sur la vie du processus** : chaque
déploiement fait un `pm2 reload`, qui l'incrémente. Dix-sept redémarrages
répartis sur l'historique des publications ne décrivent donc rien d'anormal.

Le nombre qui décrirait un défaut est `unstable_restarts`, que le moteur lit
déjà (`ports.js`). Et surtout, le moteur ne raisonne pas sur la valeur absolue :
il **compare** le compteur avant et après l'opération, et signale un service qui
« redémarre en boucle » si le delta bouge pendant la vérification. Le rapport du
2026-08-11 ne porte aucun signalement de ce type.

**Conclusion : pas d'anomalie.** À surveiller : `unstable_restarts`, jamais
`restarts`.

## 12. Fichiers

**Supprimés** — `integrations/hostinger/hostinger.client.js`,
`hostinger.dnsProvider.js`, `hostinger.service.js`.

**Créé** — `integrations/hostinger/dnsControlPlaneDiagnostic.js`.

**Modifiés (SB Auto)** — `dnsProviderResolution.js` ·
`controllers/deployment.controller.js` · `routes/deployment.routes.js` ·
`controllers/integratedApi.controller.js` · `utils/integratedApiCatalog.js` ·
`services/providerConnectionTest.service.js` · `deployment-engine/preflight.js` ·
`manager/src/lib/api.ts` · `manager/src/pages/dev/DevIntegrationsPage.tsx` ·
`manager/src/pages/dev/deployment/DeployAssistant.tsx` ·
`scripts/hostinger.test.js` · `scripts/integrated-api-environment-routing.test.js`.

**Modifiés (Panel)** — `tests/hostinger-dns-cutover-e2e.test.js` et cette
documentation. **Aucun code du Panel n'a changé** : il était déjà l'autorité.

## 13. Tests exécutés

| Suite | Résultat |
|---|---|
| SB Auto — `hostinger.test.js` | **91 assertions**, 0 échec (74 → 91) |
| SB Auto — suite complète `backend + manager + vitrine` | **0 échec** |
| Panel — `hostinger-control-plane.test.js` | **118 assertions**, 0 échec |
| Panel — `hostinger-dns-cutover-e2e.test.js` | **63 assertions**, 0 échec |
| Panel — suite complète | **90/90 fichiers OK**, 0 échec |
| `engine-drift.check.mjs` | cœur des moteurs identique à la référence |
| Typechecks | `tsc -b` Panel · `tsc --noEmit` Manager — verts |
| Builds | `vite build` Panel · vitrine + manager — verts |

## 14. Verdict

`HOSTINGER FINAL CUTOVER: PASS`

Le runtime du projet ne possède plus aucun chemin Hostinger direct : ni client,
ni provider local, ni credential lu, ni adresse de fournisseur, ni écriture de
secret acceptée. Le seul résidu est une **donnée chiffrée au repos que personne
ne lit**, dont la suppression appartient au lot L10 et est déclarée ici.
