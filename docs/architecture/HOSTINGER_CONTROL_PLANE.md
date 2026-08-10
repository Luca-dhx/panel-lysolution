# Hostinger — plan de contrôle

> **Lot L9.** Le DNS d'un déploiement passe par le Panel : le projet demande un
> verbe, le Panel prouve que le nom lui appartient, puis écrit avec **sa** clé.
>
> **État : fondation complète, câblage final bloqué.** Les trois capacités, leur
> transport, leurs adaptateurs et le contrôle d'appartenance sont écrits et
> testés ; leur inscription au registre attend la fin du lot L3.1 (§10).

---

## 1. Ce que l'audit a trouvé — et ce qu'il corrige

La roadmap annonçait (§9.1) : *« le seul consommateur est le moteur de
déploiement du Panel lui-même : c'est en réalité une implémentation, pas une
migration »*.

**C'est faux.** Le Panel n'injecte aucun `dnsProvider` — sa phase DNS existe mais
n'est câblée nulle part. Le seul appelant réel d'Hostinger est
`SB Auto/backend/src/controllers/deployment.controller.js:1265`, avec la clé
**du projet**. L9 est donc une vraie migration, et la seule qui retire
réellement un credential d'un projet.

### 1.1 Toute la surface utilisée

L'API Hostinger expose une trentaine d'endpoints — VPS, facturation, hébergement
d'agence, snapshots, verrou de domaine, `reset` de zone. **Trois sont appelés :**

| Endpoint | Usage | Nature |
|---|---|---|
| `GET /api/domains/v1/portfolio` | `verifyCredentials`, `listZones` | lecture |
| `GET /api/dns/v1/zones/{zone}` | `listRecords` | lecture |
| `PUT /api/dns/v1/zones/{zone}` | `ensureRecord` | **écriture** |

`POST /zones/{zone}/validate` est défini côté client mais **jamais appelé** :
code mort. Aucun usage VPS, facturation ou hébergement. La mise en garde de la
mission — « ne pas supposer qu'Hostinger = seulement domaine » — est levée par
constat, pas par hypothèse.

`verifyResolution()` n'appelle pas Hostinger : c'est une résolution DNS
publique. Elle **reste locale** — la faire passer par le Panel ajouterait un
aller-retour et un point de panne pour une capacité qui n'administre rien.

---

## 2. Les trois verbes

| Capacité | Effet (L1.75) | Idempotence | Ce qu'elle rend |
|---|---|---|---|
| `dns.zone.resolve` | READ_ONLY | `SAFE_RETRY` | la zone d'un hôte, et rien d'autre |
| `dns.records.read` | READ_ONLY | `SAFE_RETRY` | les enregistrements **du demandeur** |
| `dns.record.ensure` | INFRASTRUCTURE_WRITE | `UNKNOWN_ON_TIMEOUT` | un constat d'écriture |

Trois, et pas une « gestion DNS » unique : le moteur **planifie** avec les deux
premières puis **mute** avec la troisième, et c'est cet ordre qui permet de
détecter un conflit sans avoir rien touché. Les fondre donnerait à une
planification la nature d'une écriture d'infrastructure.

**La ressource est désignée par `hostname`, jamais par `zone`.** C'est la zone
qui porte le pouvoir : laisser le projet la nommer lui permettrait de demander
`example.com` en prétendant déployer `a.example.com`. Un test refuse `zone`,
`domain`, `apiToken`, `baseUrl`, `environment` et `provider` en entrée.

---

## 3. `PANEL_GLOBAL` — l'invariant du lot

```
Hostinger n'a PAS d'environnement fournisseur.

  provider     = HOSTINGER
  scope        = PANEL_GLOBAL
  environment  = null          ← pas « TEST », pas « PROD », null
```

`resolveIntegratedApiEnvironment` rend `null` pour un fournisseur global, et
`assertEnvironmentServed(null)` laisse passer. Un projet TEST et un projet PROD
atteignent donc **le même** jeu d'identifiants — prouvé en comptant le jeton
réellement envoyé pour chacun.

Inventer un « Hostinger TEST » dédoublerait un portefeuille de domaines unique :
il n'existe qu'un compte, et un domaine n'a pas de jumeau de recette.

L'environnement de l'**instance** reste dans le contexte métier — le journal le
porte — mais il ne sélectionne aucun credential.

---

## 4. Appartenance — le cœur du lot

```
UN CREDENTIAL GLOBAL N'EST PAS UN ACCÈS GLOBAL.
```

Le compte Hostinger du Panel détient le portefeuille de **tous** les clients. Une
capacité DNS acceptant un nom quelconque donnerait à n'importe quel projet
appairé le pouvoir de réécrire le DNS de n'importe quel autre — c'est-à-dire de
détourner son trafic. Le jeton n'aurait plus besoin d'être volé : il suffirait
de le demander poliment, une ressource à la fois.

