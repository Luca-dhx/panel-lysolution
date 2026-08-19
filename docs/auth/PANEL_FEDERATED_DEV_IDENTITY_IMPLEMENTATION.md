# LOT 2 — IDENTITÉS DEV PANEL FÉDÉRÉES DANS LES PROJETS

> **État : LOT 2A complet (socle Panel). LOT 2B — dorsale complète et prouvée,
> interface du Manager NON FAITE.**
>
> Le corps de ce document est l'audit décisionnel (Phases 0-1 du LOT 2), écrit
> avant toute modification et conservé tel quel : c'est le constat daté qui
> justifie les décisions. La section **LOT 2A IMPLEMENTATION**, en fin de
> document, décrit ce qui a été construit.
>
> **Aucun projet n'utilise encore la fédération** : SB Auto n'a pas été touché,
> conformément à la Phase 13 du LOT 2A.
>
> Périmètre lu : `Panel/backend`, `Panel/frontend`, `SB Auto 06/backend`,
> `SB Auto 06/manager`.

---

## EXECUTIVE VERDICT

**Il n'existe aujourd'hui aucune fédération d'identité. Pas « partielle » :
aucune.** La recherche exhaustive de `panelUserId`, `externalPrincipal`,
`federated`, `SSO` dans `SB Auto 06/backend/src` et `manager/src` ne rend
**aucune occurrence**.

Ce que les projets ont à la place est un **compte DEV local, amorcé par un
seed**, avec son propre mot de passe :

```text
backend/src/config/bootstrap.js:46
{ email: resolveSeedDevEmail(), password: '123dev', name: 'Développeur',
  role: ROLES.DEV, envKey: 'SEED_DEV_PASSWORD' }
```

Trois constats portent tout le dossier :

1. **Le compte DEV d'un projet n'a AUCUN lien avec un `PanelUser`.** Ce sont
   deux identités homonymes, deux mots de passe, deux cycles de vie. Désactiver
   un `PanelUser` dans le Panel ne ferme rien nulle part. Le mot de passe de
   démonstration `123dev` est en clair dans le dépôt, et le moteur de
   duplication le **propage à chaque nouveau projet** via `SEED_DEV_EMAIL`.

2. **Le canal de publication Panel → projet existe déjà, et il est bon.**
   `team.routes.js` est le précédent doctrinal exact de ce lot : l'équipe de
   l'agence est publiée par le Panel, lue localement, et **toute écriture est
   refusée avec un code** (`DEV_TEAM_MANAGED_BY_PANEL`). C'est la forme que
   doivent prendre les identités fédérées.

3. **Mais `PanelCompany.team` n'est PAS la liste des `PanelUser`** — et les
   confondre serait l'erreur de conception la plus tentante de ce lot. C'est une
   liste **vitrine** (`firstName`, `photo`, `order`, `references`), éditable à la
   main, sans `userId`, destinée à la page « Aide » du client. Elle ne porte
   aucune autorité d'authentification et ne doit pas en recevoir.

**Prêt pour la fédération ? Le transport oui — pont authentifié, canal de
publication éprouvé, `tokenVersion` déjà câblé côté Panel. L'identité non : il
n'y a rien à fédérer aujourd'hui, il y a des jumeaux à réunir.**

---

## CURRENT PANEL IDENTITY ARCHITECTURE

| objet | fichier | nature |
|---|---|---|
| `PanelUser` | `models/PanelUser.model.js` | `userId`, `email` (unique), `displayName`, `role`, `passwordHash`, `tokenVersion`, champs de reset |
| rôles | `services/auth/panelUsers.service.js:11` | `ADMIN` \| `DEV` — **DEV est un superset** |
| mot de passe | idem | **scrypt** (`hashPassword` / `verifyPassword`) |
| jeton | `services/auth/panelToken.service.js` | **JWT HS256**, `JWT_SECRET`, claims `sub`, `email`, `role`, `ver` |
| garde | `middlewares/panelAuth.middleware.js` | relit l'utilisateur **stocké** et compare `ver` à `tokenVersion` |
| reset | `services/auth/panelPasswordReset.service.js` (421 l.) | `PanelPasswordResetRequest`, e-mail `PANEL/PASSWORD_RESET_REQUEST` |
| seed | `panelUsers.service.js:90` | `seedFromEnv()` — **uniquement si AUCUN utilisateur n'existe** |

### Ce qui est déjà bon, et qu'il faut réutiliser

`requirePanelUser` **ne fait pas confiance au jeton seul** : il relit le document
et refuse si `payload.ver !== storedUser.tokenVersion`. La révocation vive existe
donc déjà **à l'intérieur du Panel** — incrémenter `tokenVersion` invalide toutes
les sessions. C'est exactement la primitive dont la Phase 16 a besoin ; il n'y a
pas à en inventer une.

### Ce qui manque pour ce lot

```text
✗ aucune notion « ce PanelUser peut accéder aux projets »
✗ aucun champ enabled/disabled  (désactiver = supprimer, ou rien)
✗ aucune primitive de signature ASYMÉTRIQUE
     grep crypto.createSign|generateKeyPair|RS256|ES256|EdDSA → 0
     grep publicKey|privateKey                                → 0
     (les seules correspondances brutes venaient de `createSignatureRequest`,
      une fonction métier Yousign, sans rapport avec la cryptographie locale)
✗ aucun endpoint d'autorisation destiné à un tiers
```

---

## CURRENT PROJECT IDENTITY ARCHITECTURE

| objet | fichier | nature |
|---|---|---|
| `User` | `models/User.model.js` | `email` (unique), `password` (**bcrypt**, `select:false`), `name`, `role`, `passwordReset` |
| rôles | `utils/constants.js:1` | `DEV` \| `ADMIN` — **même vocabulaire que le Panel, aucun lien** |
| jeton | `services/auth.service.js:12` | JWT HS256, **secret du PROJET**, claims `sub` (mongo `_id`), `role` |
| garde | `middlewares/auth.middleware.js` | relit le `User`, `authorize()` traite DEV en superset |
| reset | `auth.service.js:73` | local, e-mail `PASSWORD_RESET_REQUEST` du projet |
| comptes | `routes/account.routes.js` | CRUD complet, **DEV only** — création, mot de passe, suppression |
| écran | `manager/src/pages/dev/DevAccountsPage.tsx` | liste, création, édition, suppression, changement de mot de passe |
| session | `manager/src/context/AuthContext.tsx` | `tokenStore` (localStorage) |

### Deux surfaces à connaître avant de toucher au login

```text
GET  /api/auth/test-accounts   listTestAccounts()  — TEST uniquement
POST /api/auth/dev-login       devLogin(email)     — TEST uniquement, SANS mot de passe
```

`devLogin` est une **connexion sans mot de passe**, gardée par `config.isTest`.
Elle est hors périmètre de ce lot mais doit être citée : c'est le seul autre
chemin qui produit une session DEV, et toute recette de fédération doit prouver
qu'elle ne l'emprunte pas.

---

## LEGACY DEV ACCOUNTS — inventaire (Phase 1)

| compte | source | mot de passe local | utilisé au runtime | classement |
|---|---|---|---|---|
| `dev@mail.com` (ou `$SEED_DEV_EMAIL`) | `bootstrap.js:46`, seed | **oui** — `123dev` en TEST, aléatoire en PROD vierge | oui — toutes les routes `authorize(ROLES.DEV)` | **`LOCAL_DEV_LEGACY`** |
| `admin@mail.com` | `bootstrap.js:47`, seed | oui — `123admin` | oui | **compte métier local — à conserver** |
| tout compte créé via `DevAccountsPage` | manuel | oui | oui | **`UNKNOWN`** — à classer projet par projet |

