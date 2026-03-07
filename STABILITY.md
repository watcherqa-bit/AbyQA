# STABILITY.md — Etat de stabilite AbyQA

> Derniere mise a jour : 2026-03-07

## Ce qui fonctionne

- **Serveur** : `node agent-server.js` demarre sans crash sur port 3210
- **Route /api/health** : repond 200 avec uptime + timestamp
- **Route /api/reports** : repond 200, retourne la liste des rapports markdown
- **Route /api/playwright-reports** : repond 200, retourne les rapports Playwright + diagnostics
- **Route /api/settings** : repond 200, lecture/ecriture settings.json
- **Route /api/enriched** : repond 200, CRUD tickets enrichis
- **Route /api/tests-queue** : repond 200, file de tests prets a lancer
- **Route /api/jira-activity** : repond 200, mouvements Jira
- **Route /api/cycle/state** : repond 200, etat des cycles QA
- **Route /api/polling/status** : repond 200, etat du polling Jira
- **Route /api/chat-projects** : repond 200, projets de conversation
- **Route /api/router-log** : repond 200, historique du routeur
- **Route /api/log-event** : repond 200, persistance des actions diag
- **Dashboard** : charge sans erreur JS, toutes les fonctions critiques definies
- **config.js** : charge OK, lit .env sans erreur
- **agent-lead-qa.js** : charge OK, exports fonctionnels (analyzeUS, enrichUS, etc.)
- **scenario-executor.js** : charge OK, validateScenario + executeScenario exportes
- **agent-jira-queue.js** : charge OK, 4 workflows operationnels
- **agent-playwright-direct.js** : charge OK, modes ui/api/fix/tnr fonctionnels
- **agent-inspector.js** : charge OK (fix chemin screenshots corrige)
- **agent-css-audit.js** : charge OK, audit multi-env multi-navigateur
- **agent-matrix.js** : charge OK
- **agent-drupal.js** : charge OK, 17+ types de contenu supportes
- **agent-poller.js** : charge OK via agent-jira-queue.js
- **agent-cycle.js** : charge OK via agent-server.js
- **Diagnostic IA** : renderDiagnosticBlock universel + bouton Corriger toujours visible
- **Rapports** : tries DESC, badge DERNIER RUN, opacity anciens runs, scenarios affiches
- **Chat IA** : Claude API (Haiku/Sonnet), pieces jointes, projets, GitHub, Jira, Web

## Ce qui etait casse (corrige cette session)

- **agent-reporter.js** : `CFG is not defined` — import config.js manquant, credentials en dur remplaces par config
- **agent-inspector.js** : chemin screenshots double (`__dirname + chemin absolu`) — corrige
- **/api/health** : route inexistante — ajoutee

## Risques connus

- **Credentials en dur** : `agent.js` et `agent-drupal.js` contiennent encore des credentials hardcodes (email, token Jira, logins Drupal). Fonctionnel mais risque securite si le repo est public.
- **Serveur ancienne version** : le serveur en cours d'execution peut etre en retard par rapport au code sur disque. Toujours redemarrer apres un deploy.
- **agent-reporter.js** : utilise encore Ollama (non Claude API) pour la generation de release notes. Fonctionnel si Ollama tourne, sinon erreur silencieuse.
- **Playwright sur Render** : necessite le fix `PLAYWRIGHT_BROWSERS_PATH` en tete de fichier + `postinstall` dans package.json. Sessions Cloudflare (`auth/*.json`) doivent etre uploadees manuellement.
- **Node.js v24** : `process.stdout.setEncoding` supprime de tous les agents, mais verifier si de nouveaux agents sont ajoutes.

## En cours

- Scenarios AUTO generes par Claude et executes par Playwright (scenario-executor.js integre)
- Systeme de correction intelligente (4 types : Jira, Fix auto, Config, Chat IA)

---

## Regle de stabilite (a respecter avant chaque commit)

1. `curl http://localhost:3210/api/health` → doit repondre 200
2. `node agent-playwright-direct.js ui url` → doit demarrer sans crash
3. Dashboard charge sans erreur JS dans la console

Si un de ces 3 points echoue → **ne pas commiter**.
