// agent-jira-queue.js — Surveillance automatique de la file Jira
// Orchestré par agent-lead-qa.js (Claude API)
// Workflows : US Backlog (enrichissement) + US To Do + Bug + Test
// Usage : node agent-jira-queue.js

"use strict";

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { spawn } = require("child_process");
const CFG    = require("./config");
const leadQA = require("./agent-lead-qa");

// ── STOCKAGE US ENRICHIES ─────────────────────────────────────────────────────
const ENRICHED_DIR = path.join(__dirname, "inbox", "enriched");

function saveEnrichedUS(key, data) {
  fs.mkdirSync(ENRICHED_DIR, { recursive: true });
  // Extraire automatiquement les URLs de la description (originalMarkdown + enrichedMarkdown)
  var descText = [data.originalMarkdown || "", data.enrichedMarkdown || "", data.description || ""].join("\n");
  var extracted = leadQA.extractUrlsFromDescription(descText);
  // Fusionner avec les testUrls déjà présentes (éviter les doublons)
  var existing = Array.isArray(data.testUrls) ? data.testUrls : [];
  var merged   = existing.slice();
  extracted.forEach(function(u) { if (!merged.includes(u)) merged.push(u); });
  data.testUrls = merged;
  fs.writeFileSync(path.join(ENRICHED_DIR, key + ".json"), JSON.stringify(data, null, 2), "utf8");
}

function getEnrichedUS(key) {
  var f = path.join(ENRICHED_DIR, key + ".json");
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch(e) { return null; }
}

// ── STOCKAGE FILE DES TESTS (Playwright Direct) ────────────────────────────────
const TESTS_DIR = path.join(__dirname, "inbox", "tests");

function saveTestQueue(key, data) {
  fs.mkdirSync(TESTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TESTS_DIR, key + ".json"), JSON.stringify(data, null, 2), "utf8");
}

// ── CONSTANTES ────────────────────────────────────────────────────────────────
const POLL_MS         = 60000;             // Polling "To Do" tickets (60s)
const POLL_BACKLOG_MS = 5 * 60000;         // Polling backlog US (5 min)
const VALIDATION_TIMEOUT_MS = 10 * 60000; // Auto-approve après 10 min si pas de réponse
const SERVER_PORT     = CFG.server.port;
const INBOX_DIR       = path.join(__dirname, "inbox");
const STATE_FILE      = path.join(INBOX_DIR, "queue-processed.json");
const VALIDATIONS_FILE = path.join(INBOX_DIR, "validations.json");
const CLIENT_ID       = "jira-queue";

// ── STATE ─────────────────────────────────────────────────────────────────────
var processed  = loadState();
var statsToday = { us: 0, bug: 0, test: 0, enriched: 0 };
var lastCheck  = null;

// ── UTILITAIRES STATE ─────────────────────────────────────────────────────────
function loadState() {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    if (fs.existsSync(STATE_FILE)) {
      var raw   = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      var today = new Date().toDateString();
      if (raw.date === today) return new Set(raw.keys || []);
    }
  } catch(e) {}
  return new Set();
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      date: new Date().toDateString(),
      keys: Array.from(processed)
    }), "utf8");
  } catch(e) {}
}

// ── VALIDATION GATE ───────────────────────────────────────────────────────────
// Système de validation avant push Jira :
// 1. Sauvegarde dans validations.json
// 2. Pousse SSE vers le dashboard
// 3. Attend résolution (approve/reject) avec timeout auto-approve

function loadValidations() {
  try {
    if (fs.existsSync(VALIDATIONS_FILE))
      return JSON.parse(fs.readFileSync(VALIDATIONS_FILE, "utf8"));
  } catch(e) {}
  return {};
}

