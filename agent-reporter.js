// agent-reporter.js - Agent Rapports & Release Notes
// Usage : node agent-reporter.js "Sprint 42"

"use strict";


const fs   = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const cfg  = require("./config");

// ── VARIABLES DEPUIS CONFIG ──────────────────────────────────────────────────
const OLLAMA_MODEL  = (cfg.ollama && cfg.ollama.model) || "llama3";
const JIRA_HOST     = cfg.jira.host;
const JIRA_EMAIL    = cfg.jira.email;
const JIRA_TOKEN    = cfg.jira.token;
const JIRA_PROJECT  = cfg.jira.project;

const REPORTS_DIR   = cfg.paths.reports;
const OUTBOX_DIR    = path.join(__dirname, "outbox");
// ────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ── APPEL OLLAMA ──────────────────────────────────────────────────────────────
function callOllama(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
      options: { temperature: 0.3 }
    });

    const options = {
      hostname: "127.0.0.1",
      port: (cfg.ollama && cfg.ollama.port) || 11434,
      path: "/api/generate",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || "");
        } catch (e) {
          reject(new Error("Erreur Ollama : " + e.message));
        }
      });
    });

    req.on("error", e => reject(new Error("Ollama injoignable : " + e.message)));
    req.write(body);
    req.end();
  });
}

// ── APPEL JIRA API - RÉCUPÉRER LES TICKETS ────────────────────────────────────
function fetchJiraTickets(sprintName) {
  return new Promise((resolve, reject) => {
    const jql = encodeURIComponent(`project=${JIRA_PROJECT} AND sprint="${sprintName}" ORDER BY created DESC`);
    const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");

    const options = {
      hostname: JIRA_HOST,
      path: `/rest/api/3/search/jql?jql=${jql}&maxResults=100`,
      method: "GET",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json"
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.issues || []);
        } catch (e) {
          reject(new Error("Erreur Jira : " + e.message));
        }
      });
    });

    req.on("error", e => reject(new Error("Jira injoignable : " + e.message)));
    req.end();
  });
}

// ── LIRE LES RAPPORTS PLAYWRIGHT ──────────────────────────────────────────────
function readPlaywrightReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const content = fs.readFileSync(path.join(REPORTS_DIR, f), "utf8");
      const status  = content.includes("✅ SUCCÈS") ? "PASS" : "FAIL";
      const nameMatch = content.match(/# Rapport de Test - (.+)/);
      return {
        file: f,
        name: nameMatch ? nameMatch[1] : f,
        status: status,
        content: content.substring(0, 500)
      };
    });
}

// ── LIRE LES TICKETS GÉNÉRÉS EN LOCAL ────────────────────────────────────────
function readLocalTickets() {
  if (!fs.existsSync(OUTBOX_DIR)) return { us: [], bugs: [], tests: [] };
  const files = fs.readdirSync(OUTBOX_DIR);
  return {
    us:    files.filter(f => f.startsWith("US-")),
    bugs:  files.filter(f => f.startsWith("BUG-")),
    tests: files.filter(f => f.startsWith("TEST-") || f.startsWith("CAS_TEST-"))
  };
}

// ── GÉNÉRATION RELEASE NOTES VIA OLLAMA ──────────────────────────────────────
async function generateReleaseNotes(sprintName, jiraTickets, playwrightReports, localTickets) {
  const ticketsSummary = jiraTickets.slice(0, 20).map(t =>
    `- ${t.key}: ${t.fields?.summary || "Sans titre"} [${t.fields?.status?.name || "?"}]`
  ).join("\n");

  const testsSummary = playwrightReports.map(r =>
    `- ${r.name}: ${r.status}`
  ).join("\n");

  const prompt = `Tu es un expert QA. Génère des release notes professionnelles en français pour le sprint "${sprintName}".

Tickets Jira du sprint :
${ticketsSummary || "Aucun ticket récupéré"}

Résultats des tests automatisés :
${testsSummary || "Aucun test exécuté"}

Tickets générés localement :
- User Stories : ${localTickets.us.length}
- Bugs : ${localTickets.bugs.length}
- Tests : ${localTickets.tests.length}

Génère des release notes claires avec :
1. Résumé du sprint
2. Nouvelles fonctionnalités
3. Bugs corrigés
4. Résultats QA
5. Points d'attention

Réponds en markdown propre et professionnel.`;

  console.log("[INFO] Génération des release notes via Ollama...");
  return await callOllama(prompt);
}

