// agent.js - Aby QA V2 - Agent principal
// Usage : node agent.js "Ta demande en langage naturel"

"use strict";


const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const https = require("https");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const OLLAMA_MODEL = "llama3";
const SERVER_PORT  = 3210;
const OUTBOX_DIR   = path.join(__dirname, "outbox");
const AUTO_OPEN    = true;

const JIRA_HOST    = "eurelis.atlassian.net";
const JIRA_EMAIL   = "ismaila.traore.ext@safrangroup.com";
const JIRA_TOKEN   = "ATATT3xFfGF0iLS4y8JZCHZfZ_csF5dYRcu1NJVmSH8WPxGuBU4XI3Z4Q8unzTV2zowuWHQ2NMLoquFf1mvS_C4WnOLkcBZevToUJiXF3kbgqC21qMYbAepqODv2GGsi22XWqyo4jcIO9l-1g7-qNmNJkMsT729eOyWmYxaU9atre7h5AkTth9U=D7B09488";
const JIRA_PROJECT = "SAFWBST";
// ────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });

// ── APPEL OLLAMA ──────────────────────────────────────────────────────────────
function callOllama(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OLLAMA_MODEL, prompt, stream: false,
      options: { temperature: 0.2 }
    });
    const req = http.request({
      hostname: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data).response || ""); }
        catch (e) { reject(new Error("Erreur Ollama : " + e.message)); }
      });
    });
    req.on("error", e => reject(new Error("Ollama injoignable : " + e.message)));
    req.write(body); req.end();
  });
}

// ── EXTRACTION JSON ROBUSTE ───────────────────────────────────────────────────
function extractJSON(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/) ||
                text.match(/```\s*([\s\S]*?)```/) ||
                text.match(/(\{[\s\S]*\})/);
  if (!match) throw new Error("Aucun JSON trouvé");
  const cleaned = match[1].trim()
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  return JSON.parse(cleaned);
}

// ── DÉTECTION D'INTENT ────────────────────────────────────────────────────────
async function detectIntent(userRequest) {
  const prompt = `Tu es un expert QA. Analyse cette demande et détermine le type de ticket.
IMPORTANT : Réponds UNIQUEMENT en français dans les valeurs JSON.
Demande : "${userRequest}"

Types :
- "us"   : nouvelle fonctionnalité, besoin métier, demande client, amélioration
- "bug"  : erreur, problème, dysfonctionnement, retourne 500/404
- "test" : cas de test, scénario, vérification
- "csv"  : plusieurs cas de test, matrice

Réponds UNIQUEMENT avec ce JSON :
\`\`\`json
{"type": "us", "epic": "nom de l epic si mentionné sinon vide", "confidence": "high"}
\`\`\``;

  try {
    return extractJSON(await callOllama(prompt));
  } catch (e) {
    const req = userRequest.toLowerCase();
    if (req.match(/bug|erreur|500|404|ne fonctionne|probl[eè]me/)) return { type: "bug",  epic: "", confidence: "medium" };
    if (req.match(/test|v[eé]rifi|cas de test/))                    return { type: "test", epic: "", confidence: "medium" };
    if (req.match(/csv|matrice/))                                    return { type: "csv",  epic: "", confidence: "medium" };
    return { type: "us", epic: "", confidence: "medium" };
  }
}