**`PANEL_LINKED` : 0.** Aucun compte de projet ne porte de référence à un
`PanelUser`. La migration de la Phase 22 partira donc d'un ensemble vide de
liens, et devra les **établir**, jamais les relire.

### Deux gardes du seed à connaître avant de le retirer (Phase 23)

`seedDefaultUsers()` porte deux protections qu'il faudra préserver :

1. **au plus un DEV structurel** — si un `User` de rôle DEV existe, quel que soit
   son email, aucun second n'est créé ;
2. **jamais d'écrasement** — un compte existant n'est ni réécrit ni son mot de
   passe modifié.

Retirer la ligne DEV du seed est donc **sans risque pour les bases existantes**
(le compte y est déjà et survit), et change tout pour les bases neuves — ce qui
est précisément l'objectif de la Phase 24.

### Le point qui rend l'urgence réelle

`duplication-engine/duplication.js:879` **vérifie** que `SEED_DEV_EMAIL` est
écrit dans le `.env` de la copie, et échoue si la ligne est absente ou altérée.
Autrement dit : **chaque projet dupliqué reçoit aujourd'hui, par construction, un
compte DEV local avec un mot de passe local.** C'est ce que la Phase 24 interdit,
et c'est actif.

---

## TARGET FEDERATED MODEL — arbitrages tranchés

### Phase 3 — live fetch (A) ou projection (B) ?

**Décision : B pour l'AFFICHAGE, A pour l'AUTORISATION.**

La liste des DEV visible dans le manager peut être une projection (rapide, tolère
le Panel indisponible). L'**accès**, lui, ne doit jamais dépendre d'un cache :
il est porté par une assertion signée, courte, vérifiée à chaque login.

C'est la seule lecture compatible avec la phrase du lot : *« l'autorisation
d'accès ne doit JAMAIS dépendre uniquement d'un cache stale »*.

### Phase 6 — secret partagé ou signature asymétrique ?

**Décision : asymétrique.** Le lot le recommande, et l'existant l'impose :

- un secret partagé statique devrait être **distribué à tous les projets** ; un
  projet compromis pourrait alors **forger une assertion pour un autre projet**.
  C'est exactement l'isolation que la Phase 7 exige ;
- il n'existe **aucune** primitive de signature dans le Panel à réutiliser, donc
  aucun coût de migration à choisir la bonne d'emblée ;
- `jsonwebtoken` est déjà une dépendance et supporte `RS256`/`ES256` — **aucune
  dépendance nouvelle n'est nécessaire**.

Clé privée : Panel uniquement, au coffre existant. Clé publique : publiée aux
projets. `kid` obligatoire dès la v1, sans quoi la rotation sera impossible sans
coupure.

### Phase 14 — deux parcours ou détection automatique ?

**Décision : A — deux parcours explicites.** La détection par email est un
**oracle d'énumération** (« cet email est-il un compte L.Y Solution ? ») et une
UX ambiguë sur un écran d'authentification. Le lot le recommande déjà ; l'audit
ne trouve aucune raison forte de s'en écarter.

### Phase 2 — forme de la projection

```text
ExternalPrincipal {
  provider       : 'LY_SOLUTION_PANEL'
  externalUserId : panelUserId          ← clé de correspondance
  role           : 'DEV'
  enabled        : bool                 ← reflet, JAMAIS l'autorité
  displayName, email                    ← affichage seulement
  lastSeenAt, lastSyncedAt
}
```

**Interdits structurels à garder par test (Phase 19)** : `password`,
`passwordHash`, `resetToken`, `resetTokenHash`, `tokenVersion` local.

---

## AUTH FLOW — cible

```text
Manager projet : « Se connecter avec L.Y Solution »
        │
        ▼  redirection vers pairing.panelUrl, avec projectId + state
   PANEL — authentification NORMALE du PanelUser (son mot de passe, chez lui)
        │
        ▼  le Panel vérifie : rôle autorisé · projet APPAIRÉ · environnement
   assertion signée RS256/ES256
   { iss: panel, aud: projectId, sub: panelUserId, role: DEV,
     ver: tokenVersion, exp: court, jti }
        │
        ▼  callback vers le projet
   PROJET — vérifie signature · iss · aud · exp · jti (rejeu) · appairage
        │
        ▼
   session locale COURTE  { principalType: 'PANEL_USER', panelUserId, role,
                            projectId, issuedAt }   ← aucun User local créé
```

Le mot de passe du `PanelUser` **ne traverse jamais** une API du projet. C'est
l'exigence de la Phase 5, et c'est ce que la redirection achète.

---

## CE QUI RESTE À FAIRE — rien de ce qui suit n'est livré

| phase | travail | dépendance |
|---|---|---|
| 2 | modèle `ExternalPrincipal` + garde « aucun secret » | — |
| 4-6 | clés, émission, contrat d'assertion | coffre existant |
| 5, 29 | parcours de login projet + « Problème d'accès ? » | UI manager |
| 7-8 | audience stricte, appairage obligatoire | assertion |
| 9 | `canAccessProjectsAsDev` sur `PanelUser` | modèle Panel |
| 10, 28 | liste projet avec badges, sans bouton de mot de passe | projection |
| 11-13, 16-17 | révocation, changement de mot de passe, reset | `tokenVersion` |
| 22-24 | migration legacy `--dry-run`, retrait du seed, duplication | tout ce qui précède |
| 30-34 | journalisation, tests Panel / projet / multi-projets | tout |
| 35-36 | recettes navigateur et réelle | tout |

**Point de vigilance pour la Phase 23 :** le `bootstrapResponseSchema` du pont
est `.strict()` (`bridgeContract.js:917`). Publier une clé publique par le
bootstrap **impose un incrément de version de contrat**. Le
`companyProfileSchema`, lui, est `.passthrough()` : un champ additif y passe sans
rupture. Le choix du canal n'est donc pas neutre et doit être fait avant d'écrire
la première ligne.

---

## REMAINING RISKS — état actuel, avant tout correctif

| # | risque | gravité |
|---|---|---|
| 1 | Mot de passe DEV `123dev` en clair au dépôt, propagé à chaque projet dupliqué | **élevée** |
| 2 | Désactiver un `PanelUser` ne ferme aucun accès projet — il n'y a pas de lien | **élevée** |
| 3 | `PanelUser` n'a pas de champ `enabled` : désactiver, c'est supprimer | moyenne |
| 4 | Le Panel n'a aucune notion « ce compte peut accéder aux projets » : tout DEV Panel serait autorisé partout dès la fédération branchée | moyenne |
| 5 | `POST /api/auth/dev-login` — session DEV sans mot de passe (TEST uniquement) | faible, à citer en recette |

---

## FINAL VERDICT (de l'audit)

```text
PANEL USER    identité centrale RÉELLE, avec tokenVersion et reset propres
PROJECT USER  identité locale RÉELLE, avec son mot de passe
LIEN ENTRE    aucun
FÉDÉRATION    inexistante — pas « incomplète » : absente

CANAL         le pont existe, il est authentifié, et team.routes.js prouve que
              la doctrine « le Panel publie, le projet lit, l'écriture est
              refusée » fonctionne déjà en production
MANQUE        la signature asymétrique, l'autorisation projet côté Panel,
              et le parcours de login
```

**Le lot est faisable sans rien réinventer : `tokenVersion` porte déjà la
révocation, le pont porte déjà la publication, et `team.routes.js` porte déjà la
doctrine. Ce qui manque est une primitive de signature et un parcours — pas une
architecture.**

---

