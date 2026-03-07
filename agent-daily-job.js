// agent-daily-job.js — Job journalier QA (6h00)
// Remplace le polling continu de agent-jira-queue.js
// Activé par DAILY_JOB_MODE=true dans .env
"use strict";

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const CFG    = require("./config");
const leadQA = require("./agent-lead-qa");

// ── CONFIG ───────────────────────────────────────────────────────────────────
var DAILY_HOUR = "06:00";
var REPORT_DIR = path.join(__dirname, "inbox", "daily-reports");
var REPORT_FILE = path.join(REPORT_DIR, "last-report.json");
var _cronTimer = null;
var _lastRunDate = null;
var _sendSSE = null;
var _running = false;
var _lastReport = null;

// ── JIRA API ─────────────────────────────────────────────────────────────────
function jiraApi(method, apiPath, body) {
  return new Promise(function(resolve, reject) {
    var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var payload = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: CFG.jira.host, path: apiPath, method: method,
      headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json", "Accept": "application/json" }
    };
    if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);
    var req = https.request(opts, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve({ data: JSON.parse(data), status: res.statusCode }); }
        catch(e) { resolve({ data: data, status: res.statusCode }); }
      });
    });
    req.on("error", function(e) { reject(e); });
    req.setTimeout(30000, function() { req.destroy(); reject(new Error("Timeout Jira")); });
    if (payload) req.write(payload);
    req.end();
  });
}

function postComment(key, text) {
  return jiraApi("POST", "/rest/api/3/issue/" + key + "/comment", {
    body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: text }] }] }
  });
}

function transitionIssue(key, targetName) {
  return jiraApi("GET", "/rest/api/3/issue/" + key + "/transitions", null).then(function(r) {
    var transitions = (r.data && r.data.transitions) || [];
    var t = transitions.find(function(tr) { return tr.name === targetName; });
    if (t) return jiraApi("POST", "/rest/api/3/issue/" + key + "/transitions", { transition: { id: t.id } });
  });
}

function createJiraIssue(fields) {
  return jiraApi("POST", "/rest/api/3/issue", { fields: fields });
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg) {
  var ts = new Date().toLocaleTimeString("fr-FR");
  console.log("[daily-job] [" + ts + "] " + msg);
}

function sse(data) {
  if (_sendSSE) _sendSSE("default", data);
}

function extractDesc(fields) {
  if (!fields.description) return "";
  if (typeof fields.description === "string") return fields.description;
  if (fields.description.content) {
    return fields.description.content.map(function(block) {
      return (block.content || []).map(function(c) { return c.text || ""; }).join("");
    }).join("\n");
  }
  return "";
}