// ── GÉNÉRATION RAPPORT QA ─────────────────────────────────────────────────────
function generateQAReport(sprintName, jiraTickets, playwrightReports, localTickets) {
  const passTests = playwrightReports.filter(r => r.status === "PASS").length;
  const failTests = playwrightReports.filter(r => r.status === "FAIL").length;
  const total     = playwrightReports.length;
  const coverage  = total > 0 ? Math.round((passTests / total) * 100) : 0;

  const bugTickets = jiraTickets.filter(t =>
    t.fields?.issuetype?.name === "Bug"
  );
  const storyTickets = jiraTickets.filter(t =>
    t.fields?.issuetype?.name === "Story"
  );

  return `# Rapport QA - ${sprintName}
**Date :** ${new Date().toLocaleString("fr-FR")}

---

## 📊 Tableau de bord

| Métrique | Valeur |
|----------|--------|
| Tests automatisés | ${total} |
| Tests réussis | ✅ ${passTests} |
| Tests échoués | ❌ ${failTests} |
| Taux de succès | ${coverage}% |
| User Stories | ${storyTickets.length} |
| Bugs Jira | ${bugTickets.length} |
| Tickets locaux générés | ${localTickets.us.length + localTickets.bugs.length + localTickets.tests.length} |

---

## 🧪 Résultats des tests automatisés
${playwrightReports.length > 0
  ? playwrightReports.map(r => `- ${r.status === "PASS" ? "✅" : "❌"} ${r.name}`).join("\n")
  : "Aucun test automatisé exécuté"}

---

## 🐛 Bugs Jira
${bugTickets.length > 0
  ? bugTickets.map(t => `- [${t.key}] ${t.fields?.summary} — ${t.fields?.status?.name}`).join("\n")
  : "Aucun bug dans ce sprint"}

---

## 📋 User Stories
${storyTickets.length > 0
  ? storyTickets.map(t => `- [${t.key}] ${t.fields?.summary} — ${t.fields?.status?.name}`).join("\n")
  : "Aucune US dans ce sprint"}

---

## 📁 Tickets générés localement
- **User Stories :** ${localTickets.us.join(", ") || "Aucune"}
- **Bugs :** ${localTickets.bugs.join(", ") || "Aucun"}
- **Tests :** ${localTickets.tests.join(", ") || "Aucun"}

---

## ✅ Conclusion
${coverage >= 80
  ? "🟢 Qualité satisfaisante — le sprint peut être livré."
  : coverage >= 50
  ? "🟡 Qualité acceptable — surveiller les points d'échec."
  : "🔴 Qualité insuffisante — des corrections sont nécessaires avant livraison."}
`;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const sprintName = process.argv[2];

  if (!sprintName) {
    console.error("[ERR] Usage : node agent-reporter.js \"Nom du Sprint\"");
    console.error("Exemples :");
    console.error("  node agent-reporter.js \"Sprint 42\"");
    console.error("  node agent-reporter.js \"Sprint API Drupal\"");
    process.exit(1);
  }

  console.log(`[INFO] Génération du rapport pour : ${sprintName}`);

  // 1. Récupérer les tickets Jira
  let jiraTickets = [];
  try {
    jiraTickets = await fetchJiraTickets(sprintName);
    console.log(`[INFO] ${jiraTickets.length} tickets Jira récupérés`);
  } catch (e) {
    console.warn("[WARN] Impossible de récupérer les tickets Jira :", e.message);
  }

  // 2. Lire les rapports Playwright
  const playwrightReports = readPlaywrightReports();
  console.log(`[INFO] ${playwrightReports.length} rapports de tests trouvés`);

  // 3. Lire les tickets locaux
  const localTickets = readLocalTickets();
  console.log(`[INFO] Tickets locaux — US: ${localTickets.us.length}, Bugs: ${localTickets.bugs.length}, Tests: ${localTickets.tests.length}`);

  // 4. Générer le rapport QA
  const qaReport = generateQAReport(sprintName, jiraTickets, playwrightReports, localTickets);
  const qaReportPath = path.join(REPORTS_DIR, `QA-Report-${sprintName.replace(/\s+/g, "-")}-${Date.now()}.md`);
  fs.writeFileSync(qaReportPath, qaReport, { encoding: "utf8" });
  console.log(`[OK] Rapport QA : ${qaReportPath}`);

  // 5. Générer les release notes via Ollama
  let releaseNotes;
  try {
    releaseNotes = await generateReleaseNotes(sprintName, jiraTickets, playwrightReports, localTickets);
  } catch (e) {
    console.warn("[WARN] Erreur Ollama release notes :", e.message);
    releaseNotes = `# Release Notes - ${sprintName}\n\nGénération automatique indisponible.`;
  }

  const releaseNotesPath = path.join(REPORTS_DIR, `Release-Notes-${sprintName.replace(/\s+/g, "-")}-${Date.now()}.md`);
  fs.writeFileSync(releaseNotesPath, releaseNotes, { encoding: "utf8" });
  console.log(`[OK] Release Notes : ${releaseNotesPath}`);

  console.log("\n[OK] Rapport complet généré !");
  console.log(`  📊 Rapport QA    : ${qaReportPath}`);
  console.log(`  📝 Release Notes : ${releaseNotesPath}`);
}

main().catch(e => {
  console.error("[ERR FATAL]", e.message);
  process.exit(1);
});