# LOT 2A IMPLEMENTATION

> Socle Panel uniquement. Le Panel sait désormais **affirmer**, à un projet
> précis et pour trois minutes, qu'un porteur est un développeur autorisé.
> Personne ne consomme encore cette affirmation.

## KEY STRATEGY

**RS256, tranché par l'exécution et non par la documentation.**

Le lot demandait EdDSA/Ed25519 « si `jsonwebtoken` et le runtime le supportent
proprement ». La question a été posée au code :

```js
jwt.sign({}, ed25519Key, { algorithm: 'EdDSA' })
→ « "algorithm" must be a valid string enum value »
```

`jsonwebtoken@9` ne connaît pas EdDSA — son moteur `jwa` ne l'implémente pas.
Les deux options réelles étaient RS256 et ES256, toutes deux asymétriques et
standard. **RS256** est retenu : c'est le repli que le lot nomme, et c'est
l'algorithme qu'un vérificateur non-Node — un futur projet dans une autre stack
— trouvera implémenté partout. Le contrôle qui prouve l'absence d'EdDSA est dans
la recette : il **échouera** le jour où ce sera faux, ce qui est le bon signal
pour rouvrir le choix.

Modulus 2048 : une assertion vit trois minutes. Doubler la taille doublerait le
coût de signature sur un chemin interactif pour une marge qui n'a de sens que
sur des secrets de longue durée.

### Stockage

| élément | forme | où |
|---|---|---|
| clé publique | PEM SPKI, **en clair** | `PanelFederationKey.publicKeyPem` |
| clé privée | PEM PKCS#8, **AES-256-GCM** | `PanelFederationKey.privateKeyEncrypted` |

Le chiffrement réutilise `panelCrypto` — la primitive qui protège déjà la copie
du `bridgeToken`. Aucune clé privée n'est en dur, aucune n'est committée (un
contrôle balaie le dépôt pour `BEGIN PRIVATE KEY`), aucune n'est journalisée,
aucune n'est rendue par une API. `signingKey()` est la seule fonction qui
déchiffre, et sa valeur n'est liée à aucune variable de portée large.

L'algorithme est une **énumération fermée** dans le schéma. Un champ libre
laisserait entrer `none` ou `HS256` depuis la base — et `HS256` avec une clé
publique comme secret est la confusion d'algorithme classique.

### Rotation

Le format la permet sans coupure, et la recette l'exécute :

```text
1. createKey({ activate: false })   la nouvelle est PUBLIÉE, elle ne signe pas
2. le JWKS porte les DEUX           les vérificateurs la connaissent
3. activateKey(kid)                 bascule de la signature
4. attendre ~3 min                  les assertions en vol expirent
5. retrait de l'ancienne            (geste d'exploitation, pas encore d'UI)
```

L'étape 2 est la raison d'être de la manœuvre : sans recouvrement, toute
rotation serait une coupure — donc une rotation qu'on ne fait jamais, donc une
clé qui finit par fuiter.

## PUBLIC KEY CONTRACT

```text
GET /api/federation/.well-known/jwks.json     PUBLIC, sans session
Cache-Control: public, max-age=300
```

**Contrat dédié, comme le lot l'exige.** Ni `PanelCompany.team` (vitrine sans
`userId`), ni `bootstrapResponseSchema` — celui-ci est `.strict()`, y glisser une
clé imposerait un incrément de version du contrat de pont ; et surtout le
bootstrap est un acte joué **une fois** alors qu'une clé **tourne**.

JWKS plutôt qu'un PEM parce qu'un PEM ne porte pas de `kid` : au premier jour de
rotation, un projet qui n'a qu'un PEM doit essayer toutes les clés, et ne peut
pas distinguer « signature fausse » de « mauvaise clé essayée ».

Chaque entrée porte `kid`, `use: 'sig'`, `alg`, et un `status` informatif
(non standard, assumé — la sécurité ne repose jamais dessus).

### Piège d'ordre de montage — à connaître

`app.use('/api', eventsRoutes)` pose `requirePanelUser` en `router.use`, ce qui
s'applique à **toute** requête `/api/*` qui l'atteint. Le routeur de fédération
est donc monté **avant** cette ligne, à côté de `/api/public`. Monté après, le
JWKS renvoyait 401 — symptôme constaté puis corrigé pendant ce lot.

## ASSERTION CLAIMS

```text
iss  urn:ly-solution:panel        URN, pas URL — l'adresse publique peut changer
aud  <PanelProject.projectId>     UUID stable, l'identité que le pont prouve déjà
sub  <PanelUser.userId>           stable
iat / exp / jti
principalType  PANEL_USER
panelUserId    = sub
role           DEV
tokenVersion   LU EN BASE à l'émission
environment    TEST | PROD
kid            dans l'EN-TÊTE, pas dans les claims
```

`kid` en en-tête parce qu'un vérificateur doit choisir sa clé **avant** de faire
confiance à quoi que ce soit — donc avant de lire un claim non vérifié.

**Ce que l'assertion ne porte pas** : ni nom, ni adresse e-mail. Ils viendront de
la projection du LOT 2B, où ils pourront être corrigés ; les figer ici en ferait
des copies périmées. Un contrôle vérifie qu'aucun `@` n'y figure.

**`aud` = `projectId`** et non `projectKey` ni un domaine : c'est l'identifiant
que `buildInvocationContext` prouve déjà par le jeton de pont, il est immuable,
et il ne dépend d'aucune décision commerciale.

## TTL

**180 secondes**, au milieu de la fourchette 2-5 min du lot.

L'assertion voyagera dans une URL de redirection : elle finira dans un historique
de navigateur, potentiellement dans un journal de reverse proxy, et dans un
`Referer`. Sa durée de vie est la fenêtre pendant laquelle une fuite est
exploitable, et le seul geste qu'elle autorise prend deux secondes.

Trois minutes et non trente secondes : un poste dont l'horloge dérive d'une
minute rendrait la fédération aléatoire, et le diagnostic serait atroce.
Tolérance d'horloge à la vérification : **30 secondes**.

## AUTHORIZATION RULES

Huit contrôles, dans cet ordre — l'identité avant le projet, pour qu'un compte
désactivé ne révèle pas par la nature du refus quels projets existent :

```text
1. utilisateur RELU EN BASE      jamais l'objet de la session HTTP
2. enabled                       FEDERATION_USER_DISABLED
3. rôle                          FEDERATION_ROLE_FORBIDDEN
4. projet existe                 FEDERATION_PROJECT_UNKNOWN
5. appairage PAIRED              FEDERATION_PROJECT_NOT_PAIRED
6. accès à CE projet             FEDERATION_PROJECT_ACCESS_DENIED
7. mondes concordants            FEDERATION_ENVIRONMENT_MISMATCH
8. clé signante disponible       FEDERATION_KEY_UNAVAILABLE
```

### Décision sur ADMIN — explicite, comme le lot l'exige

**Seul `DEV` obtient une assertion. `ADMIN` est refusé.**

La doctrine du Panel est déjà écrite dans `requirePanelDev` : les surfaces
techniques sont réservées au rôle DEV. Entrer dans le manager d'un projet client
avec les droits développeur est une surface de la même nature. On note
l'asymétrie apparente — « DEV est un superset d'ADMIN » à l'intérieur du Panel :
cela ne rend pas ADMIN plus autorisé, cela rend DEV plus large. Un ADMIN du
Panel n'est pas un développeur.

## PAIRING RULES

`PAIRED` seul autorise. `DECLARED` et `REVOKED` refusent, avec le même code —
la nuance entre « pas encore » et « plus jamais » appartient à la fiche projet,
pas à un refus d'accès.