function extractUrls(text) {
  if (!text) return [];
  var jiraLinks = [];
  text.replace(/\[([^\]]*)\|([^\]]+)\]/g, function(_, _t, u) { jiraLinks.push(u.trim()); });
  var rawUrls = (text.match(/https?:\/\/[^\s<"'\])+]+/g) || []);
  var all = jiraLinks.concat(rawUrls);
  return all.filter(function(u) {
    try { var p = new URL(u); return p.hostname.includes("safran"); } catch(e) { return false; }
  });
}

// ── FETCH TICKETS QA (Story + Bug dans les colonnes QA du workflow SAF-v3) ──
var QA_STATUSES = ["To Test", "In Test", "Reopened", "To Test UAT", "In validation"];

async function fetchQATickets() {
  var statusClause = QA_STATUSES.map(function(s) { return '"' + s + '"'; }).join(", ");
  var jql = "project = " + CFG.jira.project +
    " AND assignee = currentUser()" +
    " AND status in (" + statusClause + ")" +
    " AND issuetype in (Story, Bug)" +
    " ORDER BY priority DESC";
  var searchPath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
    "&fields=summary,description,status,issuetype,priority,fixVersions,labels,issuelinks,subtasks,customfield_10014" +
    "&maxResults=50";
  log("JQL: " + jql);
  var r = await jiraApi("GET", searchPath, null);
  return (r.data && r.data.issues) || [];
}

// ── ROUTAGE AUTOMATIQUE PAR TYPE ─────────────────────────────────────────────
async function routeTicket(ticket, report) {
  var type = ticket.fields.issuetype.name;
  var key = ticket.key;
  var status = (ticket.fields.status && ticket.fields.status.name) || "";

  log("[ROUTE] " + key + " — " + type + " [" + status + "]");
  sse({ type: "daily-job-progress", step: "route", key: key, message: "Routage " + key + " (" + type + ")" });

  if (type === "Story") {
    await pipelineUS(ticket, report);
  } else if (type === "Bug") {
    await pipelineBug(ticket, report);
  } else {
    log("[ROUTE] " + key + " — Type " + type + " ignore");
  }
}

// ── PIPELINE USER STORY ─────────────────────────────────────────────────────
async function pipelineUS(ticket, report) {
  var key = ticket.key;
  var fields = ticket.fields;
  var summary = fields.summary || "";
  var desc = extractDesc(fields);
  var jiraStatus = (fields.status && fields.status.name) || "";

  log("[US] " + key + " — Pipeline US — " + summary + " [" + jiraStatus + "]");
  sse({ type: "daily-job-progress", step: "us", key: key, summary: summary, message: "US " + key + " — " + summary });

  try {
    // Etape 1 : Analyse + Revue
    var result = await leadQA.analyzeAndReviewUS(ticket);
    var review = result.review || {};
    var analysis = result.analysis || {};
    var strategy = result.strategy || {};
    var score = review.score || 0;
    var isComplete = score >= 70 && (!review.missingElements || review.missingElements.length === 0);

    // Etape 2 : Enrichissement si necessaire
    var phase = "pret";
    if (!isComplete) {
      phase = "enrichissement";
      log("[US] " + key + " — Score " + score + "/100 → enrichissement");
      var enriched = await leadQA.enrichUS(ticket);
      leadQA.saveMarkdown(enriched.markdown, "US", key + "-enrichi");
      report.usEnrichies++;
    }

    // Etape 3 : Verifier ticket TEST lie
    var linkedTest = (fields.issuelinks || []).find(function(l) {
      var linked = l.outwardIssue || l.inwardIssue;
      return linked && linked.fields && linked.fields.issuetype &&
        (linked.fields.issuetype.name === "Test" || linked.fields.issuetype.name === "Test Case");
    });

    // Etape 4 : Generer TEST + CSV si pas de TEST lie
    var generatedFiles = [];
    if (!linkedTest) {
      log("[US] " + key + " — Generation TEST + CSV...");
      var testAndCSV = await leadQA.generateTestAndCSV(
        { key: key, epic: result.epic || "", summary: summary, description: desc },
        strategy.decision || "e2e", summary, analysis.testCount || 5
      );
      leadQA.saveMarkdown(testAndCSV.markdown, "TEST", key);
      generatedFiles.push("TEST-" + key + ".md");
      report.testsCascade++;
      if (testAndCSV.csv) {
        leadQA.saveCSV(testAndCSV.csv, key + "-cas-test");
        generatedFiles.push(key + "-cas-test.csv");
        report.casTestImportesXray++;
        report.csvReady = report.csvReady || [];
        report.csvReady.push({ key: key, csv: testAndCSV.csv });
      }
      phase = "test-genere";
    } else {
      phase = "pret-a-tester";
    }

    report.ticketsTraites++;
    report.usTraitees++;
    report.details.push({
      key: key, type: "US", summary: summary, status: "OK",
      jiraStatus: jiraStatus, score: score,
      phase: phase,
      enriched: !isComplete, testGenerated: !linkedTest,
      jiraUrl: "https://" + CFG.jira.host + "/browse/" + key,
      treatedAt: new Date().toISOString(),
      files: generatedFiles,
      localOnly: true
    });

    log("[US] " + key + " — Phase finale : " + phase);

  } catch(e) {
    log("[US] " + key + " — ERREUR : " + e.message);
    report.erreurs.push({ key: key, type: "US", error: e.message });
    report.details.push({ key: key, type: "US", summary: summary, status: "ERROR", error: e.message });
  }
}

// ── PIPELINE BUG ────────────────────────────────────────────────────────────
async function pipelineBug(ticket, report) {
  var key = ticket.key;
  var fields = ticket.fields;
  var summary = fields.summary || "";
  var desc = extractDesc(fields);
  var jiraStatus = (fields.status && fields.status.name) || "";

  log("[BUG] " + key + " — Pipeline Bug — " + summary + " [" + jiraStatus + "]");
  sse({ type: "daily-job-progress", step: "bug", key: key, summary: summary, message: "Bug " + key + " — " + summary });

  try {
    // Etape 1 : Verifier ticket TEST de non-regression
    var linkedTest = (fields.issuelinks || []).find(function(l) {
      var linked = l.outwardIssue || l.inwardIssue;
      return linked && linked.fields && linked.fields.issuetype &&
        (linked.fields.issuetype.name === "Test" || linked.fields.issuetype.name === "Test Case");
    });

    var phase = "pret-a-tester";
    var generatedFiles = [];

    // Etape 2 : Generer TEST si pas lie
    if (!linkedTest) {
      log("[BUG] " + key + " — Generation test non-regression...");
      var testResult = await leadQA.generateTestTicket(
        { key: key, epic: "", summary: summary, description: desc },
        "e2e", "Non-regression - " + summary
      );
      leadQA.saveMarkdown(testResult.markdown, "TEST", key + "-nonreg");
      generatedFiles.push("TEST-" + key + "-nonreg.md");
      report.testsCascade++;
      phase = "test-genere";
    }

    report.ticketsTraites++;
    report.bugsTraites++;
    report.details.push({
      key: key, type: "Bug", summary: summary, status: "OK",
      jiraStatus: jiraStatus, phase: phase,
      testGenerated: !linkedTest,
      jiraUrl: "https://" + CFG.jira.host + "/browse/" + key,
      treatedAt: new Date().toISOString(),
      files: generatedFiles,
      localOnly: true
    });

    log("[BUG] " + key + " — Phase finale : " + phase);

  } catch(e) {
    log("[BUG] " + key + " — ERREUR : " + e.message);
    report.erreurs.push({ key: key, type: "Bug", error: e.message });
    report.details.push({ key: key, type: "Bug", summary: summary, status: "ERROR", error: e.message });
  }
}

// ── DAILY JOB PRINCIPAL ─────────────────────────────────────────────────────
async function runDailyQAJob() {
  if (_running) {
    log("Job deja en cours — skip");
    return { ok: false, reason: "already-running" };
  }
  _running = true;
  var startTime = Date.now();

  log("========================================");
  log("  CHECK JOURNALIER QA — DEMARRAGE");
  log("========================================");
  sse({ type: "daily-job-started", at: new Date().toISOString(), message: "Demarrage du check journalier…" });

  var report = {
    date: new Date().toISOString(),
    ticketsTraites: 0,
    usTraitees: 0,
    bugsTraites: 0,
    usEnrichies: 0,
    testsCascade: 0,
    casTestImportesXray: 0,
    details: [],
    erreurs: [],
    dureeMs: 0
  };

  try {
    // 1. Recuperer les tickets
    log("Recuperation des tickets QA...");
    var tickets = [];
    try {
      tickets = await fetchQATickets();
    } catch(fetchErr) {
      log("ERREUR fetch Jira : " + fetchErr.message);
      report.erreurs.push({ key: "fetch", type: "system", error: fetchErr.message });
    }
    log(tickets.length + " ticket(s) a traiter");
    sse({ type: "daily-job-progress", step: "fetch", count: tickets.length, message: tickets.length + " ticket(s) trouves" });

    if (tickets.length === 0) {
      log("Aucun ticket a traiter — fin du job");
      sse({ type: "daily-job-progress", step: "done", message: "Aucun ticket a traiter" });
      report.dureeMs = Date.now() - startTime;
      try { saveReport(report); } catch(se) { log("ERREUR saveReport : " + se.message); }
      _lastReport = report;
      sse({ type: "daily-job-completed", report: report });
      _running = false;
      return report;
    }

    // 2. Router chaque ticket selon son type
    log("Routage de " + tickets.length + " ticket(s)...");
    sse({ type: "daily-job-progress", step: "route", message: tickets.length + " ticket(s) a router" });

    for (var i = 0; i < tickets.length; i++) {
      await routeTicket(tickets[i], report);
    }

  } catch(e) {
    log("ERREUR GLOBALE : " + e.message);
    report.erreurs.push({ key: "global", type: "system", error: e.message });
  }

  report.dureeMs = Date.now() - startTime;
  try { saveReport(report); } catch(saveErr) { log("ERREUR saveReport : " + saveErr.message); }

  report.jqlUsed = "project=" + CFG.jira.project + " status in (" + QA_STATUSES.join(", ") + ")";
  report.statuts = {};
  report.details.forEach(function(d) {
    var s = d.jiraStatus || "unknown";
    report.statuts[s] = (report.statuts[s] || 0) + 1;
  });

  log("========================================");
  log("  RAPPORT : " + report.ticketsTraites + " traites (" +
    report.usTraitees + " US, " + report.bugsTraites + " Bug) | " +
    report.testsCascade + " tests cascade | " +
    report.casTestImportesXray + " CSV Xray | " +
    report.erreurs.length + " erreurs");
  log("  Statuts : " + JSON.stringify(report.statuts));
  log("  Duree : " + Math.round(report.dureeMs / 1000) + "s");
  log("========================================");

  _lastReport = report;
  sse({ type: "daily-job-completed", report: report });
  _running = false;
  return report;
}

// Wrapper avec timeout + finally pour garantir _running = false
var _origRunDailyQAJob = runDailyQAJob;
runDailyQAJob = async function() {
  var timeout = setTimeout(function() {
    log("TIMEOUT — job force a s'arreter apres 5 min");
    _running = false;
  }, 5 * 60 * 1000);
  try {
    return await _origRunDailyQAJob();
  } catch(e) {
    log("CRASH runDailyQAJob : " + e.message + "\n" + (e.stack || ""));
    _running = false;
    var crashReport = { date: new Date().toISOString(), ticketsTraites: 0, usTraitees:0, bugsTraites:0, usEnrichies:0, testsCascade:0, casTestImportesXray:0, erreurs: [{ key:"crash", type:"system", error: e.message }], details:[], dureeMs: 0 };
    _lastReport = crashReport;
    try { saveReport(crashReport); } catch(se) {}
    sse({ type: "daily-job-completed", report: crashReport });
    return crashReport;
  } finally {
    clearTimeout(timeout);
  }
};

// ── PERSISTENCE RAPPORT ─────────────────────────────────────────────────────
function saveReport(report) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
  // Historique
  var histFile = path.join(REPORT_DIR, "history.jsonl");
  fs.appendFileSync(histFile, JSON.stringify(report) + "\n", "utf8");
}

function getLastReport() {
  try { return JSON.parse(fs.readFileSync(REPORT_FILE, "utf8")); }
  catch(e) { return _lastReport; }
}

// ── CRON (setInterval maison comme agent-cycle.js) ──────────────────────────
function startCron(sendSSEFn) {
  _sendSSE = sendSSEFn;
  if (_cronTimer) clearInterval(_cronTimer);
  _cronTimer = setInterval(_cronTick, 60 * 1000);
  console.log("[daily-job] Cron demarre — declenchement a " + DAILY_HOUR);
}

function stopCron() {
  if (_cronTimer) { clearInterval(_cronTimer); _cronTimer = null; }
}

function _cronTick() {
  var now = new Date();
  var hhmm = now.getHours().toString().padStart(2, "0") + ":" + now.getMinutes().toString().padStart(2, "0");
  var today = now.toISOString().slice(0, 10);
  if (hhmm === DAILY_HOUR && _lastRunDate !== today) {
    _lastRunDate = today;
    runDailyQAJob();
  }
}

function isRunning() { return _running; }
function setSendSSE(fn) { _sendSSE = fn; }

// ── STANDALONE ──────────────────────────────────────────────────────────────
if (require.main === module) {
  console.log("Lancement manuel du daily job...");
  runDailyQAJob().then(function(r) {
    console.log("Termine —", r.ticketsTraites, "tickets traites");
    process.exit(0);
  }).catch(function(e) {
    console.error("Erreur:", e.message);
    process.exit(1);
  });
}

module.exports = { startCron, stopCron, runDailyQAJob, getLastReport, isRunning, setSendSSE };
