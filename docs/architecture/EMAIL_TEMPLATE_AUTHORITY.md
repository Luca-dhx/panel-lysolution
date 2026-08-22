# Modèles d'e-mail — l'autorité, et une seule

> Contrat de pont **1.11.0**.
> Complète [BREVO_CONTROL_PLANE.md](BREVO_CONTROL_PLANE.md) §3 « Modèles ».
> Remplace la moitié « projet » de
> [EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md](../email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md).

---

## 0. L'invariant

```
PANEL    autorité du CONTENU et du VOCABULAIRE
PROJET   déclare ce qu'il consomme, produit les VALEURS
MANAGER  consulte — aucune mutation possible
BREVO    transport, et rien d'autre
```

Quatre propriétés en découlent, et le code les rend vérifiables :

```
NO PROJECT TEMPLATE CONTENT AUTHORITY   aucun projet ne stocke un sujet ni un HTML
NO LOCAL TEMPLATE FALLBACK              un Panel injoignable refuse ; il n'affiche rien de périmé
NO LOCAL ENABLED VETO                   aucun état local ne peut empêcher un envoi
NO MANAGER TEMPLATE MUTATION            aucune route d'écriture n'existe côté projet
```

---

## 1. Pourquoi ce document existe

L'audit d'ownership de 2026-08-22 a mesuré ce que l'intention seule laissait
croire. Le contenu expédié venait bien du Panel depuis le lot L8.4C — mais le
projet conservait une base de modèles complète, éditable depuis le Manager, que
**rien n'expédiait**.

Trois faits ont tranché :

1. **Sept modèles sur quatorze** avaient déjà divergé du contenu réellement
   envoyé, sans qu'aucun signal ne l'indique. L'écran affichait le mauvais
   contenu avec la même assurance que le bon.
2. L'interrupteur « inactif » de cet écran **coupait réellement l'envoi** d'un
   e-mail que le Panel aurait expédié. Un écran sans autorité sur le contenu
   exerçait un veto sur l'expédition.
3. L'alerte d'incident technique **n'a jamais pu partir** : elle nommait un
   modèle de portée PANEL depuis un chemin projet, et échouait en silence.

Une architecture n'est pas ce qu'on a voulu ; c'est ce qui reste exécutable.

---

## 2. Le partage exact

| Objet | Autorité | Où il vit |
|---|---|---|
| Liste des codes valides | **Panel** | `panelEmailTemplateRegistry.js` |
| Portée autorisée par code | **Panel** | `panelEmailTemplateDefinitions.js` (`TEMPLATE_OWNERSHIP`) |
| Variables : clés, types, obligation | **Panel** | `variablesFor()` |
| Sujet, HTML, `enabled`, versions | **Panel** | `PanelEmailTemplate` (portée PANEL ou PROJECT) |
| Historique, restauration | **Panel** | `PanelEmailTemplateVersion` |
| Expéditeur (`From`) | **Panel** | `panelGlobalSender.service.js` |
| **Quels codes ce projet consomme** | **Projet** | `utils/projectEmailTemplateUsage.js` |
| **Comment produire chaque valeur** | **Projet** | `services/email/*VariableResolver.js` |
| Suivi des livraisons | **Projet** | `EmailDelivery` |

Le projet ne conserve **qu'une** chose au sujet des modèles : le *contrat de
variables* servi par le Panel (`EmailTemplateContract`). Ni sujet, ni HTML, ni
version de contenu, ni interrupteur — les remettre recréerait la seconde
autorité sous un autre nom.

Cette exception a une justification étroite : le projet doit pouvoir valider
**hors connexion** ce qu'il fournit, et se déclarer. Une absence de contrat n'y
est **jamais** bloquante : le Panel reste l'autorité de validation à l'envoi.

---

## 3. Le chemin d'un e-mail, de bout en bout