Aucun `capabilityGrants` n'a été réintroduit : le chantier voisin l'a supprimé
délibérément, et ce lot ne le contredit pas.

## PROJECT ACCESS MODEL

```text
PanelUser.projectAccess {
  mode: NONE | EXPLICIT | ALL_PAIRED
  projectIds: [...]        lu UNIQUEMENT en EXPLICIT
  grantedAt, grantedBy
}
```

**`NONE` par défaut, y compris pour un DEV, y compris au backfill.** Le rôle ne
suffit pas : l'accès est un acte, daté et attribué. C'est la lecture stricte de
« ne pas coder tous les PanelUser → tous les projets ».

Conséquence assumée : **la fédération est inerte tant qu'aucun accès n'a été
accordé.** C'est le bon sens de la marche — on ouvre, on ne referme pas.

Asymétrie avec `enabled`, qui vaut `true` au backfill : les deux défauts ne
portent pas le même risque. `enabled: true` préserve un accès qui existait déjà ;
`projectAccess: ALL_PAIRED` en créerait un qui n'a jamais existé.

## PANELUSER — enabled vs tokenVersion

Deux notions **distinctes**, et le lot avait raison d'insister :

```text
enabled       le compte a-t-il le droit d'exister comme identité
tokenVersion  les sessions déjà émises sont-elles encore valables
```

`setUserEnabled(id, false)` fait **les deux** : `enabled: false` **et**
`tokenVersion++`. Sans l'incrément, le compte ne pourrait plus se reconnecter
mais ses sessions ouvertes vivraient jusqu'à expiration — or on désactive
précisément quand on veut que ça s'arrête maintenant.

Réactiver ne touche **pas** `tokenVersion` : les sessions d'avant ne
ressuscitent pas.

`requirePanelUser` refuse désormais trois cas — compte absent, désactivé,
version périmée — avec **un seul message** : distinguer « désactivé » de
« inconnu » renseignerait un porteur de jeton volé sur ce qui est arrivé au
compte.

## ISSUANCE ENDPOINT

```text
POST /api/federation/projects/:projectId/assertion
     requirePanelUser + requirePanelDev
```

Le corps **n'est pas lu**. Neuf champs y sont explicitement refusés
(`FEDERATION_IDENTITY_IN_BODY`) : `panelUserId`, `userId`, `sub`, `role`,
`tokenVersion`, `enabled`, `projectAccess`, `kid`, `exp`. Ils seraient inertes —
mais un champ toléré finit par être branché « puisqu'il était déjà envoyé ».
C'est la leçon du LOT 1, appliquée d'avance.

Le sujet vient de la session prouvée ; le rôle et la version sont **relus en
base** au moment de signer ; le projet vient du chemin, validé contre le registre.

## TESTS

`tests/federation-assertion.test.js` — **103 contrôles, 0 échec**, clés
générées à chaque exécution, jamais committées.

```text
1  enabled/projectAccess, backfill idempotent, désactivation à deux gestes
2  clé privée chiffrée, publique en clair, JWKS sans composante privée
3  JWKS lisible SANS session ; catalogue et émission exigeant une session
4  claims du contrat, TTL 2-5 min, aucune adresse dans l'assertion
5  AUDIENCE : A→A PASS, A→B FAIL, B→B PASS, B→A FAIL, jti distincts
6  ALTÉRATION : sub/aud/role/tokenVersion/exp modifiés → FAIL
   « alg: none » → FAIL ; HMAC signé avec la CLÉ PUBLIQUE → FAIL
7  EXPIRATION par horloge simulée ; dérive de quelques secondes tolérée
8  disabled / ADMIN / sans accès / hors liste EXPLICIT / DECLARED /
   REVOKED / projet inconnu / monde divergent → six codes distincts
9  tokenVersion LIVE : 4 puis 5, l'ancienne assertion reste un fait daté
10 ROTATION avec recouvrement ; clé inconnue distinguée d'une signature fausse
11 surface HTTP : six champs d'identité refusés dans le corps ;
   désactiver le compte invalide la session EN COURS
12 journal : cause sur chaque refus, aucune assertion brute
13 aucune clé privée au dépôt ; la liste noire « 123dev » doit EXISTER
```

## SECURITY

- aucun mot de passe, hash ni jeton de reset ne quitte le Panel ;
- signature asymétrique — un projet compromis ne peut pas forger l'assertion
  d'un autre, ce qu'un HMAC partagé aurait permis ;
- algorithme **imposé** à la vérification, jamais lu du jeton ;
- contrat de claims vérifié **après** la signature : une signature valide prouve
  que nous avons émis, pas que nous avons émis ce qu'on croit lire ;
- journal : `panelUserId`, `projectId`, `reasonCode`, `kid`, `jti`, `expiresAt`.
  Jamais le jeton, jamais un PEM. Le `jti` est écrit entier — il n'ouvre rien
  seul et sera la poignée qui rapprochera, au LOT 2B, une émission d'une
  consommation.

### Le mot de passe DEV historique (Phase 25)

Le Panel possède **déjà** une liste noire (`KNOWN_SEED_PASSWORDS`, `env.js`) qui
refuse ces mots de passe en PROD. La garde ajoutée vérifie deux choses : que
cette liste **existe encore**, et qu'aucun autre fichier du Panel n'utilise ces
chaînes.

> Une première version de la garde signalait `env.js` et `config.test.js` —
> c'est-à-dire la défense elle-même. Une chaîne n'est pas un secret par sa valeur
> mais par son **usage** ; la garde distingue désormais les deux.

Le retrait côté projet reste le LOT 2C. Rien n'a été cassé chez les projets
existants.

## REMAINING RISKS (après LOT 2A)

| # | risque | gravité |
|---|---|---|
| 1 | Le mot de passe DEV historique reste propagé par la duplication (dépôt voisin) | **élevée** — LOT 2C |
| 2 | Aucun écran pour accorder `projectAccess` : la fédération est inerte sans intervention par service | moyenne |
| 3 | Aucun écran de rotation de clé ; l'étape 5 (retrait) est manuelle | moyenne |
| 4 | Pas d'anti-rejeu : le `jti` est émis, personne ne le consomme encore | ✅ **fermé par le LOT 2B** |
| 5 | `POST /api/auth/dev-login` (projet, TEST) reste un second chemin vers une session DEV | faible, à citer en recette 2B |

---

# LOT 2B IMPLEMENTATION

> Dorsale complète et éprouvée : SB Auto vérifie réellement les assertions du
> Panel, ouvre une session développeur courte, et la coupe quand le Panel
> révoque. **L'interface du Manager n'est pas faite** — voir la fin de section.

## JWKS CLIENT

`backend/src/services/federation/panelJwks.client.js`

L'URL vient de l'**appairage**, jamais du code : aucun domaine n'est écrit dans
le projet, et le parcours survit à un changement de domaine du Panel sans
redéploiement.

Cache de 5 minutes, mais **la vraie règle est ailleurs** : un `kid` inconnu du
cache force une relecture immédiate — une seule, pour qu'un `kid` inventé au
hasard ne provoque pas un aller-retour réseau par tentative. Une rotation est
donc prise en compte à la première assertion qui la porte, sans attendre
l'expiration du cache. Sans cela, toute rotation coûterait cinq minutes de
refus, et l'on ne tournerait jamais les clés.

Entrées filtrées à l'entrée du cache : sans `kid`, non-RSA, ou annoncées pour un
autre algorithme. Le vérificateur ne doit jamais se demander si une clé qu'il
tient est utilisable.

### Le passage par la façade — et pourquoi