// ── GÉNÉRATION US ─────────────────────────────────────────────────────────────
async function generateUS(userRequest, epic) {
  const prompt = `Tu es Aby QA V2, expert User Stories. RÉPONDS UNIQUEMENT EN FRANÇAIS.
Analyse cette demande métier et génère une User Story structurée.
Demande : "${userRequest}"
Epic : "${epic || 'non défini'}"

Génère UNIQUEMENT ce JSON avec toutes les valeurs EN FRANÇAIS :
\`\`\`json
{
  "type": "us",
  "epic": "${epic || ''}",
  "title": "titre court en français",
  "persona": "rôle utilisateur en français",
  "want": "fonctionnalité souhaitée en français",
  "goal": "bénéfice attendu en français",
  "testtype": "Validation",
  "scope": "périmètre fonctionnel en français en 1-2 phrases",
  "acs": [
    {"given": "le contexte en français", "when": "l action en français", "then": "le résultat en français"},
    {"given": "le contexte 2 en français", "when": "l action 2", "then": "le résultat 2"},
    {"given": "le contexte 3 en français", "when": "l action 3", "then": "le résultat 3"}
  ]
}
\`\`\``;

  console.log("[INFO] Génération US via Ollama (français)...");
  return extractJSON(await callOllama(prompt));
}

// ── GÉNÉRATION BUG ────────────────────────────────────────────────────────────
async function generateBug(userRequest, epic) {
  const prompt = `Tu es Aby QA V2, expert tickets Bug. RÉPONDS UNIQUEMENT EN FRANÇAIS.
Description du bug : "${userRequest}"
Epic : "${epic || 'non défini'}"

Génère UNIQUEMENT ce JSON avec toutes les valeurs EN FRANÇAIS :
\`\`\`json
{
  "type": "bug",
  "epic": "${epic || ''}",
  "title": "titre court du bug en français",
  "severity": "Majeure",
  "env": "Sophie",
  "endpoint": "endpoint concerné si mentionné sinon vide",
  "steps": ["étape 1 en français", "étape 2", "étape 3"],
  "expected": "comportement attendu en français",
  "actual": "comportement observé en français",
  "cause": "cause probable en français"
}
\`\`\``;

  console.log("[INFO] Génération Bug via Ollama (français)...");
  return extractJSON(await callOllama(prompt));
}

// ── GÉNÉRATION TEST ───────────────────────────────────────────────────────────
async function generateTest(userRequest, epic) {
  const prompt = `Tu es Aby QA V2, expert tickets de Test. RÉPONDS UNIQUEMENT EN FRANÇAIS.
Demande : "${userRequest}"
Epic : "${epic || 'non défini'}"

Génère UNIQUEMENT ce JSON avec toutes les valeurs EN FRANÇAIS :
\`\`\`json
{
  "type": "test",
  "epic": "${epic || ''}",
  "title": "titre du test en français",
  "objective": "vérifier que ... en français",
  "env": "Sophie",
  "data": "données de test nécessaires en français",
  "steps": ["étape 1 en français", "étape 2", "étape 3"],
  "expected": "résultat attendu en français"
}
\`\`\``;

  console.log("[INFO] Génération Test via Ollama (français)...");
  return extractJSON(await callOllama(prompt));
}

// ── GÉNÉRATION TEST DEPUIS US ─────────────────────────────────────────────────
async function generateTestFromUS(usData) {
  const prompt = `Tu es Aby QA V2. RÉPONDS UNIQUEMENT EN FRANÇAIS.
À partir de cette User Story, génère un ticket de test correspondant.

User Story :
- Titre : ${usData.title}
- Epic : ${usData.epic || 'non défini'}
- En tant que ${usData.persona}, je veux ${usData.want}, afin de ${usData.goal}
- Critères : ${(usData.acs || []).map((ac, i) => `AC${i+1}: Étant donné ${ac.given}, quand ${ac.when}, alors ${ac.then}`).join(' | ')}

Génère UNIQUEMENT ce JSON EN FRANÇAIS :
\`\`\`json
{
  "type": "test",
  "epic": "${usData.epic || ''}",
  "title": "titre du test en français",
  "us": "US à renseigner",
  "objective": "vérifier que ... en français",
  "env": "Sophie",
  "data": "données de test nécessaires",
  "steps": ["étape 1", "étape 2", "étape 3", "étape 4"],
  "expected": "résultat attendu complet"
}
\`\`\``;

  console.log("[INFO] Génération Test depuis US (français)...");
  return extractJSON(await callOllama(prompt));
}