function saveValidations(data) {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.writeFileSync(VALIDATIONS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch(e) {}
}

// Crée une entrée de validation et retourne une Promise résolue quand l'utilisateur décide
function requestValidation(type, sourceKey, title, markdown, extra) {
  return new Promise(function(resolve) {
    var id  = type + "-" + sourceKey + "-" + Date.now();
    var all = loadValidations();

    all[id] = {
      id:        id,
      type:      type,       // "us-enrichment" | "test-ticket" | "bug-ticket" | "csv"
      sourceKey: sourceKey,
      title:     title,
      markdown:  markdown,
      extra:     extra || {},
      status:    "pending",
      createdAt: new Date().toISOString()
    };
    saveValidations(all);

    // Push SSE vers le dashboard
    pushSSE({
      type:      "validation-request",
      id:        id,
      valType:   type,
      sourceKey: sourceKey,
      title:     title,
      preview:   markdown.substring(0, 500)
    });

    log("[GATE] Validation requise : " + title);

    // Polling toutes les 3s pour vérifier la décision
    var waited = 0;
    var poll = setInterval(function() {
      waited += 3000;
      var current = loadValidations();
      var entry   = current[id];

      if (!entry || entry.status === "approved") {
        clearInterval(poll);
        log("[GATE] ✅ Approuvé : " + title);
        resolve({ approved: true, id: id, entry: entry || all[id] });
        return;
      }
      if (entry.status === "rejected") {
        clearInterval(poll);
        log("[GATE] ❌ Rejeté : " + title);
        resolve({ approved: false, id: id, entry: entry });
        return;
      }
      // Auto-approve après timeout
      if (waited >= VALIDATION_TIMEOUT_MS) {
        clearInterval(poll);
        current[id].status = "approved";
        saveValidations(current);
        log("[GATE] ⏱️ Auto-approuvé (timeout) : " + title);
        resolve({ approved: true, id: id, auto: true });
      }
    }, 3000);
  });
}

// ── JIRA API ──────────────────────────────────────────────────────────────────
function jiraApi(method, apiPath, body, cb) {
  var auth    = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
  var payload = body ? JSON.stringify(body) : null;
  var opts    = {
    hostname: CFG.jira.host,
    path:     apiPath,
    method:   method,
    headers:  {
      "Authorization": "Basic " + auth,
      "Content-Type":  "application/json",
      "Accept":        "application/json"
    }
  };
  if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);

  var req = https.request(opts, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try   { cb(null, JSON.parse(data), res.statusCode); }
      catch (e) { cb(null, data, res.statusCode); }
    });
  });
  req.on("error", function(e) { cb(e); });
  if (payload) req.write(payload);
  req.end();
}

function jiraApiAsync(method, apiPath, body) {
  return new Promise(function(resolve, reject) {
    jiraApi(method, apiPath, body, function(err, data, status) {
      if (err) return reject(err);
      resolve({ data: data, status: status });
    });
  });
}

function postComment(key, text) {
  return jiraApiAsync("POST", "/rest/api/3/issue/" + key + "/comment", {
    body: {
      type: "doc", version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: text }] }]
    }
  });
}

function transitionIssue(key, targetStatus) {
  return new Promise(function(resolve) {
    jiraApi("GET", "/rest/api/3/issue/" + key + "/transitions", null, function(err, data) {
      if (err || !data || !data.transitions) { resolve(); return; }
      var t = data.transitions.find(function(tr) {
        return tr.to && tr.to.name.toLowerCase() === targetStatus.toLowerCase();
      });
      if (!t) {
        log("[!] Transition '" + targetStatus + "' introuvable pour " + key);
        resolve(); return;
      }
      jiraApi("POST", "/rest/api/3/issue/" + key + "/transitions",
        { transition: { id: t.id } }, function() { resolve(); });
    });
  });
}

function createJiraIssue(fields) {
  return jiraApiAsync("POST", "/rest/api/3/issue", { fields: fields });
}

function updateJiraDescription(key, markdownText) {
  var body = {
    fields: {
      description: {
        type: "doc", version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: markdownText }] }]
      }
    }
  };
  return jiraApiAsync("PUT", "/rest/api/3/issue/" + key, body);
}

// ── SSE VERS LE DASHBOARD ─────────────────────────────────────────────────────
function pushSSE(data) {
  var payload = JSON.stringify({ clientId: CLIENT_ID, data: data });
  var req = http.request({
    hostname: "127.0.0.1", port: SERVER_PORT,
    path: "/api/queue-sse", method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
  }, function() {});
  req.on("error", function() {});
  req.write(payload); req.end();
}

// ── LANCER PLAYWRIGHT ─────────────────────────────────────────────────────────
function runPlaywright(args) {
  return new Promise(function(resolve) {
    var fullArgs = ["agent-playwright-direct.js"].concat(args);
    log("[PW] Lancement : node " + fullArgs.join(" "));
    pushSSE({ type: "log", agent: "playwright", line: "▶ " + fullArgs.join(" ") });

    var proc = spawn("node", fullArgs, {
      cwd: __dirname, shell: true,
      env: Object.assign({}, process.env, { FORCE_COLOR: "0" })
    });

    var output = "";
    proc.stdout.on("data", function(d) {
      d.toString().split("\n").forEach(function(line) {
        if (line.trim()) {
          output += line + "\n";
          pushSSE({ type: "log", agent: "playwright", line: line.trim() });
        }
      });
    });
    proc.stderr.on("data", function(d) {
      d.toString().split("\n").forEach(function(line) {
        if (line.trim()) pushSSE({ type: "err", agent: "playwright", line: line.trim() });
      });
    });
    proc.on("close", function(code) {
      var hasFail = output.toLowerCase().includes("fail") ||
                    output.toLowerCase().includes("error") ||
                    code !== 0;
      resolve({ code: code, hasFail: hasFail, output: output });
    });
    proc.on("error", function(e) {
      resolve({ code: 1, hasFail: true, output: e.message });
    });
  });
}