Sans ce contrôle, **centraliser aggraverait** la situation d'origine, où chaque
projet détenait au moins une clé qui n'ouvrait que son propre compte.

### 4.1 D'où vient la vérité

De `PanelProjectDestination` — la relation canonique `projectId → host`, que le
Panel tient déjà et que le projet ne peut pas écrire lui-même.

- Statut **`ACTIVE` seulement.** Une destination `RETIRED` est un souvenir de
  migration ; y fonder un droit laisserait un projet réécrire le domaine qu'il
  vient de quitter, possiblement repris depuis.
- **`PENDING` exclu**, et c'est le choix le plus discutable du lot : un projet ne
  peut pas créer le DNS d'une destination qu'il vient d'annoncer. C'est
  délibéré — sinon l'annonce, qui vient du projet, deviendrait la preuve de son
  propre droit.
- Couverture par **frontière de label** : `manager.garage-a.fr` est couvert par
  `garage-a.fr` ; `notgarage-a.fr` ne l'est pas.
- Correspondance **la plus spécifique** retenue, pour que le verdict ne dépende
  pas de l'ordre de lecture de la base.

### 4.2 La lecture ne livre pas la zone des autres

Une zone peut héberger plusieurs clients. `dns.records.read` ne rend que les
enregistrements des hôtes du demandeur — **plus la wildcard**, dont le moteur a
besoin pour constater qu'un hôte est déjà couvert. La masquer ferait créer un
enregistrement inutile : une écriture réelle causée par un aveuglement
volontaire.

Le portefeuille du compte, lui, ne sort jamais. `listZones()` **lève** côté
projet plutôt que de rendre une liste vide : une liste vide ferait conclure
« aucun domaine géré » et basculer en DNS manuel, sans que personne comprenne.

---

## 5. Sûreté d'écriture

- **Portée minimale.** `overwrite: true` chez Hostinger ne remplace que les
  couples (nom, type) transmis. On n'envoie donc **qu'un** enregistrement.
  Envoyer la zone entière « pour être sûr » effacerait tout ce qu'on n'aurait
  pas relu — y compris les enregistrements d'autres clients.
- **Aucun retry sur le `PUT`**, même sur 5xx : Hostinger a pu écrire avant de
  tomber. Les `GET`, eux, sont réessayés avec back-off.
- **Le silence est indécidable.** Un délai dépassé sur une écriture rend
  `outcome: UNKNOWN` et `CAPABILITY_TIMEOUT`, jamais `FAILED`. Un rejeu à
  l'aveugle écraserait une correction humaine survenue entre-temps.
- **Audit** : hôte, zone, nom relatif, type, TTL demandé, `correlationId` du
  fournisseur. Jamais le jeton, jamais l'URL de base.

> **Découverte en cours de route.** Le traducteur d'erreurs générique de L3 ne
> connaît que Brevo : une `HostingerTransportError` y ressortait en
> `PROVIDER_UNAVAILABLE`, c'est-à-dire en « rien ne s'est passé ». Faux, et
> exactement l'affirmation qui pousse à rejouer. Chaque adaptateur traduit donc
> désormais ses propres erreurs ; le traducteur générique reste un filet.

---

## 6. Frontière avec le moteur de déploiement

```
MOTEUR DE DÉPLOIEMENT          décide QUOI écrire, dans quel ordre,
                               et si un conflit interrompt. AUTORITÉ.
        ≠
ADAPTATEUR HOSTINGER           exécute des PRIMITIVES. Ne planifie rien,
                               ne compare rien, ne décide de rien.
```

Le moteur ne change pas d'une ligne : il dépend de l'interface `DnsProvider`,
et `docs/DEPLOYMENT_ENGINE.md` dit depuis le début qu'il ne connaît jamais
Hostinger. L9 fournit une **autre implémentation de la même interface** —
`CapabilityDnsProvider`, sans aucun credential local.

Un test vérifie que l'adaptateur ne contient ni notion de conflit, ni `dryRun`,
ni import du moteur (hors résolveur de zone) : s'il se mettait à planifier, il y
aurait deux chemins de déploiement avec deux idées de ce qu'est un conflit, et
celui qui gagnerait dépendrait de la configuration du jour.

---

## 7. Migration et repli

```
PANEL   capacité dns.*        ← tenté d'abord, éprouvé avant d'être retenu
LOCAL   clé du projet         ← repli, SEULEMENT si le Panel ne sait pas faire
NONE    aucun DNS automatique
```

`resolveDnsProvider` éprouve la voie du Panel (`verifyCredentials` résout la
zone : un aller-retour réel qui répond à « le Panel peut-il administrer CE nom
pour CE projet ? ») avant de la retenir. La retenir sans l'éprouver ferait
échouer le déploiement au milieu de la phase DNS, là où l'échec coûte le plus.