// ── GÉNÉRATION CSV DEPUIS US ──────────────────────────────────────────────────
async function generateCSVFromUS(usData) {
  const prompt = `Tu es Aby QA V2. RÉPONDS UNIQUEMENT EN FRANÇAIS.
Génère des cas de test CSV à partir de cette User Story.

User Story :
- Titre : ${usData.title}
- En tant que ${usData.persona}, je veux ${usData.want}, afin de ${usData.goal}
- Critères : ${(usData.acs || []).map((ac, i) => `AC${i+1}: ${ac.then}`).join(' | ')}

Génère UNIQUEMENT ce JSON EN FRANÇAIS (un cas par AC + cas négatifs) :
\`\`\`json
{
  "feature": "${usData.title}",
  "description": "Cas de test pour ${usData.title}",
  "cases": [
    {"action": "Étant donné [contexte]\nLorsque [action]\nAlors [résultat]", "data": "• Donnée 1 : valeur\n• Donnée 2 : valeur", "expected": "• Critère 1\n• Critère 2\n• Pas d erreur serveur 5xx"},
    {"action": "Étant donné [contexte négatif]\nLorsque [action invalide]\nAlors [rejet attendu]", "data": "• Donnée invalide : valeur", "expected": "• Message d erreur explicite\n• Code 400 ou 422\n• Pas d erreur serveur 5xx"}
  ]
}
\`\`\``;

  console.log("[INFO] Génération CSV depuis US (français)...");
  return extractJSON(await callOllama(prompt));
}

// ── GÉNÉRATION GUIDE D'EXÉCUTION ──────────────────────────────────────────────
async function generateGuide(usData, testData) {
  const prompt = `Tu es Aby QA V2. RÉPONDS UNIQUEMENT EN FRANÇAIS.
Génère un guide d'exécution de test détaillé et professionnel.

User Story : ${usData.title}
Epic : ${usData.epic || 'non défini'}
Objectif du test : ${testData.objective}
Environnement : ${testData.env}
Étapes : ${(testData.steps || []).join(' | ')}
Résultat attendu : ${testData.expected}

Génère un guide markdown complet EN FRANÇAIS avec :
1. Objectif
2. Prérequis
3. Étapes détaillées (numérotées, avec captures à faire)
4. Critères de validation (checkboxes)
5. Que faire en cas d'échec
6. Notes de l'exécutant

Réponds avec le contenu markdown directement (pas de JSON).`;

  console.log("[INFO] Génération guide d'exécution (français)...");
  return await callOllama(prompt);
}

