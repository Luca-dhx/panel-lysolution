# 55 — Appairer un projet

> **Guide opératoire.** Phase 4.
> Code : `services/pairing/` (Panel), `services/panelBridge/` (projet).

---

## 1. Le principe

**C'est toujours le projet qui initie.** Le Panel ne s'invite pas : il déclare
un projet, délivre un code à usage unique, et attend. Le projet appelle avec
ce code et reçoit son `bridgeToken`.

Cette asymétrie n'est pas un détail d'implémentation. Elle garantit qu'un
projet ne peut être rattaché à un Panel sans qu'un opérateur du **projet**
l'ait décidé — le Panel ne peut pas capturer un site qui ne le veut pas.

```text
  PANEL                                    PROJET
    │                                        │
    │  1. déclare le projet                  │
    │     → code d'appairage (15 min)        │
    │                                        │
    │              2. le code est transmis   │
    │                 hors-bande (copier)    │
    │                                        │
    │  ◀──── 3. POST /bridge/v1/pairings ────│
    │           { code, identité, Manifest } │
    │                                        │
    │  4. vérifie, consomme le code,         │
    │     délivre le bridgeToken             │
    │     + ENTREPRISE + API accordées       │
    │  ─────────────────────────────────────▶│
    │                                        │
    │                    5. chiffre et range │
    │                       le token, applique│
    │                       la configuration │
```

## 2. Étape 1 — déclarer le projet dans le Panel

Interface → **Projets** → nouveau projet.

| Champ | Contrainte |
|---|---|
| `projectKey` | slug stable, **jamais réutilisé**, doit correspondre à celui que le projet déclare |
| `projectName` | libellé lisible |

Le Panel rend un **code d'appairage** valable 15 minutes
(`PAIRING_CODE_TTL_S`), à usage strictement unique.

Le `projectKey` doit correspondre : le projet le dérive de son
`PROJECT_NAME`. « SB Auto 06 » donne `sb-auto-06`. Une divergence produit un
refus qui ne dit pas lequel des deux est faux — délibérément, pour ne pas
transformer le bootstrap en oracle.

## 3. Étape 2 (recommandée) — sonder l'URL

Avant de brûler le code, vérifiez l'adresse :

```http
POST /api/projects/probe
{ "url": "https://api.mon-projet.fr" }
```

La sonde n'appelle que `/ping`, la seule route publique du ProjectBridge. Ce
qu'elle établit :

| Constat | Ce qu'il évite |
|---|---|
| l'adresse répond | une URL fautive, un DNS non propagé, un service arrêté |
| c'est bien un ProjectBridge | une adresse qui répond… mais autre chose |
| la majeure de contrat concorde | un appairage refusé après consommation du code |
| le projet n'est pas déjà appairé | un `BRIDGE_ALREADY_PAIRED` |

C'est peu, et c'est volontaire : tout le reste (identité, Manifest,
composition) exige le `bridgeToken`. Un projet ne divulgue pas sa
composition à qui connaît son URL.

## 4. Étape 3 — appairer depuis le projet

### Depuis l'interface d'administration (recommandé)

```http
POST /api/panel-connection/pair        (compte DEV)
{
  "panelUrl": "https://panel.mon-entreprise.fr",
  "pairingCode": "XXXX-XXXX-XXXX",
  "publicBackendUrl": "https://api.mon-projet.fr"
}
```

### Au démarrage, par variables d'environnement

```dotenv
PANEL_URL=https://panel.mon-entreprise.fr
PANEL_PAIRING_CODE=XXXX-XXXX-XXXX
PUBLIC_BACKEND_URL=https://api.mon-projet.fr
```

L'appairage automatique ne s'exécute **que si le projet n'est pas déjà
appairé** : un code consommé ne doit pas être rejoué à chaque redémarrage.
Une fois l'appairage fait, retirez `PANEL_PAIRING_CODE` du `.env` — il ne
sert plus.

## 5. Ce que le projet reçoit (contrat ≥ 1.3.0)

La réponse au bootstrap ne contient plus seulement un jeton :

| Champ | Contenu |
|---|---|
| `bridgeToken` | credential propre à ce projet, révocable individuellement |
| `company` | la configuration **publiée** de l'entreprise |
| `integratedApis` | les accès accordés à **ce** projet, dans **son** mode |
| `syncCursor` | position de départ, pour ne pas rejouer ce qu'on vient de recevoir |

Le projet repart donc de l'appairage en sachant qui il représente. Sans cela,
il resterait aveugle jusqu'à son premier rattrapage — et afficherait
entre-temps un site sans identité.

Si aucune configuration n'a été publiée, `company` vaut `null` et
l'appairage réussit quand même. Refuser un appairage parce qu'un logo manque
serait disproportionné.

## 6. Vérifier

| Où | Attendu |
|---|---|
| Panel → fiche projet | statut **Appairé**, Manifest « reçu par le pont » |
| Panel → fiche projet | URL publique renseignée |
| Projet → `/api/panel-connection/status` | `paired: true`, nom du Panel, entreprise appliquée |

Puis lancez l'action **Découvrir le projet** depuis le Panel : elle relit
identité, Manifest, santé, opérations, et **constate la convergence**.

## 7. Cas d'échec, et ce qu'ils signifient

| Code | Cause réelle | Correction |
|---|---|---|
| `BRIDGE_PAIRING_CODE_INVALID` | code faux, expiré, déjà utilisé, ou `projectKey` divergent | régénérer un code ; vérifier que `PROJECT_NAME` donne le bon slug |
| `BRIDGE_ALREADY_PAIRED` | le projet est déjà rattaché | désappairer d'abord (§8) |
| `BRIDGE_CONTRACT_VERSION_UNSUPPORTED` | majeures de contrat différentes | porter le miroir du projet (`UPDATE_BRIDGE`) |
| `PROJECT_UNREACHABLE` (sonde) | adresse, DNS, service arrêté, pare-feu | sonder à nouveau après correction |

Le refus de code ne précise jamais **lequel** des deux éléments est faux.
C'est délibéré : un message plus précis transformerait le bootstrap en outil
de découverte pour un tiers.

## 8. Désappairer

**Depuis le projet** — `POST /api/panel-connection/unpair`.
Best-effort côté Panel, **toujours** effectif localement : un Panel injoignable
n'empêche pas un projet de se débrancher.

**Depuis le Panel** — `DELETE /api/projects/:id/pairing`.
Le Panel notifie le projet, puis révoque de son côté quoi qu'il arrive.

Dans les deux cas, ce qui venait du Panel repart avec lui : l'entreprise
appliquée et les API reçues sont purgées. Les données **métier** du projet,
elles, ne bougent pas — elles ne lui ont jamais appartenu à moitié.

## 9. Ré-appairer

Un projet désappairé revient à l'état STANDALONE, qui est un état normal de
première classe : il sert son site, sans identité d'entreprise. Le
ré-appairer demande un **nouveau** code : les codes ne se rejouent pas.