`bridge-conformity` interdit au métier d'importer le module de pont, avec deux
exceptions déclarées : le vocabulaire, et `capabilityClient.js`. Le service de
fédération passe donc par cette façade, à laquelle trois verbes ont été ajoutés :
`panelUrlForFederation()`, `projectIdForFederation()`,
`introspectFederatedPrincipal()`. Importer `pairingStore` directement aurait
donné au service d'authentification l'accès à l'appairage entier — **jeton
compris**.

## ASSERTION VERIFICATION

`backend/src/services/federation/assertionVerifier.js`

```text
1. la forme          un JWT, en-tête lisible
2. le kid            présent — sinon on ne sait pas quoi essayer
3. la clé publique   obtenue du Panel, jamais du jeton
4. la SIGNATURE      algorithme IMPOSÉ (['RS256'])
5. iss / aud / exp   par la bibliothèque, pas à la main
6. le contrat        principalType, role, panelUserId===sub, tokenVersion, jti
7. iat pas dans le futur   (la bibliothèque ne contrôle pas ce sens-là)
8. environment       refusé seulement s'il DIVERGE
```

`jwt.decode` n'est appelé **que** pour lire le `kid`, et sa sortie ne sert à
rien d'autre. Trois pièges du format fermés et éprouvés : `alg: none`, HMAC
signé avec la clé publique, clé étrangère.

**L'audience vient de l'appairage** (`projectIdForFederation()`), pas d'une
configuration : une audience mal recopiée à la main accepterait les assertions
d'un autre projet. Bénéfice de bord — un projet dupliqué reçoit son propre
identifiant à son appairage et refuse les assertions de son modèle sans
reconfiguration.

## EXTERNAL PRINCIPAL

`backend/src/models/ExternalPrincipal.model.js` — collection **séparée** de
`User`, et c'est structurel, pas esthétique.

`User` porte `password` (requis), un hook de hachage, `comparePassword`, et un
CRUD DEV qui permet d'en changer. Une identité Panel logée là aurait un mot de
passe — inventé mais réel — donc une surface de connexion locale que personne
n'aurait décidée, et un bouton « réinitialiser » sur une identité que ce projet
ne possède pas. Deux collections rendent cela **impossible** plutôt
qu'**interdit**.

`enabled` est un **reflet** pour l'écran : la sécurité ne le lit jamais, elle
redemande au Panel.

## ANTI REPLAY

`FederatedAssertionConsumption` — **SHA-256 du `jti`**, jamais le `jti`. Stocker
en clair ferait de cette collection une liste de laissez-passer ayant existé,
sans valeur pour nous et d'une valeur certaine pour qui lirait une sauvegarde.

L'**index unique** arbitre, pas une lecture préalable : deux callbacks
simultanés passeraient tous deux un `findOne`. Prouvé — sur deux callbacks
concurrents portant la même assertion, exactement un aboutit.

TTL Mongo à `expiresAt + 1 h` : la marge absorbe la tâche de fond (~1 min) et
une dérive d'horloge. Purger trop tôt rouvrirait la fenêtre.

## SSO STATE

`FederatedLoginState` — usage unique, 10 minutes, consommation **atomique**
(`consumedAt: null` dans la requête).

**`state` et `jti` ne protègent pas de la même chose**, et la recette le
démontre : une assertion parfaitement valide et jamais consommée est refusée
faute de voyage légitime. Sans `state`, un attaquant provoque un callback avec
SA propre assertion — authentique, `jti` neuf — dans le navigateur de sa
victime, et ouvre chez elle une session à son nom. Rien dans l'assertion ne dit
qui a demandé le voyage ; c'est le `state` qui le dit.

`redirectPath` est validé **à l'émission** : chemin relatif, jamais `//host`,
jamais une URL absolue. Sinon le parcours de connexion serait une redirection
ouverte.

## CALLBACK

```text
GET  /api/auth/federated/panel           la fédération est-elle disponible ici ?
POST /api/auth/federated/panel/start     ouvre un parcours (émet le state)
POST /api/auth/federated/panel/callback  assertion + state
```

Publiques par nécessité — personne n'est authentifié à ce stade. Six champs
d'identité sont **refusés** dans le corps du callback
(`FEDERATED_IDENTITY_IN_BODY`) : les accepter donnerait deux sources pour la
même information, et un jour quelqu'un lirait la mauvaise.

## PROJECT SESSION

```text
principalType  PANEL          ← ce qui distingue les deux populations
panelUserId · role · projectId · source · panelTokenVersion · revalidatedAt
```

Signée avec le secret **du projet** : le Panel a affirmé une identité, ce qu'on
en fait nous appartient. **30 minutes**, contre 7 jours en local — la durée de
session est la borne haute du délai de révocation dans le pire cas (Panel
injoignable).

Un jeton fédéré porte `principalType` et aucun `sub` exploitable localement ; un
jeton local porte `sub` et aucun `principalType`. Ils ne peuvent être confondus
dans aucun sens.

## LIVE REVOCATION

Revalidation au plus **toutes les 5 minutes**. Interroger à chaque requête
ferait dépendre chaque page de la disponibilité du Panel ; ne jamais interroger
rendrait la session aveugle trente minutes.

**Compromis assumé et borné** : un accès retiré peut survivre jusqu'à 5 minutes,
et la session entière expire en 30 même si le Panel reste muet.

Panel injoignable : une session **en cours** survit (mode dégradé signalé) —
refuser ferait d'une coupure Panel une coupure de tout le parc. Une **nouvelle**
connexion est refusée : ouvrir un accès qu'on n'a pas pu confirmer serait
accorder sur la seule assertion, qui a pu être émise avant une désactivation.

Quatre causes de révocation éprouvées, **sans aucune mutation de la base du
projet** : `tokenVersion` incrémenté, `enabled: false`, `projectAccess` retiré,
`projectAccess` pointant un autre projet.

## PRINCIPAL MODEL

`req.principal` porte la vérité typée (`LOCAL_USER` | `PANEL_USER`).
`req.user` reste renseigné **avec la même forme** dans les deux cas — les trente
contrôleurs qui le lisent n'ont pas été touchés.

`_id: null` pour une identité fédérée : elle n'a aucun document local, et
inventer un identifiant ferait écrire dans des champs `ref: 'User'` une valeur
qui ne désigne rien. Tous ces champs sont `default: null`.

Un bug réel corrigé au passage : `account.controller.js` faisait
`req.user._id.toString()` sans garde — un développeur du Panel supprimant un
compte client aurait reçu « Erreur interne ».

