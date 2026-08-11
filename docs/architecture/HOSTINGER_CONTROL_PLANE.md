# Hostinger — plan de contrôle

> **Lots L9 (fondation), L9.1 (câblage), L9.2 (cutover final).** Le DNS d'un
> déploiement passe par le Panel : le projet demande un verbe, le Panel prouve
> que le nom lui appartient, puis écrit avec **sa** clé.
>
> **État : terminé.** Les trois capacités sont servies, et depuis L9.2 le projet
> n'a **plus aucun chemin Hostinger local** — ni client, ni provider, ni
> credential lu, ni écriture de secret acceptée.
>
> Rapport de cutover et résidus :
> [HOSTINGER_L9_2_FINAL_CUTOVER_REPORT.md](HOSTINGER_L9_2_FINAL_CUTOVER_REPORT.md).

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

## 7. Migration — et l'absence de repli (L9.2)

```
PANEL   capacité dns.*        ← la seule voie
NONE    aucun DNS automatique ← tout le reste, avec un motif nommé
```

`resolveDnsProvider` éprouve la voie du Panel (`verifyCredentials` résout la
zone : un aller-retour réel qui répond à « le Panel peut-il administrer CE nom
pour CE projet ? ») avant de la retenir. La retenir sans l'éprouver ferait
échouer le déploiement au milieu de la phase DNS, là où l'échec coûte le plus.

### Les trois âges du repli, et pourquoi il n'en reste rien

| Lot | Politique | Défaut |
|---|---|---|
| L9 | liste **noire** : quatre refus interdisaient le repli, **tout le reste** retombait sur la clé locale | un délai dépassé, une panne, l'inattendu rouvraient l'ancienne voie en silence |
| L9.1 | liste **blanche** : seuls `CAPABILITY_UNKNOWN` / `NOT_AVAILABLE` (déploiement progressif) | la fenêtre restait ouverte, donc la clé locale restait vivante |
| **L9.2** | **aucun repli** | — |

La condition de retrait fixée en L9.1 n'était pas une date mais un fait
observable : « un déploiement réel passé par `PANEL_CAPABILITY` ». Le
déploiement du **2026-08-11** (`demo-sbauto06.ly-solution.com`, TEST, commit
`5c615ae`) l'a rempli — zone `ly-solution.com` résolue en `managed`, wildcard
comprise, `deployment.finalize = OK`. La fenêtre s'est donc fermée, et le code
qui la portait a été **supprimé** plutôt que désactivé : un repli derrière un
drapeau reste un repli, et se rallume le jour d'un incident.

Ce qui a disparu avec elle : `withLocal()`, `hostinger.service.js`,
`hostinger.client.js`, `hostinger.dnsProvider.js`, la branche locale du
diagnostic, le champ de saisie du jeton, et `DNS_PATH.LOCAL` lui-même.

### Ce qu'une indisponibilité produit

Un motif explicite et traçable — `deployment.warning DNS_PATH_NONE`, avec la
cause (`PANEL_UNAVAILABLE:<code>`) — et un déploiement qui poursuit **sans DNS
automatique**. Jamais un contournement. `DNS_PATH_LOCAL` n'existe plus : il ne
reste aucune situation qu'il pourrait décrire.

### Prérequis d'exploitation

La bascule n'est pas seulement du code : la fiche du projet doit porter
**l'octroi des trois capacités** (`dns.zone.resolve`, `dns.records.read`,
`dns.record.ensure`) et une **destination `ACTIVE`** couvrant l'hôte déployé.
Sans octroi, le chemin se ferme — et c'est voulu.

---

## 8. Câblage — **fait** (L9.1)

Les six lignes annoncées ont été posées, après relecture. Cinq étaient encore
nécessaires ; une était devenue fausse.

| # | Fichier | Ligne | Verdict à la relecture |
|---|---|---|---|
| 1-2 | `capabilityRegistry.js` | import + `...HOSTINGER_CAPABILITIES` | **nécessaire** |
| 3-4 | `providerAdapters.js` | import + `...HOSTINGER_ADAPTERS` | **nécessaire** |
| 5-6 | `commercialReadiness.js` | deux effets `READ_ONLY` | **nécessaire** |

**Ce que la relecture a changé.** Le plan disait « en remplacement de l'entrée
`dns.record.ensure` ». Cette entrée locale n'était pas seulement redondante,
elle était **fausse sur deux points** : elle annonçait `SAFE_RETRY` — alors que
Hostinger n'expose aucune clé d'idempotence sur `PUT /zones/{zone}` — et sa note
affirmait « aucun projet ne l'invoquera », alors que le seul appelant réel du
parc est justement un projet. Les deux erreurs viennent de la même cause : la
capacité avait été décrite depuis le Panel, sans lire le code qui l'appelle.