```
événement de domaine  (contract.payment.overdue, contact.submitted…)
        │
        ▼
domainEventDispatcher → handler SEND_EMAIL
        │
        ▼
resolveVariables()            ← PROJET : produit les valeurs métier
        │
        ▼
emailDelivery.sendTemplate()
  1. getEmailReadiness()      ← fournisseur, plateforme, destinataire
                                 (AUCUN jugement de contenu)
  2. validateProvidedVariables()
                              ← les valeurs fournies, à l'aune du contrat PANEL
                                 (silencieux si le contrat n'est pas connu)
  3. EmailDelivery créée      ← subjectSnapshot VIDE, templateVersion 0
        │
        ▼
controlPlane.invoke('email.send_template', { templateRef, variables, operationId })
        │
        ▼──────────────────────── frontière d'autorité ────────────────────────
        │
   PANEL · brevoSendAdapter
     ├─ resolveForProject()   → l'expéditeur global
     └─ renderForSend(code, scope)
          ├─ le projet déclare-t-il ce code ?   sinon EMAIL_TEMPLATE_NOT_DECLARED
          ├─ la portée est-elle permise ?       sinon SCOPE_FORBIDDEN_FOR_CODE
          ├─ une instance ACTIVE existe-t-elle ? sinon EMAIL_TEMPLATE_NOT_CONFIGURED
          ├─ est-elle activée ?                 sinon TEMPLATE_DISABLED
          └─ rendu strict des variables         sinon UNKNOWN/MISSING_VARIABLE
        │
        ▼
   Brevo (transport)
        │
        ▼ réponse
   { providerMessageId, sender, templateVersion, templateScope, subject }
        │
        ▼
EmailDelivery mise à jour avec la VÉRITÉ de l'envoi
```

**Aucun repli local n'existe à aucune étape.** Panel injoignable ⇒ livraison
`FAILED`, `retryable`. Le projet ne détient plus de clé Brevo.

---

## 4. Ce que le Manager peut faire

| Action | Possible ? |
|---|---|
| Voir les modèles affectés à ce projet | ✅ (projection Panel, à chaque lecture) |
| Voir portée, version, sujet expédié, statut | ✅ |
| Prévisualiser le rendu | ✅ (rendu **par le Panel**, avec ses exemples) |
| Lire les variables attendues | ✅ |
| Diagnostiquer une configuration absente | ✅ |
| Lancer un envoi de test | ✅ (exécuté **par le Panel**) |
| Modifier un sujet, un HTML, un `enabled` | ❌ **aucune route** |
| Restaurer une version | ❌ **aucune route** |
| Consulter l'historique local | ❌ **il n'y en a plus** |

La page affiche : *« Les templates e-mail sont administrés depuis
L.Y Solution. »*

Toutes les lectures **traversent le pont**. Il n'y a pas de cache de contenu, et
c'est délibéré : un écran qui prétend montrer « ce qui part » ne peut pas montrer
ce qui partait ce matin. Panel injoignable ⇒ `503` explicite.

---

## 5. Le contrat de variables et sa compatibilité

### Le problème

Le Panel possède le vocabulaire ; le projet possède la production des valeurs.
Sans lien entre les deux, ajouter une variable **obligatoire** fait échouer tous
les envois d'un modèle sur tout le parc — pas immédiatement, mais au prochain
e-mail. Le premier symptôme est un client qui n'a pas reçu sa réinitialisation
de mot de passe, des semaines plus tard.

### Le mécanisme : une empreinte, pas une négociation

Une négociation supposerait que les deux côtés puissent s'accorder à
l'exécution. Ils ne le peuvent pas : le projet ne peut pas inventer une variable
qu'il ne sait pas résoudre, et le Panel ne peut pas renoncer à une variable que
son contenu utilise. Il n'y a rien à négocier — seulement un désaccord à
**constater**, le plus tôt possible.

```
fingerprint(code) = sha256( trié( "clé:type:R|O" ) )[0..32]
```

