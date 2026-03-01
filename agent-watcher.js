// agent-watcher.js - Surveillance du dossier inbox
// Traite automatiquement les fichiers XML déposés dans inbox/
// Usage : node agent-watcher.js

"use strict";


const fs   = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

// ── CONFIG CENTRALISÉE ────────────────────────────────────────────────────────
const CFG = require("./config");
const JIRA_HOST    = CFG.jira.host;
const JIRA_EMAIL   = CFG.jira.email;
const JIRA_TOKEN   = CFG.jira.token;
const JIRA_PROJECT = CFG.jira.project;

const INBOX_DIR     = path.join(__dirname, "inbox");
const OUTBOX_DIR    = path.join(__dirname, "outbox");
const PROCESSED_DIR = path.join(__dirname, "processed");
const ERROR_DIR     = path.join(__dirname, "errors");

const WATCH_INTERVAL = 5000; // Vérifie toutes les 5 secondes
// ────────────────────────────────────────────────────────────────────────────

// Créer les dossiers nécessaires
[INBOX_DIR, OUTBOX_DIR, PROCESSED_DIR, ERROR_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── PARSING XML SIMPLE ────────────────────────────────────────────────────────
function parseXML(content) {
  function getTag(tag, text) {
    const match = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match ? match[1].trim() : "";
  }

  function getTags(tag, text) {
    const results = [];
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    let match;
    while ((match = regex.exec(text)) !== null) {
      results.push(match[1].trim());
    }
    return results;
  }

  const type        = getTag("type", content).toUpperCase() || "BUG";
  const epic        = getTag("epic", content) || "EPIC";
  const title       = getTag("title", content) || "Sans titre";
  const description = getTag("description", content) || "";
  const severity    = getTag("severity", content) || "Majeur";
  const env         = getTag("env", content) || "Sophie";
  const expected    = getTag("expected", content) || "";
  const actual      = getTag("actual", content) || "";
  const persona     = getTag("persona", content) || "testeur QA";
  const want        = getTag("want", content) || description;
  const goal        = getTag("goal", content) || "";
  const steps       = getTags("step", content);
  const criteria    = getTags("criterion", content);

  return { type, epic, title, description, severity, env, expected, actual, persona, want, goal, steps, criteria };
}

// ── GÉNÉRATION FICHIER MARKDOWN ───────────────────────────────────────────────
function generateMarkdown(ticket) {
  if (ticket.type === "BUG") {
    return `# BUG - [${ticket.epic}] - ${ticket.title}

## Sévérité
${ticket.severity}

## Environnement
${ticket.env}

## Description
${ticket.description}

## Étapes de reproduction
${ticket.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "À compléter"}

## Résultat obtenu
${ticket.actual}

## Résultat attendu
${ticket.expected}

## Captures / Preuves
À joindre
`;
  }

  if (ticket.type === "US") {
    return `# User Story - [${ticket.epic}] - ${ticket.title}

## Description
**En tant que** ${ticket.persona}
**Je veux** ${ticket.want}
**Afin de** ${ticket.goal}

## Critères d'acceptation
${ticket.criteria.map((c, i) => `- AC${i + 1} : ${c}`).join("\n") || "- AC1 : À définir"}

## Notes techniques
${ticket.description}
`;
  }

  if (ticket.type === "TEST") {
    return `# TEST - [${ticket.epic}] - ${ticket.title}

## Objectif
${ticket.description}

## Étapes de test
${ticket.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "À compléter"}

## Résultat attendu
${ticket.expected}
`;
  }

  return `# ${ticket.type} - [${ticket.epic}] - ${ticket.title}\n\n${ticket.description}`;
}

// ── CRÉATION TICKET JIRA ──────────────────────────────────────────────────────
function createJiraTicket(ticket) {
  return new Promise((resolve, reject) => {
    const issueTypeMap = { "BUG": "Bug", "US": "Story", "TEST": "Task", "TASK": "Task" };
    const issueType    = issueTypeMap[ticket.type] || "Task";

    const summary = ticket.type === "US"
      ? `User Story - [${ticket.epic}] - ${ticket.title}`
      : ticket.type === "BUG"
      ? `BUG - [${ticket.epic}] - ${ticket.title}`
      : `TEST - [${ticket.epic}] - ${ticket.title}`;

    const descriptionText = ticket.type === "BUG"
      ? `Sévérité: ${ticket.severity}\nEnv: ${ticket.env}\n\nDescription: ${ticket.description}\n\nÉtapes:\n${ticket.steps.join("\n")}\n\nObtenu: ${ticket.actual}\nAttendu: ${ticket.expected}`
      : ticket.type === "US"
      ? `En tant que ${ticket.persona}\nJe veux ${ticket.want}\nAfin de ${ticket.goal}\n\nCritères:\n${ticket.criteria.join("\n")}`
      : `${ticket.description}\n\nÉtapes:\n${ticket.steps.join("\n")}\n\nAttendu: ${ticket.expected}`;

    const body = JSON.stringify({
      fields: {
        project: { key: JIRA_PROJECT },
        summary: summary,
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
          const parsed = JSON.parse(data);
          if (parsed.key) resolve(parsed.key);
          else reject(new Error(JSON.stringify(parsed.errors || parsed)));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── TRAITEMENT D'UN FICHIER XML ───────────────────────────────────────────────
async function processFile(filename) {
  const filepath = path.join(INBOX_DIR, filename);
  console.log(`\n[WATCHER] 📄 Traitement : ${filename}`);

  let content;
  try {
    content = fs.readFileSync(filepath, "utf8");
  } catch (e) {
    console.error(`[WATCHER] ❌ Lecture impossible : ${e.message}`);
    return;
  }

  // Parser le XML
  let ticket;
  try {
    ticket = parseXML(content);
    console.log(`[WATCHER] Type : ${ticket.type} | Epic : ${ticket.epic} | Titre : ${ticket.title}`);
  } catch (e) {
    console.error(`[WATCHER] ❌ XML invalide : ${e.message}`);
    fs.renameSync(filepath, path.join(ERROR_DIR, filename));
    return;
  }

  // Générer le fichier markdown
  const mdContent  = generateMarkdown(ticket);
  const mdFilename = `${ticket.type}-${ticket.epic}-${ticket.title}.md`.replace(/[<>:"/\\|?*]/g, "-");
  const mdPath     = path.join(OUTBOX_DIR, mdFilename);
  fs.writeFileSync(mdPath, mdContent, "utf8");
  console.log(`[WATCHER] ✅ Fichier généré : ${mdFilename}`);

  // Créer le ticket Jira
  try {
    const jiraKey = await createJiraTicket(ticket);
    console.log(`[WATCHER] ✅ Jira : https://${JIRA_HOST}/browse/${jiraKey}`);

    // Archiver le XML avec le numéro Jira
    const processedName = `${jiraKey}-${filename}`;
    fs.renameSync(filepath, path.join(PROCESSED_DIR, processedName));
    console.log(`[WATCHER] 📦 Archivé : processed/${processedName}`);

  } catch (e) {
    console.error(`[WATCHER] ❌ Erreur Jira : ${e.message}`);
    // Garder le fichier dans inbox pour retry
    const errorLog = path.join(ERROR_DIR, `${filename}.error.txt`);
    fs.writeFileSync(errorLog, e.message, "utf8");
  }
}

// ── SURVEILLANCE DU DOSSIER INBOX ────────────────────────────────────────────
const processing = new Set();

async function watchInbox() {
  const files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith(".xml"));

  for (const file of files) {
    if (processing.has(file)) continue;
    processing.add(file);
    try {
      await processFile(file);
    } finally {
      processing.delete(file);
    }
  }
}

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
console.log("════════════════════════════════════════════════════════════");
console.log("  AGENT WATCHER - Surveillance inbox XML");
console.log("════════════════════════════════════════════════════════════");
console.log(`[WATCHER] 👀 Surveillance de : ${INBOX_DIR}`);
console.log(`[WATCHER] ⏱️  Intervalle : ${WATCH_INTERVAL / 1000}s`);
console.log(`[WATCHER] 📁 Dossiers :`);
console.log(`  inbox/     → Dépose tes fichiers XML ici`);
console.log(`  outbox/    → Tickets .md générés`);
console.log(`  processed/ → XML traités et archivés`);
console.log(`  errors/    → XML en erreur`);
console.log("════════════════════════════════════════════════════════════");
console.log("[WATCHER] En attente de fichiers XML...\n");

// Vérification immédiate au démarrage
watchInbox();

// Puis toutes les 5 secondes
setInterval(watchInbox, WATCH_INTERVAL);

// Créer des exemples de templates XML
const templateBug = `<?xml version="1.0" encoding="UTF-8"?>
<ticket>
  <type>BUG</type>
  <epic>API Drupal</epic>
  <title>Erreur 500 sur l'endpoint /companies</title>
  <description>L'API retourne une erreur 500 lors de l'appel à /companies avec un paramètre vide</description>
  <severity>Majeur</severity>
  <env>Sophie</env>
  <steps>
    <step>Appeler GET /api/companies avec paramètre vide</step>
    <step>Observer la réponse HTTP</step>
  </steps>
  <expected>Retourner 400 Bad Request avec message d'erreur</expected>
  <actual>Retourner 500 Internal Server Error</actual>
</ticket>`;

const templateUS = `<?xml version="1.0" encoding="UTF-8"?>
<ticket>
  <type>US</type>
  <epic>API Drupal</epic>
  <title>Validation des paramètres de dates</title>
  <persona>testeur QA</persona>
  <want>valider les paramètres de dates envoyés à l'API</want>
  <goal>éviter les erreurs 500 dues à des dates mal formatées</goal>
  <description>L'API doit valider le format des dates avant traitement</description>
  <criteria>
    <criterion>Les dates doivent être au format ISO 8601</criterion>
    <criterion>Une date invalide retourne 400 avec message explicite</criterion>
    <criterion>Les dates futures sont rejetées si l'endpoint ne les accepte pas</criterion>
  </criteria>
</ticket>`;

const templateTest = `<?xml version="1.0" encoding="UTF-8"?>
<ticket>
  <type>TEST</type>
  <epic>API Drupal</epic>
  <title>Test validation dates invalides</title>
  <description>Vérifier que l'API rejette les dates mal formatées</description>
  <steps>
    <step>Envoyer une requête avec date au format DD/MM/YYYY</step>
    <step>Envoyer une requête avec date texte "hier"</step>
    <step>Envoyer une requête sans date</step>
  </steps>
  <expected>Chaque requête retourne 400 Bad Request avec message d'erreur clair</expected>
</ticket>`;

// Sauvegarder les templates
const templatesDir = path.join(__dirname, "inbox", "templates");
if (!fs.existsSync(templatesDir)) {
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, "template-bug.xml"),  templateBug,  "utf8");
  fs.writeFileSync(path.join(templatesDir, "template-us.xml"),   templateUS,   "utf8");
  fs.writeFileSync(path.join(templatesDir, "template-test.xml"), templateTest, "utf8");
  console.log("[WATCHER] 📋 Templates créés dans inbox/templates/");
}