**Trois lignes non prévues** se sont ajoutées, et elles comptent :

- `providerRegistry.js` — HOSTINGER n'annonçait qu'**un** verbe. Le contrôle
  d'alignement ne voit pas cette asymétrie (il vérifie que ce qui est annoncé
  existe, pas l'inverse) : elle serait restée invisible.
- `capabilityRegistry.assertRegistryAlignment()` — symétrie Hostinger dans les
  **deux sens**, sur le modèle de Brevo, plus l'exigence que toute capacité
  Hostinger porte `requiresResourceOwnership`.
- `run-all.js` — `hostinger-control-plane.test.js` **n'y était pas inscrit**.
  La suite complète annonçait « tout vert » sans jamais l'exécuter.

`PROPOSED_EFFECTS` a disparu, comme prévu. Un test structurel refuse sa
réapparition : une seconde table d'effets pourrait fournir un effet à une
capacité que la table officielle aurait oubliée — c'est-à-dire masquer
exactement la dérive que l'alignement doit voir.

> Le premier essai de L9 posait les deux effets directement dans
> `commercialReadiness.js`. Ils avaient dû être retirés : le contrôle
> d'alignement est **bidirectionnel** — un effet déclaré sans capacité au
> registre est une politique orpheline — et le registre, contesté, ne pouvait
> pas suivre. Les six lignes devaient donc arriver **ensemble**, et c'est ce
> qui a été fait.

---

## 9. Tests

`tests/hostinger-control-plane.test.js` — **118 assertions**, aucun réseau.

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
| `PREOPENING_ALLOWS_INFRASTRUCTURE_PREPARATION` | dérivé de L1.75 — l'effet n'est pas dans la liste interdite |

**Appartenance** — éprouvée sur les formes qu'un nom prend vraiment : hôte
exact, sous-domaine, sous-domaine profond, majuscules, point final absolu,
voisin par préfixe, domaine qui *contient* le nôtre, suffixe collé, punycode
exact et punycode voisin. Un nom Unicode brut est **refusé**, pas deviné : la
comparaison est faite sur des octets, et accepter deux écritures d'un même nom
ouvrirait la porte aux homographes. Contrôle structurel : aucun `startsWith`,
aucun `includes` sur un nom d'hôte.

`tests/hostinger-dns-cutover-e2e.test.js` — **62 assertions**, chaîne réelle :
instance SB Auto dans son processus → `resolveDnsProvider` → pont HTTP →
passerelle → coffre chiffré → faux Hostinger HTTP. Y compris un `PUT` laissé
**sans réponse** : une seule écriture part, elle n'est pas rejouée, et la clé
locale ne reprend pas la main.

---

## 10. Réserves

1. **Plus aucune fenêtre de repli** — `HOSTINGER_LOCAL_RUNTIME_CALLS = 0`, et
   trois contrôles statiques l'établissent : aucun client, aucune adresse de
   fournisseur, aucun credential lu. Un quatrième interdit la réapparition d'un
   champ de saisie.
2. **Résidu purement DATA.** Le `apiToken` chiffré des instances déjà déployées
   reste en base, **lu par personne** ; il ne peut plus être ni écrit ni supprimé
   par l'API (la garde ferme les deux verbes). Sa suppression appartient au lot
   L10, avec `IntegratedApi` en bloc. Dépréciation déclarée dans le rapport de
   cutover.
3. **L'octroi est un prérequis d'exploitation**, pas un défaut : une fiche sans
   les trois capacités accordées ferme le chemin DNS. C'est visible dans le
   rapport (`DNS_PATH_NONE`, motif `PANEL_UNAVAILABLE:CAPABILITY_NOT_GRANTED`),
   et l'écran de publication affiche le message de la plateforme, qui nomme le
   responsable.
4. **`PENDING` exclu de l'appartenance** : un premier déploiement vers un domaine
   jamais annoncé n'a pas de droit DNS côté Panel. C'est le comportement voulu
   tant qu'une destination n'est pas arbitrée — sinon l'annonce, qui vient du
   projet, deviendrait la preuve de son propre droit.
5. **`ttlApplied` n'est plus relu.** L'ancien provider relisait la zone après
   écriture pour connaître le TTL réellement appliqué. On rend le TTL demandé :
   une relecture double le coût d'un déploiement pour une information
   d'affichage.