Deux primitives : `requireDevPrincipal` (les deux sources), `requireLocalPrincipal`
(profil et mot de passe — une identité Panel n'en a pas ici).

## TESTS

`backend/src/scripts/federated-dev-identity.test.js` — **81 contrôles, 0 échec**.

**Un vrai Panel en face**, pas un double : le service d'émission du Panel est
importé et signe de vraies assertions avec de vraies clés, dans sa propre
connexion Mongo. Un double produirait des jetons que nous saurions vérifier —
il éprouverait notre accord avec nous-mêmes.

```text
1  la projection ne peut porter aucun secret (7 champs interdits)
2  parcours nominal ; AUCUN mot de passe Panel dans TOUTE la base du projet
3  audience : assertion du voisin refusée, acceptée chez le voisin
4  altération sub/role/tokenVersion/exp · alg:none · HMAC clé publique ·
   clé inconnue · émetteur étranger · expiration (horloge simulée)
5  rejeu : second usage refusé ; jti stocké en EMPREINTE ;
   deux callbacks concurrents → exactement un
6  state : inventé / consommé / expiré refusés ;
   assertion valide SANS voyage → refusée
7  révocation live : tokenVersion, enabled, projectAccess retiré,
   projectAccess d'un autre projet — sans toucher la base du projet
8  comptes locaux intacts ; MÊME E-MAIL local et Panel → jamais fusionnés
9  Panel injoignable : session en cours survit, nouvelle connexion refusée
10 aucune surface locale sur une identité Panel ; jeton jamais interpolé
```

> Deux gardes ont dû être **corrigées** parce qu'elles confondaient le mot et la
> valeur : la première signalait `logger.warn('assertion refusée')` comme une
> fuite. Même classe d'erreur que la garde `123dev` du LOT 2A. Une chaîne n'est
> pas un secret par son nom mais par son usage.

Régression : SB Auto `bridge-conformity` 105/0, `auth-password-reset` 25/0,
`contact` 269/0, `email-delivery` 183/0, `email-templates` 223/0,
`bridge-persistence` 31/0, `control-plane` 29/0 · Panel `federation-assertion`
103/0, `auth` 36/0, `bridge-conformity` 61/0, `bridge-http` 92/0,
`architecture` 31/0, `supervision` 128/0 · `spec-drift` identique.

## CONTRAT DE PONT

`POST /bridge/v1/federation/introspect` — ajouté au contrat, **documenté dans
les deux specs OpenAPI** (identiques, `spec-drift` vert), et déclaré dans les
deux miroirs `PANEL_API_ROUTES`. Le compte de chemins du garde-fou est passé de
8 à 9 **et la route est nommée** : un chemin de plus doit se déclarer, jamais
se fondre dans un comptage.

La réponse ne dit **jamais pourquoi** elle refuse : « inconnu », « désactivé »
et « sans accès ici » sont indistinguables. Un projet compromis pourrait sinon
énumérer les employés de l'agence. La réaction du projet est de toute façon la
même — fermer la session.

## CE QUI N'EST PAS FAIT

| | état |
|---|---|
| **UI Manager — login à deux blocs** | **non faite** |
| **UI Manager — liste des accès L.Y Solution** | **non faite** |
| **Recette navigateur** | **non jouée** (dépend de l'UI) |
| Seed DEV legacy, `123dev` | intacts — LOT 2C, par conception |
| `dev-login` TEST | inchangé, non audité dans ce lot |

La dorsale est complète : `/start` et `/callback` fonctionnent et sont
éprouvés. Ce qui manque est l'écran qui les appelle. Je ne l'ai pas écrit en
fin de session : toucher un écran d'authentification fatigué est la mauvaise
façon de finir un lot de sécurité.

> **Ce tableau est périmé depuis le LOT 2B-UI, ci-dessous.** Il est conservé
> parce qu'il datait un état réel — et parce que la suite explique exactement
> ce qui l'a levé.

---

# LOT 2B-UI IMPLEMENTATION

> Le parcours navigateur existe, de bout en bout. Deux écrans ont été créés
> (autorisation côté Panel, retour côté Manager), un bloc ajouté à la connexion,
> et **une redirection ouverte a été fermée avant d'exister**.

## LA FAILLE TROUVÉE EN CONSTRUISANT — et fermée d'abord

Le parcours se termine par une redirection qui **transporte l'assertion**. Le
premier réflexe est de laisser l'appelant nommer l'adresse de retour. Ce
réflexe est une vulnérabilité :

```text
/federation/authorize?projectId=…&returnUrl=https://malveillant.test/vol
```

Envoyez ce lien à un développeur **déjà connecté au Panel**, et le Panel émet
une assertion parfaitement valide — pour un projet auquel il a réellement accès
— puis la livre à l'attaquant. Rien n'a été forcé : on la lui a **donnée**.
C'est une redirection ouverte, en pire, puisque le butin voyage avec la victime.

`federationReturnUrl.js` la ferme, et l'ordre compte : **on valide avant
d'émettre**, pour ne pas laisser au journal la trace d'un jeton qui ne partira
pas.

| règle | pourquoi |
|---|---|
| origine ∈ origines **connues du Panel pour CE projet** | une adresse qu'un opérateur a enregistrée, pas une adresse qu'un lien propose |
| comparaison d'**origines**, jamais de préfixes | `https://client.fr.malveillant.test` commence bien par `https://client.fr` |
| `https`, sauf boucle locale | une assertion en clair sur un réseau est une assertion lue |
| **aucune origine connue ⇒ refus** | accepter « faute de comparaison » serait exactement la faille |
| l'URL est **recomposée** (origine + chemin) | une query ou un fragment reçus masqueraient ce qu'on s'apprête à ajouter |

Sources d'origines : URL manager des destinations non supprimées, puis
`runtime.publicBackendUrl` en filet. Toutes déjà connues du parc avant que ce
parcours existe.

## LOGIN UX

```text
Compte SB Auto              ← formulaire local, inchangé
  Email / Mot de passe
  [Se connecter]
  Mot de passe oublié ?     ← local uniquement, dans le formulaire local

──────── Accès L.Y Solution ────────

  [Se connecter avec L.Y Solution]
  Réservé à l’équipe technique. Votre mot de passe reste sur le Panel.
```

Bloc **séparé**, variante `outline` : le bouton principal de l'écran reste la
connexion au compte du projet. Le composant **n'a ni champ, ni formulaire** —
et ne peut donc pas collecter un mot de passe du Panel. Un contrôle vérifie
qu'il n'existe qu'**un seul** champ mot de passe sur l'écran.

## FEDERATION STATUS

`GET /api/auth/federated/panel` → `{ available, provider, label }`.

**Précondition locale, pas un ping** : appairage présent, URL du Panel connue,
identité de projet connue. Faire dépendre l'écran de connexion d'un aller-retour
vers le Panel rendrait le login **local** tributaire de sa disponibilité —
exactement ce que ce lot interdit. Un Panel momentanément muet laisse donc le
bouton visible, et l'échec survient au clic, avec un message clair : masquer le
bouton ferait croire à un DEV que son accès a été retiré.

Projet non appairé ⇒ `available: false` ⇒ **le bloc ne s'affiche pas**.

## START FLOW / PANEL REDIRECT

`POST /start` rend `{ state, projectId, authorizeUrl, expiresAt }`.

**L'URL entière est composée par le serveur du projet**, pas par le navigateur.
Si l'écran l'assemblait, `projectId` deviendrait une valeur que la page connaît
et peut modifier, et le `state` un paramètre qu'elle recopie. L'écran n'a qu'un
geste : y aller.

Aucun domaine en dur — vérifié par test sur les trois fichiers du parcours.
L'adresse du Panel vient de l'appairage ; le parcours survit à un changement de
domaine sans redéploiement.

## CALLBACK

Panel → `https://<manager>/connexion/ly-solution/retour#assertion=…&state=…`

**Le fragment, jamais la query.** Un fragment n'est pas envoyé au serveur : il
ne finit ni dans un journal d'accès, ni dans un `Referer`. Il est effacé
(`history.replaceState`) **avant** toute tentative de consommation — en cas
d'échec, l'utilisateur reste sur la page et l'assertion ne doit pas y rester
lisible.

**La route est publique**, et c'est vital : à cet instant l'utilisateur apporte
le *moyen* d'ouvrir une session, pas le résultat. Une garde l'enverrait au login
en détruisant l'assertion — le défaut qu'avait connu le lien de réinitialisation
du Panel. Trois contrôles le gardent : la ligne de route ne porte pas de garde,
elle n'est pas imbriquée dans un bloc gardé, et elle précède le premier
`<RequireAuth>`.

Le navigateur **ne décode jamais** l'assertion : ni `atob`, ni décodeur JWT. Il
la transmet ; le backend la consomme.

## AUTH CONTEXT

`principalTypeOf()` / `isPanelPrincipal()` — **une seule façon** de lire le type.
Sans cela, chaque écran inventerait son test (`!user._id`, `user.source === …`)
et l'un finirait par être faux.

`User._id` est devenu `string | null`. Le typage a immédiatement fait remonter
**deux vrais points** dans l'écran des comptes, dont un `req.user._id.toString()`
qui aurait planté. C'est le but d'un type nullable : forcer à traiter le cas.

## FEDERATED PROFILE / USER LIST UX

Barre latérale : mention « Accès L.Y Solution » sous le nom. Discrète — un
rappel, pas une décoration — mais nécessaire : sans elle, un DEV chercherait
son mot de passe dans « Profil ».

`GET /api/accounts/external` (DEV, **lecture seule**) alimente une section
distincte de l'écran des comptes :

```text
UTILISATEURS DU PROJET     …avec édition, mot de passe, suppression
ACCÈS L.Y SOLUTION         …sans AUCUNE action
```

Aucune écriture n'accompagne cette route, et ce n'est pas un oubli : créer,
renommer ou supprimer une de ces identités depuis un projet n'aurait aucun effet
au Panel — cela produirait seulement une divergence silencieuse entre l'écran et
l'autorité. Un contrôle vérifie que la section ne contient ni `Trash2`, ni
`KeyRound`, ni `setEditing`.

L'état affiché est **daté** (« Synchronisé · 15/08/2026 ») : il reflète le
dernier contact, et n'autorise rien.

## FORGOT PASSWORD

Inchangé, et déplacé nulle part : le lien reste **dans le formulaire local**,
sous le bouton local. Il ne concerne que les comptes du projet.

## REVOCATION UX

Quand la revalidation du backend refuse, `AuthContext` déconnecte — et **dit
pourquoi** si la session était fédérée :

> « Votre accès L.Y Solution à ce projet n’est plus actif. »

La provenance est retenue dans une `ref` mise à jour au fil de l'eau : au moment
où l'on apprend le refus, `user` est sur le point d'être vidé, et lire l'état
donnerait la valeur d'après.

Un refus **explicite** (401/403) déconnecte ; une panne réseau laisse la session
intacte. Cette distinction existait déjà et n'a pas été touchée.

## PANEL DOWN BEHAVIOR

L'UI respecte le contrat déjà arrêté côté backend :

```text
session EN COURS   survit (mode dégradé) — refuser ferait d'une coupure Panel
                   une coupure du parc
NOUVELLE connexion refusée, message clair
login LOCAL        inchangé, jamais bloqué
```

## SECURITY

- le manager **ne collecte jamais** le mot de passe du Panel — vérifié sur le
  code, pas sur l'intention ;
- redirection ouverte **fermée** (14 contrôles, dont sous-domaine préfixant,
  port différent, `javascript:`, `data:`, `//host`) ;
- assertion dans le fragment, effacée avant toute suite, jamais décodée côté
  navigateur ;
- `state` en `sessionStorage` — garde-fou d'onglet, la vraie garde étant côté
  serveur ;
- motifs cryptographiques **indistincts** dans les messages : « mauvaise
  audience » et « signature invalide » partagent une phrase, pour ne pas
  renseigner qui cherche à comprendre ce qui a été détecté.

## TESTS

`manager/src/lib/federatedLogin.test.mjs` — **42 contrôles, 0 échec**, ajouté au
runner du manager.
`Panel/tests/federation-assertion.test.js` — **120 contrôles** (86 + 34 sur
l'adresse de retour), 0 échec.

> Deux contrôles ont dû être corrigés : l'un s'accrochait à un passage à la
> ligne, l'autre découpait la section des comptes jusqu'à la fin du fichier et
> accusait donc les boutons des comptes **locaux**. Un contrôle qui déborde ne
> mesure pas ce qu'il annonce.

`npm run build` du manager : **vert**.

## CE QUI RESTE

| | état |
|---|---|
| Recette navigateur manuelle | **non jouée** — nécessite deux serveurs et un navigateur |
| Recette non-appairée / révocation en navigateur | **non jouées**, même raison |
| Seed DEV legacy, `123dev`, duplication | intacts — LOT 2C, par conception |

Le parcours est complet et éprouvé par des contrôles statiques et par les
recettes serveur des deux côtés. Ce qui manque est la validation **manuelle**
en navigateur : elle demande de lancer Panel + backend + manager et de cliquer,
ce que je ne peux pas faire ici.

### Procédure exacte à jouer

```text
1. lancer Panel (backend + frontend) et SB Auto (backend + manager)
2. appairer le projet au Panel depuis « Connexion Panel » du manager
3. Panel → créer/choisir un PanelUser DEV, lui accorder projectAccess
   (ALL_PAIRED, ou EXPLICIT sur ce projet) — sans quoi la fédération est INERTE
4. manager /login → le bloc « Accès L.Y Solution » doit apparaître
5. cliquer → arrivée au Panel (login si nécessaire, retour automatique ICI
   avec les paramètres — c'est ce que `retourApresConnexion` répare)
6. retour au manager → session ouverte, sidebar « Accès L.Y Solution »
7. ouvrir une page DEV protégée → accessible
8. Panel → désactiver le compte, puis attendre ~5 min (ou redémarrer le
   backend projet) → la revalidation refuse, message de révocation, retour login
9. se reconnecter en LOCAL (admin@mail.com) → doit fonctionner
10. dépairer le projet → le bloc « Accès L.Y Solution » disparaît,
    le login local reste intact
```

> **L'étape 3 de cette procédure n'exige plus d'appel de service depuis la
> finalisation ci-dessous : elle se fait à l'écran.**

---

# LOT 2B FINALIZATION

> Deux manques comblés : la fédération s'active désormais **depuis un écran**,
> et le parcours complet est éprouvé **sur deux serveurs réellement démarrés**.

## PROJECT ACCESS UI

Le Panel n'avait **aucune** surface d'administration des comptes — ni API, ni
écran, ni entrée de menu. Un compte se créait par un script. C'était tenable
tant que « avoir un compte » était la seule chose décidable à son sujet ; la
fédération a changé cela, puisqu'un compte porte désormais un **accès chez un
client**. Un droit qu'on ne peut pas lire est un droit qu'on n'audite pas.

`/panel-users` — **DEV uniquement**. La question méritait d'être posée :
administrer des comptes ressemble à une tâche d'administration, donc à un rôle
ADMIN. Mais ce que cet écran accorde n'est pas un droit *dans* le Panel, c'est
un droit *chez un client*. L'ouvrir aux ADMIN reviendrait à laisser un rôle
non-développeur accorder un accès développeur — c'est-à-dire à contourner par
la délégation ce que l'émission d'assertion refuse frontalement. Un ADMIN reçoit
403, et c'est éprouvé.

### Deux réglages, jamais fondus

```text
Compte actif        [Désactiver]      le droit d'exister comme identité
────────────────────────────────
Accès aux projets   ○ Aucun accès     chez quels clients on peut entrer
                    ○ Projets sélectionnés
                    ○ Tous les projets appairés
```

Un compte peut être parfaitement **actif** sans **aucun** accès projet — c'est
même le cas par défaut, et la recette le vérifie explicitement (désactiver un
compte ne touche pas son accès, et réciproquement). Un interrupteur unique
ferait croire qu'activer un compte l'autorise quelque part.

`ALL_PAIRED` est **dynamique**, et l'écran l'écrit : « Ce n'est pas une liste
figée ». Sans cette phrase, quelqu'un finirait par vouloir « rafraîchir la
liste » d'un mode qui n'en a pas. Le serveur écarte d'ailleurs toute liste
envoyée hors du mode `EXPLICIT`.

Les projets **non appairés sont montrés, jamais cochables** : les masquer ferait
croire qu'ils n'existent pas ; les rendre cochables ferait accorder un accès que
le serveur refuse.

## PROJECT ACCESS AUTHORIZATION

Le frontend n'est jamais l'autorité. Six refus, tous éprouvés par HTTP réel :

| entrée | code |
|---|---|
| mode inconnu / champ en trop | `PANEL_USER_INPUT_INVALID` |
| `EXPLICIT` sans projet | `PANEL_USER_ACCESS_EMPTY` |
| projet inconnu | `PANEL_USER_ACCESS_PROJECT_UNKNOWN` |
| projet non appairé | `PANEL_USER_ACCESS_PROJECT_NOT_PAIRED` |
| **s'accorder à soi-même** | `PANEL_USER_SELF_GRANT` (403) |
| se désactiver soi-même | `PANEL_USER_SELF_DISABLE` |

**La garde qui compte est l'avant-dernière.** Sans elle, tout DEV du Panel
pourrait s'ouvrir l'accès à n'importe quel client en trois clics — et « l'accès
est un acte » n'aurait aucune substance, puisque l'acte et son bénéficiaire
seraient la même personne. Accorder reste possible ; se servir soi-même, non.
Un DEV qui a besoin d'un accès le demande à un collègue : c'est un coût réel, et
c'est le prix d'une trace qui veut dire quelque chose.

`grantedAt` / `grantedBy` sont persistés et affichés — « Accordé le … par … ».

## BROWSER FLOW — ce qui a été prouvé, et comment

`tests/federation-e2e.test.js` — **68 contrôles, 0 échec**.

**Ce n'est pas un navigateur** : il n'y a ni fenêtre, ni clic, ni rendu. C'est
mieux et moins à la fois — chacun des échanges HTTP qu'un navigateur ferait est
exécuté **pour de vrai**, entre deux serveurs distincts :

```text
un vrai Panel, sur un vrai port, avec sa base
une vraie instance projet, dans SON processus, avec SA base
un vrai appairage → un vrai bridgeToken
de vraies clés RSA, un vrai JWKS lu par HTTP, de vraies signatures
```

Le parcours joué est exactement celui du navigateur :
`/start` (projet) → `/assertion` (Panel, ce que fait la page d'autorisation) →
`/callback` (projet) → session → route DEV protégée.

**Le critère majeur du lot est tenu** : l'accès est accordé par
`PUT /api/panel-users/:id/project-access`, l'API de l'écran — jamais par un
appel au service. La recette vérifie d'abord que **sans accord, l'émission est
refusée**, puis accorde depuis l'écran, puis constate que le parcours aboutit.

Un DEV fédéré crée ensuite un **compte local** par l'API du projet : deux
preuves en un geste — une session fédérée ouvre réellement les routes DEV
(l'épreuve de `_id: null`), et le compte local qu'on éprouve ensuite n'est pas
un artefact du harnais.

### Ce que le test couvre, et que des clics ne montreraient pas

| | |
|---|---|
| révocation d'une session **ouverte** | l'accès est retiré depuis l'écran, la revalidation refuse |
| compte **désactivé** | session refusée, et le compte ne se connecte même plus au Panel |
| projet **dépairé** | émission refusée, **login local intact**, mot de passe oublié intact |
| **Panel éteint** | session en cours survit (dégradé), login local fonctionne |
| **même e-mail** local et Panel | deux identités, jamais fusionnées, chacune son mot de passe |
| **anti-rejeu** | assertion consommée refusée, `state` inventé refusé |
| aucun mot de passe Panel | balayage de **toute** la base du projet |

### La seule horloge contournée

La revalidation n'interroge le Panel qu'au plus toutes les cinq minutes. Une
recette ne peut pas attendre, et une horloge simulée n'a pas de sens face à un
vrai Panel. Le harnais expose donc `revalidateFederatedSession`, qui appelle
**exactement** la fonction que le middleware appelle, avec le contenu réel du
jeton et un `revalidatedAt` vieilli. Aucun contrôle n'est sauté — ni
l'introspection, ni la décision. Seule l'horloge l'est.

## NON PAIRED FLOW

Projet `REVOKED` ⇒ émission refusée (`FEDERATION_PROJECT_NOT_PAIRED`), et
surtout : **le login local et le mot de passe oublié continuent de répondre**.
Le Panel n'est jamais un prérequis de l'authentification locale — c'est la règle
principale du lot, et elle est vérifiée serveur éteint comme projet dépairé.

## REVOCATION FLOW

```text
accès retiré depuis l'écran  → session ouverte refusée à la revalidation
                             → aucune nouvelle connexion possible
                             → AUCUNE mutation de la base du projet
compte désactivé             → idem, et le compte ne se connecte plus au Panel
```

## PANEL DOWN FLOW

Panel arrêté pour de bon (`closePanel()`), puis :

```text
login local            → PASS
session fédérée ouverte → SURVIT, mode dégradé signalé
```

Refuser sur une panne réseau ferait d'une coupure du Panel une coupure de tout
le parc. L'UI respecte ce contrat sans le redéfinir.

## DEV-LOGIN — statut audité

`POST /api/auth/dev-login` ouvre une session DEV **sans mot de passe**. C'est le
seul autre chemin vers les droits que la fédération distribue avec tant de
précautions ; s'il s'ouvrait en production, tout le reste deviendrait décoratif.

Cinq contrôles le gardent désormais : le refus est la **première ligne** de la
fonction, **avant** toute lecture de compte ; `listTestAccounts` est fermé de la
même façon ; `isTest` **dérive de `ENV`** (`isProd = ENV === 'PROD'`,
`isTest = !isProd`) et non d'un drapeau qu'on pourrait oublier de poser ; et
l'écran n'affiche le widget qu'après une réponse serveur `enabled: true`.

Aucune suite backend n'en dépend (0 usage). **Il n'est pas supprimé** — c'est le
LOT 2C.

## HARNAIS — deux ajouts assumés

`tests/helpers/sbauto-instance.mjs` ne montait qu'un sous-ensemble de routes du
projet ; la surface d'authentification y a été ajoutée. Sans elle, une recette
de fédération ne pourrait éprouver que la moitié du parcours — celle du Panel —
et devrait faire confiance au projet sur l'autre.

## TESTS

| suite | résultat |
|---|---|
| `Panel/federation-e2e` (deux serveurs réels) | **68 / 0** |
| `Panel/panel-users-ui` | **36 / 0** |
| `Panel/federation-assertion` | 120 / 0 |
| `manager/federatedLogin` | 47 / 0 |
| `SB Auto/federated-dev-identity` | 81 / 0 |
| `auth` · `bridge-conformity` (×2) · `bridge-http` · `architecture` · `panel-ui` · `registry` | verts |
| builds Panel + manager | verts |

> Une garde a signalé mon propre test : la recette e2e réutilisait un mot de
> passe de démonstration historique. J'ai changé la valeur du test plutôt que
> d'assouplir la garde — c'est elle qui a raison.

## CE QUI RESTE

La validation **visuelle** — qu'un humain trouve le bouton, que l'écran soit
lisible — n'est pas automatisable ici. Tout ce qui est *fonctionnel* dans la
procédure en 10 étapes ci-dessus est désormais couvert par
`federation-e2e.test.js`, sauf le rendu lui-même.