| Dedans | Dehors |
|---|---|
| la clé | le libellé |
| le type | la description |
| le caractère obligatoire | l'ordre de déclaration |
| | le sujet, le HTML |

Ce qui est dedans peut casser un rendu. Ce qui est dehors ne l'a jamais fait —
l'inclure ferait clignoter l'alerte à chaque correction d'orthographe, et une
alerte qui clignote sans raison finit par n'être plus lue.

### Le cycle

```
Panel  ──── projection (variables + fingerprint) ────▶  Projet
                                                         │ cache
Projet ──── PROJECT_EMAIL_TEMPLATE_USAGE ────▶  Panel
            { templateCodes[], contractFingerprints{} }
                                                  │
                                    describeContractCompatibility()
                                                  │
                          MATCH  /  STALE  /  UNDECLARED
                                                  │
                       lastReconciliation.staleContracts[]  + journal
```

Le projet **transporte** l'empreinte, il ne la recalcule pas : la recalculer
supposerait de dupliquer la règle de hachage, donc de pouvoir en diverger — on
retrouverait deux vérités là où ce lot n'en veut qu'une.

### Ce qu'un écart déclenche, et ce qu'il ne déclenche pas

Un écart est **signalé** (journal + `staleContracts`), jamais bloquant. Seul le
rendu sait si les valeurs réellement fournies suffisent ; refuser d'avance
interdirait des envois parfaitement rendables au motif qu'un type a été précisé.

`UNDECLARED` (projet antérieur au lot) n'est **pas** un écart : le ranger avec
les incompatibles ferait passer tout le parc en alerte le jour du déploiement.

---

## 6. Archivage — la convergence des instances projet

Un projet cesse de déclarer un code ⇒ son instance est **archivée**
(`archivedAt`, `archivedReason`), pas supprimée, pas désactivée.

| Option | Pourquoi elle a été écartée |
|---|---|
| Suppression | détruit l'historique d'un contenu réellement expédié — la seule trace exploitable d'une enquête |
| `enabled: false` | ment sur la cause : « désactivé » est une décision d'exploitant, or personne n'a rien décidé |
| **Archive** | l'instance et son historique demeurent, l'envoi la refuse, la raison est écrite |

| Surface | Voit une archive ? |
|---|---|
| `resolveTemplate` (envoi) | ❌ |
| projection servie au projet | ❌ |
| `draftTemplate` / éditeur Panel | ✅ marquée « Archivé » |

Une nouvelle déclaration la **réveille intacte**, à la version où elle avait été
laissée — la reposer depuis les défauts du registre effacerait le contenu écrit
par un exploitant.

---

## 7. Incident technique — pourquoi il remonte

L'alerte `PLATFORM_INCIDENT_DEV_ALERT` est une communication **de L.Y Solution**
vers l'équipe technique : elle nomme des composants internes et ne porte jamais
l'apparence d'un client. Elle est donc de portée PANEL.

Le projet l'envoyait lui-même. Un projet ne peut pas demander une portée PANEL :
chaque incident finissait en refus silencieux. Aucun n'a jamais été notifié.

**La correction n'a pas été de basculer le modèle en portée PROJECT.** Cela
aurait fait entrer une communication interne dans le catalogue éditable d'un
client, pour la seule raison que l'appel partait de chez lui. *L'ownership suit
la communication, jamais l'origine des faits.*

```
projet : platform.incident.raised
   └─ action REPORT_INCIDENT (ne nomme AUCUN modèle)
        └─ notifyFactReported('PLATFORM_INCIDENT', faits)
             └─ syncTriggers → outbox durable
                  └─ entité PLATFORM_INCIDENT ──▶ Panel
                       └─ applyPlatformIncident
                            ├─ chronologie de supervision (AVANT l'alerte)
                            ├─ destinataires = PanelProjectMember(role DEV)
                            │                  sinon SUPER_ADMIN du Panel
                            └─ email.send_template, portée PANEL, PANEL_SELF
```