// ── ENVOI AU SERVEUR ──────────────────────────────────────────────────────────
function sendToServer(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req  = http.request({
      hostname: "127.0.0.1", port: SERVER_PORT, path: "/prefill", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// ── CRÉATION JIRA DIRECTE (fallback) ─────────────────────────────────────────
function createJiraTicket(issueType, summary, descriptionText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      fields: {
        project: { key: JIRA_PROJECT },
        summary,
        description: {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: descriptionText }] }]
        },
        issuetype: { name: issueType }
      }
    });
    const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
    const req  = https.request({
      hostname: JIRA_HOST, path: "/rest/api/3/issue", method: "POST",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(data);
          if (p.key) resolve(p.key);
          else reject(new Error(JSON.stringify(p.errors || p)));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// ── SAUVEGARDE LOCALE ─────────────────────────────────────────────────────────
function saveLocal(data, customContent) {
  const epicPart = data.epic ? `-${data.epic}` : '';
  const filename = `${data.type.toUpperCase()}${epicPart}-${data.title}.md`
    .replace(/[<>:"/\\|?*\s]/g, '-').replace(/-+/g, '-');
  const filepath = path.join(OUTBOX_DIR, filename);

  let content = customContent;
  if (!content) {
    content = `# ${data.type.toUpperCase()}${data.epic ? ` - [${data.epic}]` : ''} - ${data.title}\n\n`;
    if (data.type === 'us') {
      content += `## Description\nEn tant que ${data.persona}, je veux ${data.want}, afin de ${data.goal}\n\n## Critères d'acceptation\n`;
      (data.acs || []).forEach((ac, i) => {
        content += `\n### AC${i+1}\nÉtant donné ${ac.given}\nQuand ${ac.when}\nAlors ${ac.then}\n`;
      });
      if (data.scope) content += `\n## Périmètre\n${data.scope}\n`;
    } else if (data.type === 'bug') {
      content += `## Étapes\n${(data.steps||[]).map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\n`;
      content += `## Résultat attendu\n${data.expected}\n\n## Résultat obtenu\n${data.actual}\n\n## Sévérité\n${data.severity}\n`;
    } else if (data.type === 'test') {
      content += `## Objectif\n${data.objective}\n\n## Étapes\n${(data.steps||[]).map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\n`;
      content += `## Résultat attendu\n${data.expected}\n`;
    }
  }

  fs.writeFileSync(filepath, content, "utf8");
  return { filename, filepath };
}

// ── SAUVEGARDE CSV (format Xray natif) ───────────────────────────────────────
function saveCSV(data) {
  const filename = `CAS_TEST-${data.feature}.csv`.replace(/[<>:"/\\|?*\s]/g, '-').replace(/-+/g, '-');
  const filepath = path.join(OUTBOX_DIR, filename);
  const escape = s => '"' + (s || '').replace(/"/g, '""') + '"';

  // Format Xray natif : Test Type, Summary, Action, Data, Expected Result
  const header = 'Test Type,Summary,Action,Data,Expected Result';
  const rows = (data.cases || []).map((c, i) => [
    escape("Manual"),
    escape(`${data.feature} - Cas ${i + 1}`),
    escape(c.action),
    escape(c.data),
    escape(c.expected)
  ].join(','));

  // BOM UTF-8 pour compatibilité Excel/Jira
  const content = header + '\n' + rows.join('\n');
  fs.writeFileSync(filepath, '\uFEFF' + content, "utf8");
  return { filename, filepath };
}

// ── PAUSE ─────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const userRequest = process.argv[2];

  if (!userRequest) {
    console.error("[ERR] Usage : node agent.js \"Ta demande\"");
    console.error("\nExemples :");
    console.error("  node agent.js \"Le client veut filtrer les actualités par date sur la homepage\"");
    console.error("  node agent.js \"Bug : le menu navigation disparaît sur mobile\"");
    console.error("  node agent.js \"Génère une US pour la recherche par mots-clés\"");
    process.exit(1);
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`  ABY QA V2`);
  console.log(`════════════════════════════════════════`);
  console.log(`[INFO] Demande : "${userRequest}"\n`);

  // 1. Détecter l'intent
  let intent;
  try {
    intent = await detectIntent(userRequest);
    console.log(`[INFO] Type    : ${intent.type.toUpperCase()}`);
    console.log(`[INFO] Epic    : ${intent.epic || '(non défini)'}`);
  } catch (e) {
    console.error("[ERR] Détection :", e.message);
    process.exit(1);
  }

  // 2. Générer les données
  let ticketData;
  try {
    if      (intent.type === 'us')   ticketData = await generateUS(userRequest, intent.epic);
    else if (intent.type === 'bug')  ticketData = await generateBug(userRequest, intent.epic);
    else if (intent.type === 'test') ticketData = await generateTest(userRequest, intent.epic);
    else                             ticketData = { type: 'csv', title: userRequest.substring(0, 30), epic: intent.epic };
    console.log(`[INFO] Titre   : ${ticketData.title}`);
  } catch (e) {
    console.error("[ERR] Génération :", e.message);
    process.exit(1);
  }

  // 3. Sauvegarder localement
  const { filename } = saveLocal(ticketData);
  console.log(`[OK] Fichier   : ${filename}`);

  // 4. Ouvrir formulaire pré-rempli (US principal)
  if (AUTO_OPEN) {
    try {
      await sendToServer(ticketData);
      console.log(`\n[OK] ✅ Formulaire ouvert dans le navigateur`);
    } catch (e) {
      console.log("\n[WARN] Serveur non actif → création directe dans Jira...");
      try {
        const issueTypeMap = { us: "Story", bug: "Bug", test: "Task" };
        const epicStr  = ticketData.epic ? ` - [${ticketData.epic}]` : '';
        const summary  = `${ticketData.type.toUpperCase()}${epicStr} - ${ticketData.title}`;
        const content  = fs.readFileSync(path.join(OUTBOX_DIR, filename), "utf8");
        const jiraKey  = await createJiraTicket(issueTypeMap[ticketData.type] || "Task", summary, content.substring(0, 500));
        console.log(`[JIRA] ✅ Ticket créé : https://${JIRA_HOST}/browse/${jiraKey}`);
      } catch (jiraErr) {
        console.error("[ERR] Jira :", jiraErr.message);
      }
      return;
    }
  }

  // 5. Si c'est une US → générer automatiquement Test + CSV + Guide
  if (intent.type === 'us') {
    console.log(`\n[INFO] Génération automatique des livrables QA...`);
    await sleep(2000); // laisser le formulaire US s'ouvrir

    // Générer ticket de test
    try {
      const testData = await generateTestFromUS(ticketData);
      saveLocal(testData);
      console.log(`[OK] Ticket Test généré : ${testData.title}`);
      await sleep(1500);
      await sendToServer({ ...testData, _fromUS: true });
      console.log(`[OK] ✅ Formulaire Test ouvert`);
    } catch (e) {
      console.warn("[WARN] Test non généré :", e.message);
    }

    await sleep(3000); // laisser le formulaire Test s'ouvrir

    // Générer CSV
    try {
      const csvData = await generateCSVFromUS(ticketData);
      const { filename: csvFile } = saveCSV(csvData);
      console.log(`[OK] CSV généré : ${csvFile}`);
      await sleep(1500);
      await sendToServer({ ...csvData, type: 'csv', _fromUS: true });
      console.log(`[OK] ✅ Formulaire CSV ouvert`);
    } catch (e) {
      console.warn("[WARN] CSV non généré :", e.message);
    }

    await sleep(3000);

    // Générer guide d'exécution
    try {
      const testDataForGuide = await generateTestFromUS(ticketData);
      const guideContent = await generateGuide(ticketData, testDataForGuide);
      const guideName = `GUIDE-${ticketData.epic ? ticketData.epic + '-' : ''}${ticketData.title}.md`
        .replace(/[<>:"/\\|?*\s]/g, '-').replace(/-+/g, '-');
      const guidePath = path.join(OUTBOX_DIR, guideName);
      fs.writeFileSync(guidePath, guideContent, "utf8");
      console.log(`[OK] Guide d'exécution : ${guideName}`);
    } catch (e) {
      console.warn("[WARN] Guide non généré :", e.message);
    }

    console.log(`\n════════════════════════════════════════`);
    console.log(`  LIVRABLES GÉNÉRÉS`);
    console.log(`════════════════════════════════════════`);
    console.log(`  ✅ US             → Formulaire ouvert`);
    console.log(`  ✅ Ticket Test    → Formulaire ouvert`);
    console.log(`  ✅ Cas de test CSV → Formulaire ouvert`);
    console.log(`  ✅ Guide d'exécution → outbox/`);
    console.log(`════════════════════════════════════════\n`);
  }

  console.log(`[TERMINÉ]`);
}

main().catch(e => { console.error("[ERR FATAL]", e.message); process.exit(1); });