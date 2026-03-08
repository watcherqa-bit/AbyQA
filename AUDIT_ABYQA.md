# AUDIT ABYQA — 2026-03-08

## RÉSUMÉ

| Statut | Circuits |
|--------|----------|
| ✅ Fonctionnel | 6 / 13 |
| ⚠️ Partiel | 6 / 13 |
| ❌ Cassé | 1 / 13 |

---

## FICHIERS AUDITÉS — VUE D'ENSEMBLE

| Fichier | Lancé au démarrage ? | Routes API ? | Fonctions principales appelées ? |
|---------|---------------------|-------------|----------------------------------|
| `agent-server.js` | ✅ Oui (point d'entrée) | ✅ 46+ routes | ✅ Toutes connectées |
| `agent-lead-qa.js` | ✅ Oui (require ligne 68) | Non (module) | ✅ 31 fonctions exportées, toutes utilisées |
| `agent-jira-queue.js` | ✅ Oui (require ligne 173) | Non (module) | ⚠️ testAlreadyExists() + _inProgress jamais appelés |
| `agent-poller.js` | ✅ Oui (require ligne 118) | Via server | ✅ start/stop/restart/getStatus |
| `agent-playwright-direct.js` | Non (spawné via runAgent) | Non (CLI) | ✅ Toutes fonctions internes appelées |
| `agent-xray-full.js` | Non (spawné via runAgent) | Non (CLI) | ✅ Pipeline complet |
| `agent-reporter.js` | ❌ **FICHIER INEXISTANT** | — | — |
| `agent-router.js` | ✅ Oui (require ligne 114) | Via server | ⚠️ Rule-based uniquement, pas de LLM routing |
| `agent-daily-job.js` | ✅ Oui (require ligne 174) | Via server | ✅ Cron + pipeline complet |
| `config.js` | ✅ Oui (require ligne 64) | Non (module) | ✅ loadEnv, required, get, validate |

---

## DÉTAIL PAR CIRCUIT

---

### CIRCUIT 1 — Enrichissement US

**Statut : ⚠️ Partiel**

**Fichier(s) concerné(s) :** `agent-lead-qa.js`, `agent-jira-queue.js`, `agent-daily-job.js`

**Ce qui fonctionne :**
- `analyzeUS()` (lead-qa:296) — analyse complexité, type automation, risques via Claude Haiku
- `enrichUS()` (lead-qa:328) — enrichissement persona/objectifs/AC via Claude Sonnet
- `buildInternalView()` (lead-qa:536) — vue interne sauvegardée dans `inbox/internal/`
- `buildExternalJiraPayload()` (lead-qa:564) — payload Jira minimal ADF
- `buildADFDescription()` (lead-qa:388) — ADF avec accordions pour AC
- Les deux fonctions sont bien connectées :
  - `agent-jira-queue.js` : workflowBacklog (ligne 459) appelle `enrichUS()`, puis `buildADFDescription()` (ligne 509-518)
  - `agent-daily-job.js` : pipelineUS (ligne 272-287) appelle `enrichUS()` si score < 70

**Ce qui manque / est cassé :**
- `updateJiraDescription()` dans `agent-jira-queue.js` (ligne 318) **n'est PAS protégée par le dryRun gate**. Quand le workflow Backlog enrichit et pousse vers Jira, cette écriture passe même en mode dry-run.
- `linkIssues()` dans `agent-daily-job.js` (ligne 78) **n'est PAS protégée par le dryRun gate** non plus.

**Ligne(s) de code concernée(s) :**
- `agent-jira-queue.js:318` — updateJiraDescription sans check `_dryRun`
- `agent-jira-queue.js:521` — appel updateJiraDescription dans workflowBacklog
- `agent-daily-job.js:78-82` — linkIssues sans check `_dryRun`
- `agent-daily-job.js:344,470` — appels linkIssues

---

### CIRCUIT 2 — Génération ticket TEST

**Statut : ✅ Fonctionnel**

**Fichier(s) concerné(s) :** `agent-lead-qa.js`, `agent-jira-queue.js`, `agent-daily-job.js`, `agent-server.js`

**Ce qui fonctionne :**
- `generateTestTicket()` (lead-qa:507) génère markdown + titre normalisé `TEST - [Epic] - [Summary]`
- `generateTestAndCSV()` (lead-qa:801) — version fusionnée (1 appel API au lieu de 2)
- `buildExternalJiraPayload()` (lead-qa:564) crée le payload Jira minimal
- `validateJiraPayload()` (lead-qa:640) vérifie 18 patterns interdits avant envoi
- Titre tronqué à 200 chars via `safeTruncate()` (lead-qa:941)
- Anti-doublon actif dans daily-job :
  - `checkTestExists()` (daily-job:212) — JQL cherche tests existants avec label "auto-generated"/"qa-auto"
  - `_inProgress` Set (daily-job:21) — verrou mémoire empêche création concurrente
  - Vérifié aux lignes 301-312 et 426-437
- Anti-doublon dans jira-queue :
  - `testAlreadyExists()` défini (jira-queue:273) mais **jamais appelé** dans les workflows
  - `_inProgress` défini (jira-queue:249) mais **jamais peuplé**

**Ce qui manque / est cassé :**
- L'anti-doublon dans `agent-jira-queue.js` est défini mais pas branché (dead code)
- Seul `agent-daily-job.js` a un anti-doublon actif

**Ligne(s) de code concernée(s) :**
- `agent-jira-queue.js:273-295` — testAlreadyExists (défini, jamais appelé)
- `agent-jira-queue.js:249` — _inProgress (défini, jamais peuplé)
- `agent-daily-job.js:212-230` — checkTestExists (actif)
- `agent-daily-job.js:301-312` — vérification anti-doublon (actif)

---

### CIRCUIT 3 — Cas de test Xray

**Statut : ✅ Fonctionnel**

**Fichier(s) concerné(s) :** `agent-lead-qa.js`, `agent-server.js`

**Ce qui fonctionne :**
- `buildXraySteps()` (lead-qa:656) génère format 3 colonnes : action/data/result + mode (auto/manuel)
- Validation des steps (lead-qa:706-721) : vérifie patterns interdits ([À préciser], etc.)
- Normalisation mode : "auto" ou "manuel" (lead-qa:718)
- Prompt inclut règles ANTI_HALLU pour éviter les placeholders
- Import API Xray via `PUT /rest/raven/1.0/api/test/{key}/steps` (server:1278)
- Route `/api/validation/push` step 3 (server:1355-1373) pousse les steps
- `pushXraySteps()` dans daily-job (ligne 73) et jira-queue (ligne 243) — protégé par dryRun

**Ce qui manque / est cassé :**
- Rien de bloquant. Le circuit est complet.

**Ligne(s) de code concernée(s) :**
- `agent-lead-qa.js:656-726` — buildXraySteps
- `agent-server.js:1355-1373` — push Xray dans validation/push

---

### CIRCUIT 4 — Rattachement Plan de Test

**Statut : ✅ Fonctionnel**

**Fichier(s) concerné(s) :** `agent-server.js`

**Ce qui fonctionne :**
- `findTestPlanExec()` (server:197) détecte par JQL : `issuetype = "Test Plan" AND summary ~ "{release}"`
- `ensureTestPlanExec()` (server:222) crée si absent via `POST /rest/api/3/issue`
- Attach via `POST /rest/raven/1.0/api/testplan/{key}/test` (server:248)
- Sélection manuelle possible via champs `val-plan-input` dans la modal
- Route push (server:1376-1401) gère les deux modes (auto-détection / clé manuelle)

**Ce qui manque / est cassé :**
- Pas d'anti-doublon JQL avant création — si `findTestPlanExec()` échoue (réseau), un nouveau Plan sera créé en double
- Pas de vérification que le ticket TEST n'est pas déjà attaché au Plan avant `POST .../test`

**Ligne(s) de code concernée(s) :**
- `agent-server.js:197-220` — findTestPlanExec
- `agent-server.js:222-258` — ensureTestPlanExec
- `agent-server.js:1376-1401` — push step 4

---

### CIRCUIT 5 — Rattachement Test Execution

**Statut : ✅ Fonctionnel**

**Fichier(s) concerné(s) :** `agent-server.js`

**Ce qui fonctionne :**
- Détection par JQL identique au Plan de Test (server:213-219)
- Création si absent (server:239-246)
- Attach via `POST /rest/raven/1.0/api/testexec/{key}/test` (server:253)
- Sélection manuelle possible via `val-exec-input`

**Ce qui manque / est cassé :**
- Mêmes limites que Circuit 4 (pas d'anti-doublon réseau, pas de vérification d'attachement existant)

**Ligne(s) de code concernée(s) :**
- `agent-server.js:213-219` — recherche Test Execution
- `agent-server.js:239-256` — création + attach

---

### CIRCUIT 6 — Bibliothèque de Test

**Statut : ✅ Fonctionnel**

**Fichier(s) concerné(s) :** `agent-server.js`

**Ce qui fonctionne :**
- `findRepoFolders()` (server:262) — lit l'arborescence complète via GET Xray API
- `searchFolder()` (server:271) — recherche récursive par nom
- `findOrCreateRepoFolder()` (server:286) — détecte "Release X.XX.X", crée si absent
- `addTestToRepoFolder()` (server:316) — anti-doublon actif via `getTestsInFolder()` avant ajout
- Push step 6 (server:1410-1428) intégré dans le flow validation
- Section BIBLIOTHÈQUE visible dans la modal de validation (dashboard)

**Ce qui manque / est cassé :**
- Le circuit fonctionne uniquement via la modal de validation (`/api/validation/push`). Le daily-job et jira-queue ne passent PAS par ce circuit — les tickets TEST créés automatiquement ne sont pas ajoutés à la Bibliothèque.

**Ligne(s) de code concernée(s) :**
- `agent-server.js:262-326` — fonctions Bibliothèque
- `agent-server.js:1410-1428` — push step 6

---

### CIRCUIT 7 — Points de contrôle

**Statut : ⚠️ Partiel**

**Fichier(s) concerné(s) :** `agent-server.js`, `aby-qa-dashboard.html`, `agent-jira-queue.js`

**Ce qui fonctionne :**
- Modal de validation complète : 3 onglets (Ticket TEST, Xray, Config)
- `POST /api/validation/preview` (server:1177) — prévisualisation sans envoi
- `POST /api/validation/push` (server:1281) — envoi séquentiel avec 7 étapes SSE
- Bouton Valider + Annuler actifs (dashboard: confirmValidationPush, closeValidationModal)
- Progression temps réel via SSE event "validation-progress"
- `validateJiraPayload()` (lead-qa:640) — scan 18 patterns interdits avant envoi
- dryRun gate sur postComment, transitionIssue, createJiraIssue, pushXraySteps

**Ce qui manque / est cassé :**
- Le workflow automatique (`agent-jira-queue.js` + `agent-daily-job.js`) a son propre `requestValidation()` (jira-queue:105) avec auto-approve à 10 minutes. Si personne ne répond dans les 10 min, **ça passe quand même** (en mode dry-run, c'est neutralisé, mais si dry-run est désactivé…)
- `updateJiraDescription()` et `linkIssues()` passent hors validation (voir Circuit 1)
- La modal ne couvre que le flux manuel. Le daily-job crée des tickets directement via `createJiraIssue()` sans passer par la modal.

**Ligne(s) de code concernée(s) :**
- `agent-jira-queue.js:105-163` — requestValidation avec auto-approve 10min
- `agent-server.js:1177-1445` — preview + push routes
- `agent-daily-job.js:337-346` — createJiraIssue directe (pas de modal)

---

### CIRCUIT 8 — Job journalier 6h

**Statut : ⚠️ Partiel**

**Fichier(s) concerné(s) :** `agent-daily-job.js`, `agent-server.js`, `agent-poller.js`

**Ce qui fonctionne :**
- Cron actif : `startCron()` (daily-job:637) — setInterval 60s, déclenche à 06:00
- Filtre JQL correct (daily-job:193-209) : `project=SAFWBST AND assignee=currentUser() AND status in ("In QA","To Test","In Test",...) AND issuetype in (Story,Bug)`
- Pipeline complet : analyse → enrichissement → génération TEST → Xray steps → lien
- Rapport généré : `saveReport()` (daily-job:622-629) en JSON + historique JSONL
- Timeout 5 min + crash handler (daily-job:600-620)
- Route manuelle : `POST /api/daily-job/run` (server:3179)
- Mode alternatif : `agent-poller.js` détecte tickets QA-ready → déclenche `/api/daily-job/run` avec cooldown 10 min

**Ce qui manque / est cassé :**
- Le rapport est en JSON, pas en PDF/HTML lisible humainement
- `_dryRun = true` par défaut — le daily-job est en lecture seule tant qu'on ne toggle pas via `POST /api/jira-dryrun`. C'est voulu mais peut surprendre.
- Deux modes mutuellement exclusifs (DAILY_JOB_MODE vs polling) — si mal configuré, ni l'un ni l'autre ne tourne
- `importXrayCSV()` (daily-job:125-146) — défini mais jamais appelé (dead code)

**Ligne(s) de code concernée(s) :**
- `agent-daily-job.js:637-656` — startCron
- `agent-daily-job.js:193-209` — JQL
- `agent-daily-job.js:485-598` — runDailyQAJob
- `agent-server.js:3515-3529` — démarrage conditionnel

---

### CIRCUIT 9 — Exécution Playwright

**Statut : ⚠️ Partiel**

**Fichier(s) concerné(s) :** `agent-playwright-direct.js`, `agent-lead-qa.js`, `agent-server.js`

**Ce qui fonctionne :**
- Modes supportés : ui, api, fix, tnr (CLI `--mode=`)
- Sources : url, jira-key, xml, text (CLI `--source=`)
- Lecture ticket Jira avant exécution (via `--key=SAFWBST-XXX`) — fetchs issue + extracts URLs
- `generateExecutableScenarios()` (lead-qa:1273) — génère scénarios structurés avec actions/assertions
- Multi-browser/device matrix : chaque cible × navigateur × device
- Résultat PASS/FAIL dans stdout `PLAYWRIGHT_DIRECT_RESULT:` (playwright:1795)
- SSE `PLAYWRIGHT_PROGRESS:` pour suivi temps réel (playwright:1752)
- Rapport HTML + PDF généré automatiquement (playwright:1421-1461)
- Screenshot annotation avec statut overlay (playwright:458-532)

**Ce qui manque / est cassé :**
- Le mode `--source=text` utilise les instructions texte comme URL cible, pas comme scénario structuré. Les scénarios `generateExecutableScenarios()` ne sont utilisés que quand `--source=jira-key`
- Pas de validation pré-exécution dans le dashboard — le bouton "Tester" lance directement Playwright sans prévisualisation des scénarios
- Le résultat PASS/FAIL est affiché dans AbyQA (SSE) mais nécessite un scroll dans les logs — pas de résumé visuel dédié avant envoi Jira

**Ligne(s) de code concernée(s) :**
- `agent-playwright-direct.js:1600+` — main() entry point
- `agent-playwright-direct.js:533-763` — runTest() core
- `agent-lead-qa.js:1273-1335` — generateExecutableScenarios

---

### CIRCUIT 10 — Rapport PDF

**Statut : ⚠️ Partiel**

**Fichier(s) concerné(s) :** `agent-playwright-direct.js`, `agent-server.js`

**Ce qui fonctionne :**
- Génération HTML complète avec CSS print professionnel (playwright:968)
- Conversion HTML → PDF via `convertHtmlToPdf()` (playwright:1425-1461) — utilise Playwright `page.pdf()`
- Screenshots incluses en base64 dans le HTML/PDF (via `reporter-utils.js`)
- Format A4, marges correctes (playwright:1444-1450)
- `pdfPath` retourné dans `PLAYWRIGHT_DIRECT_RESULT` pour référence

**Ce qui manque / est cassé :**
- `agent-reporter.js` référencé dans CLAUDE.md **n'existe pas** (fichier absent du projet)
- L'envoi du PDF comme PJ Jira est possible via `POST /api/attach-report/:key` (server:2804) mais c'est **un envoi manuel** — pas automatique après test
- Le daily-job ne génère pas de rapport PDF (seulement JSON)
- `attachFileToJira()` (server:131) fonctionne mais n'est appelé automatiquement que dans le cycle 1 (server:2770+)

**Ligne(s) de code concernée(s) :**
- `agent-playwright-direct.js:1421-1461` — convertHtmlToPdf
- `agent-server.js:2804-2826` — POST /api/attach-report/:key

---

### CIRCUIT 11 — Feedback visuel

**Statut : ✅ Fonctionnel (dans la modal de validation)**

**Fichier(s) concerné(s) :** `agent-server.js`, `aby-qa-dashboard.html`

**Ce qui fonctionne :**
- 7 étapes de progression SSE dans la modal (validation-progress)
- Icônes dynamiques : ⬜ pending → ⏳ running → ✅ done / ❌ error
- PASS/FAIL affiché avant envoi Jira dans la modal (étapes visibles)
- Progression Playwright temps réel via `PLAYWRIGHT_PROGRESS:` events
- Auto-debug en cas d'échec : `triggerAutoDebug()` (server:406) analyse via IA
- Toast notifications dans le dashboard

**Ce qui manque / est cassé :**
- Le feedback est optimal uniquement via la modal de validation. Le flux automatique (daily-job) n'a qu'un log textuel — pas de progression visuelle structurée.

**Ligne(s) de code concernée(s) :**
- `aby-qa-dashboard.html:14806-14812` — 7 STEPS définition
- `agent-server.js:1208-1213` — emitProgress function

---

### CIRCUIT 12 — Séparation vue interne/externe

**Statut : ⚠️ Partiel**

**Fichier(s) concerné(s) :** `agent-lead-qa.js`

**Ce qui fonctionne :**
- `buildInternalView()` (lead-qa:536) sauvegarde la méthodologie complète dans `inbox/internal/` — jamais envoyée à Jira
- `buildExternalJiraPayload()` (lead-qa:564) crée un payload minimal (objectif + type seulement)
- `validateJiraPayload()` (lead-qa:640) scanne 18 patterns interdits : emojis, "AbyQA", "Claude", headers markdown, "[À préciser]"
- ANTI_HALLU (lead-qa:21-29) empêche la génération de placeholders

**Ce qui manque / est cassé :**
- `validateJiraPayload()` est appelé dans :
  - `agent-server.js:1153` — route preview (affichage uniquement)
  - `agent-daily-job.js:333,460` — avant createJiraIssue (bloque si invalid)
  - `agent-jira-queue.js:614-620` — workflowUS (bloque si invalid)
- **MAIS** : `updateJiraDescription()` dans workflowBacklog (jira-queue:521) pousse du contenu ADF enrichi vers Jira **sans passer par validateJiraPayload()**. Le contenu ADF pourrait contenir des patterns interdits.
- La forbidden list ne couvre pas tous les cas (ex: "Playwright", "Anthropic", noms de modèles)

**Ligne(s) de code concernée(s) :**
- `agent-lead-qa.js:629-653` — FORBIDDEN_PATTERNS + validateJiraPayload
- `agent-jira-queue.js:509-521` — workflowBacklog : ADF construit puis poussé sans validation

---

### CIRCUIT 13 — Anti-doublon global

**Statut : ⚠️ Partiel**

**Fichier(s) concerné(s) :** `agent-daily-job.js`, `agent-jira-queue.js`, `agent-server.js`

**Ce qui fonctionne :**

| Élément | Agent | Anti-doublon | Actif ? |
|---------|-------|-------------|---------|
| Ticket TEST | daily-job | `checkTestExists()` JQL + `_inProgress` Set | ✅ Oui |
| Ticket TEST | jira-queue | `testAlreadyExists()` + `_inProgress` | ❌ Défini mais jamais appelé |
| Ticket BUG | jira-queue | `bugAlreadyExists()` JQL 7 jours | ✅ Oui |
| Test Plan | server | `findTestPlanExec()` JQL par summary | ⚠️ Pas de verrou réseau |
| Test Execution | server | `findTestPlanExec()` JQL par summary | ⚠️ Pas de verrou réseau |
| Dossier Biblio | server | `searchFolder()` par nom | ✅ Oui |
| Test dans dossier | server | `getTestsInFolder()` + check `.some()` | ✅ Oui |

**Ce qui manque / est cassé :**
- `agent-jira-queue.js` a l'anti-doublon TEST codé mais **jamais branché** dans les workflows (dead code)
- Pas de verrou global inter-processus : si daily-job et validation modal créent le même TEST en parallèle, doublon possible
- `findTestPlanExec()` ne protège pas contre les créations concurrentes (race condition si deux pushes simultanés)

**Ligne(s) de code concernée(s) :**
- `agent-jira-queue.js:273-295` — testAlreadyExists (dead code)
- `agent-jira-queue.js:249` — _inProgress (dead code)
- `agent-daily-job.js:212-230` — checkTestExists (actif)
- `agent-server.js:316-326` — addTestToRepoFolder anti-doublon (actif)

---

## DEAD CODE

| Fonction | Fichier | Ligne | Raison |
|----------|---------|-------|--------|
| `testAlreadyExists()` | agent-jira-queue.js | 273 | Définie mais jamais appelée dans aucun workflow |
| `_inProgress` Set | agent-jira-queue.js | 249 | Défini mais jamais peuplé ni vérifié |
| `importXrayCSV()` | agent-server.js | 514 | Définie mais jamais appelée |
| `importXrayCSV()` | agent-daily-job.js | 125 | Définie mais jamais appelée |
| `_anthThrottle()` | agent-server.js | 13 | Définie mais jamais appelée directement (legacy Anthropic rate limit) |
| `_anthWithRetry()` | agent-server.js | 22 | Définie mais jamais appelée directement |
| `_anthEnqueue()` | agent-server.js | 47 | Définie mais jamais appelée directement |
| `askOllama()` | agent-lead-qa.js | 243 | Fallback Ollama — fonctionnel mais Ollama non utilisé en pratique |
| `agent-reporter.js` | — | — | **Fichier référencé dans CLAUDE.md mais inexistant** |

---

## RISQUES

### Priorité HAUTE

1. **`updateJiraDescription()` hors dryRun** (agent-jira-queue.js:318)
   Si dryRun est désactivé, le workflow Backlog peut écraser la description Jira d'un ticket sans passer par le gate de protection. Seul `backupDescription()` limite les dégâts.

2. **`linkIssues()` hors dryRun** (agent-daily-job.js:78)
   Les liens entre tickets sont créés même en mode dry-run dans le daily-job. Cela peut créer des liens orphelins vers des tickets "DRY-RUN" inexistants.

3. **Auto-approve 10 minutes** (agent-jira-queue.js:135-161)
   `requestValidation()` auto-approuve après 10 minutes de silence. Combiné avec dryRun=false, cela signifie que des tickets Jira peuvent être créés sans validation humaine.

### Priorité MOYENNE

4. **Anti-doublon TEST absent dans agent-jira-queue.js**
   Le code existe (`testAlreadyExists()`) mais n'est jamais appelé. En mode polling continu, le même ticket pourrait être traité deux fois.

5. **Pas de validation forbidden patterns sur updateJiraDescription()**
   Le contenu ADF enrichi poussé par workflowBacklog ne passe pas par `validateJiraPayload()`. Des patterns internes pourraient fuiter vers Jira.

6. **Bibliothèque non intégrée au daily-job**
   Les tickets TEST créés par le daily-job ne sont pas ajoutés à la Bibliothèque de Test Xray. Seuls ceux créés via la modal sont ajoutés.

7. **Race condition Plan de Test / Test Execution**
   Deux pushes simultanés pour la même release pourraient chacun créer un Plan/Execution en doublon (pas de verrou).

### Priorité BASSE

8. **`agent-reporter.js` inexistant**
   Référencé dans CLAUDE.md comme agent de rapports QA, mais le fichier n'existe pas. La fonctionnalité est couverte par `leadQA.generateReport()` et `agent-playwright-direct.js`.

9. **Rapport daily-job en JSON uniquement**
   Pas de rapport PDF/HTML pour le job journalier — le rapport est un objet JSON mis en cache mémoire.

10. **importXrayCSV() dead code x2**
    Définie dans agent-server.js (514) et agent-daily-job.js (125) mais jamais appelée. Probablement un vestige de l'import CSV Xray legacy.

---

## MATRICE DE COUVERTURE dryRun

| Fonction d'écriture Jira | agent-jira-queue.js | agent-daily-job.js | agent-server.js |
|--------------------------|--------------------|--------------------|-----------------|
| `postComment()` | ✅ Protégé (209) | ✅ Protégé (52) | N/A (inline HTTPS) |
| `transitionIssue()` | ✅ Protégé (219) | ✅ Protégé (59) | N/A |
| `createJiraIssue()` | ✅ Protégé (237) | ✅ Protégé (68) | ⚠️ Route push inline |
| `pushXraySteps()` | ✅ Protégé (243) | ✅ Protégé (73) | ⚠️ Route push inline |
| `updateJiraDescription()` | ❌ **NON protégé** (318) | N/A (appel direct) | N/A |
| `linkIssues()` | N/A | ❌ **NON protégé** (78) | N/A |
| Validation push (modal) | N/A | N/A | Pas de dryRun (flux manuel) |