**Un refus du Panel n'autorise aucun repli.** `CAPABILITY_NOT_GRANTED`,
`BLOCKED_PREOPENING`, `PROJECT_SCOPE_MISMATCH` et `INPUT_INVALID` signifient que
le Panel sait faire et a dit non ; contourner ce « non » avec une clé locale
annulerait exactement le contrôle qu'on vient d'installer.

**Chaque repli est bruyant** : un `deployment.warning DNS_PATH_LOCAL` porte le
chemin et son motif. Un repli silencieux vers une clé locale est la pire des
situations — on croit avoir centralisé, et un secret continue de vivre dans le
projet.

---

## 8. Câblage restant

Quatre lignes, dans deux fichiers actuellement écrits par le lot L3.1 :

```js
// backend/src/services/capabilities/capabilityRegistry.js
import { HOSTINGER_CAPABILITIES } from '../integratedApi/hostinger/hostingerCapabilities.js';
// …dans CAPABILITY_DEFINITIONS, en remplacement de l'entrée `dns.record.ensure` :
...HOSTINGER_CAPABILITIES,

// backend/src/services/capabilities/providerAdapters.js
import { HOSTINGER_ADAPTERS } from '../integratedApi/hostinger/hostingerAdapters.js';
// …dans ADAPTERS :
...HOSTINGER_ADAPTERS,
```

Et deux entrées d'effet, dans un troisième :

```js
// backend/src/services/integratedApi/commercialReadiness.js — CAPABILITY_EFFECTS
'dns.zone.resolve': EFFECT.READ_ONLY,
'dns.records.read': EFFECT.READ_ONLY,
```

En attendant, `hostingerCapabilities.js` porte une table `PROPOSED_EFFECTS`.
Ce n'est **pas** une seconde vérité : la table de L1.75 l'emporte dès qu'elle
connaît un code, et `validateHostingerCapabilities()` échoue si les deux
divergent. Les trois lignes déménagent au câblage, et la constante disparaît.

> Le premier essai posait ces deux entrées directement dans
> `commercialReadiness.js`. Elles ont dû être retirées : le contrôle
> d'alignement de L3 est **bidirectionnel** — un effet déclaré sans capacité au
> registre est une politique orpheline — et le registre, contesté, ne pouvait
> pas suivre. Deux suites passaient au rouge pour une raison qui n'était pas un
> défaut.

Les définitions ont **exactement** la forme que produit la fabrique du registre,
plus un champ `requiresResourceOwnership` que la fabrique existante ignore.

Une fois câblé, la bascule est automatique : SB Auto tente déjà la capacité à
chaque déploiement et retombe en journalisant `PANEL_UNAVAILABLE:CAPABILITY_UNKNOWN`.

---

## 9. Tests

`tests/hostinger-control-plane.test.js` — **78 assertions**, aucun réseau.

| Invariant | Prouvé par |
|---|---|
| `HOSTINGER_IS_PANEL_GLOBAL` | portée, environnement résolu `null`, jeton non scopé |
| `TEST_AND_PROD_SHARE_GLOBAL_CREDENTIAL` | même jeton envoyé pour un projet TEST et un projet PROD |
| `PROJECT_CANNOT_SELECT_CREDENTIAL` | six champs interdits en entrée, zéro appel fournisseur |
| `PROJECT_A_CANNOT_TOUCH_RESOURCE_B` | refus **avant** tout appel, sans révéler ce que A possède |
| `NO_SECRET_BRIDGE` | jeton absent de la sortie et du journal ; portefeuille jamais rendu |
| `TIMEOUT_SAFE` | lecture `FAILED` / écriture `UNKNOWN` ; aucun retry sur `PUT` |
| `WRITE_AUDITED` | un seul enregistrement envoyé, TTL et corrélat conservés |
| `DEPLOYMENT_ENGINE_REMAINS_AUTHORITY` | ni conflit, ni `dryRun`, ni import du moteur |

---

## 10. Réserves

1. **Le câblage final est bloqué par L3.1.** `capabilityRegistry.js`,
   `providerAdapters.js` — et six autres fichiers de la surface des capacités —
   portaient du travail non committé d'un autre lot pendant toute la session.
   Les stager aurait committé le travail d'autrui. Les quatre lignes sont au §8.
2. **Aucun credential n'a été retiré.** Le cutover de la Phase 7 exige que la
   capacité serve réellement en production ; il appartient au lot qui suivra le
   câblage. `apiToken` reste dans le coffre du projet, et son UI de saisie aussi.
3. **`PENDING` exclu de l'appartenance** : un premier déploiement vers un domaine
   jamais annoncé retombera sur le chemin local, en le journalisant. C'est le
   comportement voulu tant qu'une destination n'est pas arbitrée côté Panel.
4. **`ttlApplied` n'est plus relu.** L'ancien provider relisait la zone après
   écriture pour connaître le TTL réellement appliqué. On rend le TTL demandé :
   une relecture double le coût d'un déploiement pour une information
   d'affichage.