La file durable était le point décisif : l'indisponibilité du Panel est
précisément l'une des familles d'incidents qu'on veut remonter — la plus
probable. Une capacité synchrone aurait perdu l'alerte exactement au moment où
elle compte.

Le traitement **ne lève jamais** : un incident mal expédié ne doit pas faire
rejeter la synchronisation qui l'a apporté, sinon une panne d'e-mail devient une
panne de pont.

---

## 8. Modes de défaillance

| Situation | Comportement |
|---|---|
| Panel injoignable (envoi) | `FAILED`, `retryable` — **jamais** de repli local vers Brevo |
| Panel injoignable (Manager) | `503` explicite — **jamais** d'affichage périmé |
| Instance PROJECT absente | `EMAIL_TEMPLATE_NOT_CONFIGURED` — jamais le contenu PANEL à la place |
| Code non déclaré par le projet | `EMAIL_TEMPLATE_NOT_DECLARED_BY_PROJECT` — se corrige dans le projet |
| Portée interdite pour ce code | `SCOPE_FORBIDDEN_FOR_CODE` |
| Modèle désactivé **côté Panel** | refus autoritatif — la seule façon de couper un e-mail |
| Ancienne copie locale divergente | **impossible** : il n'y en a plus |
| Variable requise absente | refus local si le contrat est connu, sinon refus du Panel |
| Variable inconnue | idem |
| Contrat de variables périmé | signalé à la déclaration, avant tout envoi |
| Redémarrage du projet | aucune résurrection : plus rien à amorcer localement |

---

## 9. Surface retirée

| Composant | Sort |
|---|---|
| `models/EmailTemplate.model.js` (projet) | supprimé |
| `models/EmailTemplateVersion.model.js` (projet) | supprimé |
| `services/email/emailTemplate.service.js` (projet) | supprimé |
| `services/email/emailTemplateRenderer.js` (projet) | supprimé |
| `services/email/emailTemplateValidator.js` (projet) | supprimé |
| `utils/emailTemplateRegistry.js` (projet, ~1 100 lignes) | supprimé |
| `PUT /dev/email-templates/:id` + `/versions/*` | supprimées |
| `PUT|POST /bridge/v1/email-templates/*` (Panel) | supprimées |
| `EMAIL_TEMPLATE` dans `SYNC_ENTITY_TYPES` | retiré des deux contrats |
| `CONTRACT_PAYMENT_RECEIVED_ADMIN` (résolveur projet) | retiré |
| Édition, historique, restauration dans le Manager | retirés |

---

## 10. Où lire le code

| Question | Fichier |
|---|---|
| Quel contenu part ? | `Panel/…/panelEmailTemplate.service.js` → `renderForSend` |
| Que voit le Manager ? | `renderForSend` ⇄ `resolveForProjection` (même primitive) |
| Qui possède quoi ? | `panelEmailTemplateDefinitions.js` → `TEMPLATE_OWNERSHIP` |
| Comment l'empreinte est calculée ? | `panelEmailTemplateContract.js` |
| Ce que le projet déclare | `SB Auto/…/utils/projectEmailTemplateUsage.js` |
| Ce que le projet cache | `SB Auto/…/services/email/emailTemplateContract.service.js` |
| L'alerte d'incident | `Panel/…/supervision/platformIncidentAlerting.service.js` |

| Preuve | Test |
|---|---|
| Autorité unique, aucune surface locale | `SB Auto` → `test:template-usage` |
| Consommation, contrat, refus sans Panel | `SB Auto` → `test:email-templates` |
| Chaîne d'envoi, sujet réel, aucun veto | `SB Auto` → `test:email-delivery` |
| Cycle déclaration → archive → réveil | `Panel` → `test:template-declaration` |
| Empreinte et compatibilité | `Panel` → `test:variable-contract` |
| Incident jusqu'à l'adaptateur | `Panel` → `test:incident-dispatch` |