// ── UTILITAIRES ───────────────────────────────────────────────────────────────
function log(msg) {
  var ts = new Date().toLocaleTimeString("fr-FR");
  console.log("[" + ts + "] " + msg);
}

// Filtre volontairement les URLs safran uniquement (usage Playwright interne)
// Pour toutes les URLs : utiliser leadQA.extractUrlsFromDescription()
function extractUrls(text) {
  if (!text) return [];
  // Extraire les URLs depuis la syntaxe Jira [texte|url]
  var jiraUrls = [];
  var jlRe = /\[([^\|\]]+)\|([^\]]+)\]/g;
  var m;
  while ((m = jlRe.exec(text)) !== null) {
    var u = m[2].trim();
    if (/^https?:\/\//i.test(u) && u.includes("safran")) jiraUrls.push(u);
  }
  var raw = (text.match(/https?:\/\/[^\s"'<>\]\)]+/g) || []);
  return jiraUrls.concat(raw)
    .map(function(u) { return u.replace(/[\)\(\]\[\|\_\{\}]+$/g, "").trim(); })
    .filter(function(u) { return u.includes("safran"); });
}

function extractDesc(fields) {
  if (!fields.description) return "";
  if (typeof fields.description === "string") return fields.description;
  return leadQA.extractText(fields.description);
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW 1 : US BACKLOG — Enrichissement et amélioration
// Détecte les US en Backlog sans AC complets → Lead QA enrichit → Validation Gate
// ══════════════════════════════════════════════════════════════════════════════
async function workflowBacklog(ticket) {
  var key     = ticket.key;
  var summary = ticket.fields.summary || "";

  log("[BACKLOG] " + key + " — Analyse qualité : " + summary);
  pushSSE({ type: "queue-item", key: key, issueType: "US", status: "analyzing", summary: summary });

  try {
    // 1. Review qualité
    var review = await leadQA.reviewUS(ticket);
    log("[BACKLOG] " + key + " — Score : " + review.score + "/100 — Ready: " + review.isReadyForTest);

    if (review.isReadyForTest) {
      log("[BACKLOG] " + key + " — US déjà complète, pas d'enrichissement nécessaire");
      pushSSE({ type: "queue-item", key: key, issueType: "US", status: "ok", summary: summary,
        detail: "US déjà conforme (" + review.score + "/100)" });
      return;
    }

    // 2. Enrichir l'US avec le Lead QA
    log("[BACKLOG] " + key + " — Enrichissement en cours... (manque : " + (review.missingElements || []).join(", ") + ")");
    pushSSE({ type: "log", agent: "lead-qa", line: "[" + key + "] Enrichissement US — manque : " + (review.missingElements || []).join(", ") });

    var enriched = await leadQA.enrichUS(ticket);

    // Sauvegarder le fichier MD localement
    var filepath = leadQA.saveMarkdown(enriched.markdown, "US", key + "-enrichi");
    log("[BACKLOG] " + key + " — Fichier généré : " + filepath);

    // 3. Sauvegarder dans inbox/enriched/ pour revue dans le dashboard
    saveEnrichedUS(key, {
      key:               key,
      summary:           summary,
      epic:              enriched.epic,
      score:             review.score,
      issues:            review.issues || [],
      suggestions:       review.suggestions || [],
      originalMarkdown:  extractDesc(ticket.fields),
      enrichedMarkdown:  enriched.markdown,
      filepath:          filepath,
      status:            "pending",
      createdAt:         new Date().toISOString(),
      updatedAt:         new Date().toISOString()
    });
    log("[BACKLOG] " + key + " — Sauvegardé dans inbox/enriched/ — en attente de validation");

    // Pousser SSE vers le dashboard (badge + notification)
    pushSSE({
      type:      "enriched-ready",
      key:       key,
      summary:   summary,
      epic:      enriched.epic,
      score:     review.score,
      issues:    review.issues
    });

    // 4. Attendre validation via le dashboard (polling fichier)
    var validation = await requestValidation(
      "us-enrichment", key,
      "User Story - [" + enriched.epic + "] - " + summary,
      enriched.markdown,
      { filepath: filepath, score: review.score, issues: review.issues }
    );

    if (!validation.approved) {
      log("[BACKLOG] " + key + " — Enrichissement rejeté par l'utilisateur");
      pushSSE({ type: "queue-item", key: key, issueType: "US", status: "rejected", summary: summary });
      return;
    }

    // 5. Lire le markdown final (peut avoir été édité dans le dashboard)
    var finalData = getEnrichedUS(key);
    var finalMarkdown = (finalData && finalData.enrichedMarkdown) || enriched.markdown;

    // 6. Mettre à jour la description Jira avec le contenu final (potentiellement édité)
    await updateJiraDescription(key, finalMarkdown);

    // 5. Commenter sur le ticket
    await postComment(key,
      "[QA Auto]📋 US enrichie par Lead QA\n" +
      "Score initial : " + review.score + "/100\n" +
      "Éléments ajoutés : " + (review.missingElements || []).join(", ") + "\n" +
      "Fichier : " + path.basename(filepath) + "\n" +
      "🤖 QA Automation — Lead QA Claude"
    );

    statsToday.enriched++;
    saveState();
    pushSSE({ type: "queue-item", key: key, issueType: "US", status: "enriched", summary: summary,
      detail: "Score : " + review.score + "/100 → enrichi et mis à jour dans Jira" });

  } catch(e) {
    log("[!] Erreur workflowBacklog " + key + " : " + e.message);
    pushSSE({ type: "queue-item", key: key, issueType: "US", status: "error", summary: summary,
      detail: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW 2 : US TO DO — Pipeline complet
// Analyse → Stratégie → Génère tickets TEST + CSV → Exécute Playwright si auto
// ══════════════════════════════════════════════════════════════════════════════
async function workflowUS(ticket) {
  var key     = ticket.key;
  var fields  = ticket.fields;
  var summary = fields.summary || "";
  var desc    = extractDesc(fields);
  var version = (fields.fixVersions && fields.fixVersions[0])
                  ? fields.fixVersions[0].name
                  : CFG.xray.fixVersion;

  log("[US] " + key + " — " + summary);
  pushSSE({ type: "queue-item", key: key, issueType: "US", status: "running", summary: summary });

  try {
    // 1. Analyse complète par Lead QA
    log("[US] " + key + " — Analyse Lead QA...");
    var analysis = await leadQA.analyzeUS(ticket);
    log("[US] " + key + " — Complexité : " + analysis.complexity + " | Type : " + analysis.automationType + " | Priorité : " + analysis.priority);
    pushSSE({ type: "log", agent: "lead-qa", line: "[" + key + "] Type: " + analysis.automationType + " | Complexité: " + analysis.complexity });

    // 2. Décision de stratégie
    var strategy = await leadQA.decideStrategy(ticket);
    log("[US] " + key + " — Stratégie : " + strategy.decision + " (" + strategy.confidence + "%) — " + strategy.reasoning);
    pushSSE({ type: "log", agent: "lead-qa",
      line: "[" + key + "] Stratégie: " + strategy.decision + " (" + strategy.confidence + "%) — " + strategy.reasoning });

    // 3. Générer le ticket TEST
    log("[US] " + key + " — Génération ticket TEST...");
    var testResult = await leadQA.generateTestTicket(
      { key: key, epic: analysis.epic, summary: summary, description: desc },
      strategy.decision,
      summary
    );
    var testFilepath = leadQA.saveMarkdown(testResult.markdown, "TEST", key);

    // 4. Générer les cas de test CSV
    log("[US] " + key + " — Génération CSV cas de test...");
    var csvContent = await leadQA.generateTestCasesCSV(
      { key: key, summary: summary, description: desc, automationType: strategy.decision },
      analysis.testCount || 5
    );
    var csvFilepath = leadQA.saveCSV(csvContent, key + "-" + summary.substring(0, 30));

    // 5. Validation Gate — ticket TEST + CSV
    var valTest = await requestValidation(
      "test-ticket",
      key,
      testResult.title,
      testResult.markdown,
      { csvFilepath: csvFilepath, testFilepath: testFilepath, strategy: strategy }
    );

    if (!valTest.approved) {
      log("[US] " + key + " — Ticket TEST rejeté");
      pushSSE({ type: "queue-item", key: key, issueType: "US", status: "rejected", summary: summary });
      return;
    }

    // 6. Créer le ticket TEST dans Jira
    var jiraTestResult = await createJiraIssue({
      project:   { key: CFG.jira.project },
      summary:   testResult.title,
      issuetype: { name: "Test" },
      description: {
        type: "doc", version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: testResult.markdown }] }]
      },
      labels: ["qa-auto", "auto-generated"],
      priority: { name: analysis.priority === "Critique" ? "Highest" :
                         analysis.priority === "Haute"    ? "High"    :
                         analysis.priority === "Basse"    ? "Low"     : "Medium" }
    });
    var testKey = (jiraTestResult.data && jiraTestResult.data.key) ? jiraTestResult.data.key : "";
    if (testKey) log("[US] " + key + " — Ticket TEST créé : " + testKey);

    // Sauvegarder dans la file des tests → disponible dans Playwright Direct
    saveTestQueue(key + "-test", {
      key:       key + "-test",
      jiraKey:   testKey || null,
      sourceKey: key,
      title:     testResult.title,
      mode:      strategy.decision,
      strategy:  strategy.decision,
      description: summary + (desc ? "\n\n" + desc.substring(0, 400) : ""),
      steps:     [],
      status:    "pending",
      createdAt: new Date().toISOString()
    });
    pushSSE({ type: "test-queue-update", key: key });

    // 7. Si automatisable → lancer Playwright
    var pwResult = null;
    if (strategy.decision !== "manual") {
      log("[US] " + key + " — Lancement Playwright (" + strategy.decision + ")...");
      pushSSE({ type: "log", agent: "lead-qa", line: "[" + key + "] Lancement Playwright mode: " + strategy.playwrightMode });

      var pwArgs = [
        "--mode=" + (strategy.playwrightMode || "ui"),
        "--source=text",
        "--text=" + summary.replace(/ /g, "_").substring(0, 60),
        "--env=sophie"
      ];
      if (strategy.decision === "api")    pwArgs[0] = "--mode=api";
      if (strategy.decision === "css")    pwArgs[0] = "--mode=ui";
      if (strategy.decision === "drupal") pwArgs[0] = "--mode=ui";

      pwResult = await runPlaywright(pwArgs);
      log("[US] " + key + " — Playwright terminé — code: " + pwResult.code + " | FAIL: " + pwResult.hasFail);
    }

    // 8. Commenter sur l'US source
    var resultLine = pwResult
      ? (pwResult.hasFail ? "❌ Tests FAIL — bugs à investiguer" : "✅ Tests PASS")
      : "📋 Tests manuels à exécuter";

    await postComment(key,
      "[QA Auto]Pipeline QA terminé\n" +
      "Stratégie : " + strategy.decision + " (" + strategy.confidence + "% confiance)\n" +
      "Ticket TEST : " + (testKey ? testKey + " — " : "") + testResult.title + "\n" +
      "CSV cas de test : " + path.basename(csvFilepath) + "\n" +
      "Résultat Playwright : " + resultLine + "\n" +
      "Release : " + version + "\n" +
      "🤖 QA Automation — Lead QA Claude"
    );

    // 9. Transition statut
    await transitionIssue(key, "In Progress");

    statsToday.us++;
    saveState();
    pushSSE({
      type: "queue-item", key: key, issueType: "US",
      status: pwResult && pwResult.hasFail ? "fail" : "ok",
      summary: summary,
      detail: strategy.decision + " | " + (testKey || "TEST non créé") + " | " + resultLine
    });
    pushSSE({ type: "queue-tick", stats: statsToday, lastCheck: lastCheck });

  } catch(e) {
    log("[!] Erreur workflowUS " + key + " : " + e.message);
    pushSSE({ type: "queue-item", key: key, issueType: "US", status: "error", summary: summary,
      detail: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW 3 : BUG — Reproduction Playwright + Ticket BUG avec nomenclature
// ══════════════════════════════════════════════════════════════════════════════
async function workflowBug(ticket) {
  var key     = ticket.key;
  var fields  = ticket.fields;
  var summary = fields.summary || "";
  var desc    = extractDesc(fields);
  var urls    = extractUrls(desc + " " + summary);

  log("[BUG] " + key + " — " + summary);
  pushSSE({ type: "queue-item", key: key, issueType: "Bug", status: "running", summary: summary });

  try {
    // 1. Tenter la reproduction via Playwright
    log("[BUG] " + key + " — Tentative de reproduction Playwright...");
    var pwArgs = ["--mode=ui", "--source=text", "--env=sophie",
      "--text=" + summary.replace(/ /g, "_").substring(0, 60)];
    if (urls.length) pwArgs.push("--urls=" + urls[0]);

    var pwResult = await runPlaywright(pwArgs);
    var reproduced = pwResult.hasFail;

    log("[BUG] " + key + " — Reproduit : " + reproduced);

    // 2. Générer le ticket BUG via Lead QA
    log("[BUG] " + key + " — Génération ticket BUG...");

    // Chercher l'US liée (si le bug mentionne une US)
    var usMatch  = summary.match(/SAFWBST-\d+/);
    var usKey    = usMatch ? usMatch[0] : null;
    var usSummary = usKey ? null : null; // On n'a pas le titre ici, le leadQA utilisera l'epic

    var bugResult = await leadQA.generateBugTicket({
      sourceUS:  usKey,
      usSummary: usSummary,
      epic:      leadQA.extractEpic(ticket),
      page:      urls[0] || summary.split(" ").slice(0, 4).join(" "),
      fonction:  summary,
      description: desc,
      actual:    reproduced ? "Bug reproduit par Playwright (screenshot disponible)" : "Comportement signalé — non reproduit automatiquement",
      expected:  "Comportement correct sans erreur",
      severity:  (fields.priority && fields.priority.name) || "À évaluer",
      evidence:  reproduced ? "Screenshots Playwright dans /screenshots/" : "Vérification manuelle recommandée"
    });

    var bugFilepath = leadQA.saveMarkdown(bugResult.markdown, "BUG", key);

    // 3. Validation Gate
    var validation = await requestValidation(
      "bug-ticket",
      key,
      bugResult.title,
      bugResult.markdown,
      { filepath: bugFilepath, reproduced: reproduced, urls: urls }
    );

    if (!validation.approved) {
      log("[BUG] " + key + " — Ticket BUG rejeté");
      pushSSE({ type: "queue-item", key: key, issueType: "Bug", status: "rejected", summary: summary });
      return;
    }

    // 4. Créer le ticket BUG dans Jira (seulement si reproduit ou si l'utilisateur approuve quand même)
    var newBugKey = "";
    var jiraBugResult = await createJiraIssue({
      project:   { key: CFG.jira.project },
      summary:   bugResult.title,
      issuetype: { name: "Bug" },
      description: {
        type: "doc", version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: bugResult.markdown }] }]
      },
      labels:   ["qa-auto", "auto-generated"],
      priority: { name: reproduced ? "High" : "Medium" }
    });
    newBugKey = (jiraBugResult.data && jiraBugResult.data.key) ? jiraBugResult.data.key : "";

    // Sauvegarder un test de vérification du fix → disponible dans Playwright Direct
    saveTestQueue(key + "-fix", {
      key:       key + "-fix",
      jiraKey:   newBugKey || null,
      sourceKey: key,
      title:     "TEST - " + summary.substring(0, 60) + " - Vérification fix",
      mode:      "fix",
      strategy:  "fix",
      description: "Vérifier que le bug suivant est corrigé :\n" + summary + (desc ? "\n\n" + desc.substring(0, 300) : ""),
      steps:     urls.length > 0 ? [{ label: "Vérifier la page corrigée", action: "expect-visible", selector: "body", expected: "" }] : [],
      status:    "pending",
      createdAt: new Date().toISOString()
    });
    pushSSE({ type: "test-queue-update", key: key });

    // 5. Lier le bug au ticket source
    if (newBugKey && usKey) {
      await jiraApiAsync("POST", "/rest/api/3/issueLink", {
        type:         { name: "Blocks" },
        inwardIssue:  { key: newBugKey },
        outwardIssue: { key: key }
      });
    }

    // 6. Commenter sur le ticket source
    await postComment(key,
      "[QA Auto]" + (reproduced ? "❌ Bug REPRODUIT" : "⚠️ Bug non reproduit automatiquement") + "\n" +
      "Ticket BUG créé : " + (newBugKey || "N/A") + " — " + bugResult.title + "\n" +
      (reproduced ? "Screenshots disponibles dans /screenshots/\n" : "Vérification manuelle recommandée\n") +
      "🤖 QA Automation — Lead QA Claude"
    );

    // 7. Transition
    await transitionIssue(key, "In Review");

    statsToday.bug++;
    saveState();
    pushSSE({
      type: "queue-item", key: key, issueType: "Bug",
      status: reproduced ? "fail" : "ok",
      summary: summary,
      detail: (reproduced ? "Reproduit — " : "Non reproduit — ") + (newBugKey || "")
    });
    pushSSE({ type: "queue-tick", stats: statsToday, lastCheck: lastCheck });

  } catch(e) {
    log("[!] Erreur workflowBug " + key + " : " + e.message);
    pushSSE({ type: "queue-item", key: key, issueType: "Bug", status: "error", summary: summary,
      detail: e.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// WORKFLOW 4 : TEST — Exécution directe Playwright + Rapport
// ══════════════════════════════════════════════════════════════════════════════
async function workflowTest(ticket) {
  var key     = ticket.key;
  var fields  = ticket.fields;
  var summary = fields.summary || "";
  var version = (fields.fixVersions && fields.fixVersions[0])
                  ? fields.fixVersions[0].name : CFG.xray.fixVersion;

  log("[TEST] " + key + " — " + summary);
  pushSSE({ type: "queue-item", key: key, issueType: "Test", status: "running", summary: summary });

  try {
    // 1. Décider le type d'exécution
    var strategy = await leadQA.decideStrategy(ticket);
    log("[TEST] " + key + " — Mode : " + strategy.decision);

    // 2. Lancer Playwright
    var pwArgs = [
      "--mode=" + (strategy.playwrightMode || "ui"),
      "--source=text",
      "--text=" + summary.replace(/ /g, "_").substring(0, 60),
      "--env=sophie"
    ];

    var pwResult = await runPlaywright(pwArgs);
    var hasFail  = pwResult.hasFail;
    var dateStr  = new Date().toLocaleDateString("fr-FR");

    log("[TEST] " + key + " — Résultat : " + (hasFail ? "FAIL" : "PASS"));

    // 3. Générer rapport
    var reportContent = await leadQA.generateReport({
      version: version,
      sprint: dateStr,
      tickets: [{ key: key, type: "Test", status: hasFail ? "FAIL" : "PASS",
        testCount: 1, bugs: hasFail ? 1 : 0 }]
    });
    leadQA.saveMarkdown(reportContent, "RAPPORT", key + "-" + dateStr.replace(/\//g, "-"));

    // 4. Si fail → générer ticket BUG automatiquement
    var bugKey = "";
    if (hasFail) {
      var bugResult = await leadQA.generateBugTicket({
        sourceUS:    key,
        usSummary:   summary,
        page:        summary.split(" ").slice(0, 4).join(" "),
        fonction:    summary,
        description: "Échec lors de l'exécution du ticket Test " + key,
        actual:      "Test FAIL — voir rapport Playwright",
        expected:    "Test PASS",
        severity:    "Majeure",
        evidence:    "Screenshots et rapport dans /screenshots/ et /reports/"
      });
      leadQA.saveMarkdown(bugResult.markdown, "BUG", key + "-fail");

      var valBug = await requestValidation("bug-ticket", key, bugResult.title, bugResult.markdown);
      if (valBug.approved) {
        var jiraBug = await createJiraIssue({
          project:   { key: CFG.jira.project },
          summary:   bugResult.title,
          issuetype: { name: "Bug" },
          labels:    ["qa-auto", "auto-generated"],
          priority:  { name: "High" }
        });
        bugKey = (jiraBug.data && jiraBug.data.key) ? jiraBug.data.key : "";
      }
    }

    // 5. Créer Test Execution Xray
    var execResult = await createJiraIssue({
      project:   { key: CFG.jira.project },
      summary:   "Test Execution - " + version + " - " + key + " - " + dateStr,
      issuetype: { name: "Test Execution" },
      labels:    ["qa-auto", "auto-generated"]
    });
    var execKey = (execResult.data && execResult.data.key) ? execResult.data.key : "";

    // 6. Commenter
    await postComment(key,
      "[QA Auto]Exécution terminée\n" +
      "Résultat : " + (hasFail ? "❌ FAIL" : "✅ PASS") + "\n" +
      "Test Execution : " + (execKey || "N/A") + "\n" +
      (bugKey ? "BUG créé : " + bugKey + "\n" : "") +
      "Mode : " + strategy.decision + "\n" +
      "🤖 QA Automation — Lead QA Claude"
    );

    await transitionIssue(key, hasFail ? "In Progress" : "Done");

    statsToday.test++;
    saveState();
    pushSSE({
      type: "queue-item", key: key, issueType: "Test",
      status: hasFail ? "fail" : "ok",
      summary: summary,
      detail: (hasFail ? "FAIL" : "PASS") + (execKey ? " | Exec: " + execKey : "") + (bugKey ? " | Bug: " + bugKey : "")
    });
    pushSSE({ type: "queue-tick", stats: statsToday, lastCheck: lastCheck });

  } catch(e) {
    log("[!] Erreur workflowTest " + key + " : " + e.message);
    pushSSE({ type: "queue-item", key: key, issueType: "Test", status: "error", summary: summary,
      detail: e.message });
  }
}

// ── POLLING PRINCIPAL — Tickets "To Do" ──────────────────────────────────────
function poll() {
  lastCheck = new Date().toISOString();
  log("[→] Polling Jira (To Do) — " + new Date().toLocaleTimeString("fr-FR"));
  pushSSE({ type: "queue-tick", stats: statsToday, lastCheck: lastCheck });

  var jql = "project = " + CFG.jira.project +
    " AND assignee = currentUser()" +
    " AND status in (\"To Test\",\"In Test\",\"To Test UAT\",\"In validation\",\"Reopened\")" +
    " AND issuetype in (\"Story\",\"Bug\",\"Test\")" +
    " ORDER BY created ASC";

  var search = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
    "&fields=summary,description,issuetype,labels,priority,fixVersions,customfield_10014&maxResults=10";

  jiraApi("GET", search, null, function(err, data) {
    if (err) { log("[!] Erreur Jira : " + err.message); return; }
    if (data && data.errorMessages) { log("[!] Jira : " + data.errorMessages.join(", ")); return; }

    var issues = (data && data.issues) || [];
    log("[OK] " + issues.length + " ticket(s) To Do");

    issues.forEach(function(ticket) {
      if (processed.has(ticket.key)) return;
      processed.add(ticket.key);
      saveState();

      var typeName = ticket.fields.issuetype.name;
      log("[->] " + ticket.key + " (" + typeName + ") — " + ticket.fields.summary);

      switch(typeName) {
        case "Story": workflowUS(ticket);   break;
        case "Bug":   workflowBug(ticket);  break;
        case "Test":  workflowTest(ticket); break;
        default: log("[~] Type '" + typeName + "' ignoré");
      }
    });
  });
}

// ── POLLING BACKLOG — US à enrichir ──────────────────────────────────────────
function pollBacklog() {
  log("[→] Polling Jira (Backlog US) — " + new Date().toLocaleTimeString("fr-FR"));

  var jql = "project = " + CFG.jira.project +
    " AND assignee = currentUser()" +
    " AND status = \"Backlog\"" +
    " AND issuetype = \"Story\"" +
    " ORDER BY created ASC";

  var search = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
    "&fields=summary,description,labels,customfield_10014&maxResults=5";

  jiraApi("GET", search, null, function(err, data) {
    if (err || !data || data.errorMessages) return;

    var issues = (data && data.issues) || [];
    log("[BACKLOG] " + issues.length + " US en backlog à analyser");

    // Traiter 1 US à la fois pour ne pas surcharger le LLM
    var enrichKey = "backlog-" + new Date().toDateString();
    issues.some(function(ticket) {
      var bkey = "b-" + ticket.key;
      if (!processed.has(bkey)) {
        processed.add(bkey);
        saveState();
        workflowBacklog(ticket);
        return true; // une seule par cycle
      }
      return false;
    });
  });
}

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
// start() peut être appelé depuis agent-server.js ou en standalone
var _pollInterval = null;
var _backlogInterval = null;

function start() {
  console.log("[jira-queue] Démarrage — polling To Do " + (POLL_MS / 1000) + "s, Backlog " + (POLL_BACKLOG_MS / 1000) + "s");
  // Premier poll après 3s (laisser le serveur finir de démarrer)
  setTimeout(function() { poll(); pollBacklog(); }, 3000);
  // Intervalles récurrents
  if (_pollInterval) clearInterval(_pollInterval);
  if (_backlogInterval) clearInterval(_backlogInterval);
  _pollInterval    = setInterval(poll,        POLL_MS);
  _backlogInterval = setInterval(pollBacklog, POLL_BACKLOG_MS);
}

function stop() {
  if (_pollInterval)    { clearInterval(_pollInterval);    _pollInterval = null; }
  if (_backlogInterval) { clearInterval(_backlogInterval); _backlogInterval = null; }
  console.log("[jira-queue] Arrêté");
}

// Standalone : node agent-jira-queue.js
if (require.main === module) {
  console.log("══════════════════════════════════════════════════");
  console.log("  QA Automation — Surveillance Jira");
  console.log("══════════════════════════════════════════════════");
  console.log("  Projet  : " + CFG.jira.project);
  console.log("  Compte  : " + CFG.jira.email);
  console.log("  Polling To Do    : " + (POLL_MS / 1000) + "s");
  console.log("  Polling Backlog  : " + (POLL_BACKLOG_MS / 1000) + "s");
  console.log("  Validation gate  : " + (VALIDATION_TIMEOUT_MS / 60000) + "min (auto-approve)");
  console.log("  LLM              : Claude API (Anthropic)");
  console.log("══════════════════════════════════════════════════\n");
  start();
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
module.exports = { start, stop, poll, pollBacklog, requestValidation };
