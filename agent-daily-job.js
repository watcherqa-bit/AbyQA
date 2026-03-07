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

// ── FETCH TICKETS IN QA ─────────────────────────────────────────────────────
async function fetchTicketsInQA() {
  var jql = "project = " + CFG.jira.project +
    " AND assignee = currentUser()" +
    " AND status in (\"To Test\",\"In Test\",\"To Test UAT\",\"In validation\",\"Reopened\")" +
    " ORDER BY priority DESC";
  var searchPath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
    "&fields=summary,description,status,issuetype,priority,fixVersions,labels,issuelinks,subtasks,customfield_10014" +
    "&maxResults=50";
  var r = await jiraApi("GET", searchPath, null);
  return (r.data && r.data.issues) || [];
}

// ── PROCESS USER STORY (analyse locale uniquement) ──────────────────────────
async function processUS(ticket, report) {
  var key = ticket.key;
  var fields = ticket.fields;
  var summary = fields.summary || "";
  var desc = extractDesc(fields);
  var jiraStatus = (fields.status && fields.status.name) || "";

  log("[US] " + key + " — " + summary + " [" + jiraStatus + "]");
  sse({ type: "daily-job-progress", step: "us", key: key, summary: summary, message: "US " + key + " — " + summary });

  try {
    // Analyser la completude (lecture seule)
    var review = await leadQA.reviewUS(ticket);
    var isComplete = review.score >= 70 && (!review.missingElements || review.missingElements.length === 0);

    // Preparer l'enrichissement LOCAL (sans toucher Jira)
    var enrichedMarkdown = null;
    if (!isComplete) {
      log("[US] " + key + " — Score " + review.score + "/100, preparation enrichissement...");
      var enriched = await leadQA.enrichUS(ticket);
      enrichedMarkdown = enriched.markdown;
      leadQA.saveMarkdown(enriched.markdown, "US", key + "-enrichi");
      report.usEnrichies++;
      log("[US] " + key + " — Enrichissement prepare localement (inbox/enriched/)");
    }

    // Verifier si ticket TEST lie existe
    var linkedTest = (fields.issuelinks || []).find(function(l) {
      var linked = l.outwardIssue || l.inwardIssue;
      return linked && linked.fields && linked.fields.issuetype &&
        (linked.fields.issuetype.name === "Test" || linked.fields.issuetype.name === "Test Case");
    });

    var localTestFile = null;
    if (!linkedTest) {
      // Generer ticket TEST localement (sans creer dans Jira)
      log("[US] " + key + " — Generation ticket TEST local...");
      var analysis = await leadQA.analyzeUS(ticket);
      var strategy = await leadQA.decideStrategy(ticket);
      var testResult = await leadQA.generateTestTicket(
        { key: key, epic: analysis.epic, summary: summary, description: desc },
        strategy.decision, summary
      );
      localTestFile = leadQA.saveMarkdown(testResult.markdown, "TEST", key);
      report.testsGeneres++;

      // Generer CSV cas de test localement
      var csvContent = await leadQA.generateTestCasesCSV(
        { key: key, summary: summary, description: desc, automationType: strategy.decision },
        analysis.testCount || 5
      );
      leadQA.saveCSV(csvContent, key + "-cas-test");
      report.casTestImportesXray++;
      log("[US] " + key + " — TEST + CSV prepares localement");
    } else {
      log("[US] " + key + " — Ticket TEST deja lie");
    }

    report.ticketsTraites++;
    report.details.push({ key: key, type: "US", summary: summary, status: "OK",
      jiraStatus: jiraStatus, score: review.score,
      enriched: !isComplete, testGenerated: !linkedTest,
      localOnly: true });
  } catch(e) {
    log("[US] " + key + " — ERREUR : " + e.message);
    report.erreurs.push({ key: key, type: "US", error: e.message });
    report.details.push({ key: key, type: "US", summary: summary, status: "ERROR", error: e.message });
  }
}

// ── PROCESS BUG (analyse locale uniquement) ─────────────────────────────────
async function processBug(ticket, report) {
  var key = ticket.key;
  var fields = ticket.fields;
  var summary = fields.summary || "";
  var desc = extractDesc(fields);
  var urls = extractUrls(desc + " " + summary);
  var jiraStatus = (fields.status && fields.status.name) || "";

  log("[BUG] " + key + " — " + summary + " [" + jiraStatus + "]");
  sse({ type: "daily-job-progress", step: "bug", key: key, summary: summary, message: "Bug " + key + " — " + summary });

  try {
    // Verifier si ticket TEST de non-regression existe
    var linkedTest = (fields.issuelinks || []).find(function(l) {
      var linked = l.outwardIssue || l.inwardIssue;
      return linked && linked.fields && linked.fields.issuetype &&
        (linked.fields.issuetype.name === "Test" || linked.fields.issuetype.name === "Test Case");
    });

    if (!linkedTest) {
      // Preparer localement un test de non-regression (sans creer dans Jira)
      log("[BUG] " + key + " — Preparation test non-regression local...");
      var testResult = await leadQA.generateTestTicket(
        { key: key, epic: "", summary: "TEST - " + summary, description: desc },
        "e2e", summary
      );
      leadQA.saveMarkdown(testResult.markdown, "TEST", key + "-nonreg");
      report.testsGeneres++;
      log("[BUG] " + key + " — TEST non-regression prepare localement");
    }

    report.ticketsTraites++;
    report.details.push({ key: key, type: "Bug", summary: summary, status: "OK",
      jiraStatus: jiraStatus, testGenerated: !linkedTest,
      localOnly: true });
  } catch(e) {
    log("[BUG] " + key + " — ERREUR : " + e.message);
    report.erreurs.push({ key: key, type: "Bug", error: e.message });
    report.details.push({ key: key, type: "Bug", summary: summary, status: "ERROR", error: e.message });
  }
}

// ── PROCESS TEST (analyse + execution Playwright, resultats locaux) ─────────
async function processTest(ticket, report) {
  var key = ticket.key;
  var fields = ticket.fields;
  var summary = fields.summary || "";
  var jiraStatus = (fields.status && fields.status.name) || "";

  log("[TEST] " + key + " — " + summary + " [" + jiraStatus + "]");
  sse({ type: "daily-job-progress", step: "test", key: key, summary: summary, message: "Test " + key + " — " + summary });

  try {
    // Determiner la strategie de test
    var strategy = await leadQA.decideStrategy(ticket);
    log("[TEST] " + key + " — Mode : " + strategy.decision);

    // Lancer Playwright (execution locale, rapport local)
    var { spawn } = require("child_process");
    var pwResult = await new Promise(function(resolve) {
      var args = ["agent-playwright-direct.js",
        "--mode=" + (strategy.playwrightMode || "ui"),
        "--source=text",
        "--text=" + summary.replace(/ /g, "_").substring(0, 60),
        "--env=sophie"];
      var proc = spawn("node", args, { cwd: __dirname });
      var stdout = "";
      proc.stdout.on("data", function(d) { stdout += d.toString(); });
      proc.stderr.on("data", function(d) { stdout += d.toString(); });
      proc.on("close", function(code) {
        var hasFail = /FAIL/i.test(stdout) || code !== 0;
        var resultMatch = stdout.match(/PLAYWRIGHT_DIRECT_RESULT:(.+)/);
        var result = null;
        if (resultMatch) try { result = JSON.parse(resultMatch[1]); } catch(e) {}
        resolve({ code: code, hasFail: hasFail, result: result, stdout: stdout });
      });
    });

    report.testsExecutes++;
    if (pwResult.hasFail) {
      report.fail++;
      log("[TEST] " + key + " — FAIL (rapport local)");

      // Preparer un ticket BUG localement (sans creer dans Jira)
      var bugResult = await leadQA.generateBugTicket({
        sourceUS: key, usSummary: summary,
        page: summary, fonction: summary,
        description: "Echec test " + key,
        actual: "Test FAIL", expected: "Test PASS",
        severity: "Majeure", evidence: "Rapport Playwright"
      });
      leadQA.saveMarkdown(bugResult.markdown, "BUG", key + "-fail");
      report.bugsCreees++;
      log("[TEST] " + key + " — Bug prepare localement (a valider)");
    } else {
      report.pass++;
      log("[TEST] " + key + " — PASS");
    }

    report.ticketsTraites++;
    report.details.push({ key: key, type: "Test", summary: summary,
      jiraStatus: jiraStatus,
      status: pwResult.hasFail ? "FAIL" : "PASS",
      bugPrepared: pwResult.hasFail, mode: strategy.decision,
      localOnly: true });
  } catch(e) {
    log("[TEST] " + key + " — ERREUR : " + e.message);
    report.erreurs.push({ key: key, type: "Test", error: e.message });
    report.details.push({ key: key, type: "Test", summary: summary, status: "ERROR", error: e.message });
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
    usEnrichies: 0,
    testsGeneres: 0,
    casTestImportesXray: 0,
    testsExecutes: 0,
    details: [],
    pass: 0,
    fail: 0,
    bugsCreees: 0,
    erreurs: [],
    dureeMs: 0
  };

  try {
    // 1. Recuperer les tickets
    log("Recuperation des tickets In QA...");
    var tickets = [];
    try {
      tickets = await fetchTicketsInQA();
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

    // 2. Trier par type
    var stories = tickets.filter(function(t) { return t.fields.issuetype.name === "Story"; });
    var bugs = tickets.filter(function(t) { return t.fields.issuetype.name === "Bug"; });
    var tests = tickets.filter(function(t) {
      return t.fields.issuetype.name === "Test" || t.fields.issuetype.name === "Test Case";
    });
    var tasks = tickets.filter(function(t) { return t.fields.issuetype.name === "Task"; });

    log("Repartition : " + stories.length + " US, " + bugs.length + " Bug, " + tests.length + " Test, " + tasks.length + " Task");
    sse({ type: "daily-job-progress", step: "sort", message: stories.length + " US, " + bugs.length + " Bug, " + tests.length + " Test, " + tasks.length + " Task" });

    // 3. Traiter dans l'ordre : US → Bug → Test
    for (var i = 0; i < stories.length; i++) {
      await processUS(stories[i], report);
    }
    for (var j = 0; j < bugs.length; j++) {
      await processBug(bugs[j], report);
    }
    for (var k = 0; k < tests.length; k++) {
      await processTest(tests[k], report);
    }
    // Tasks : juste compter
    report.ticketsTraites += tasks.length;

  } catch(e) {
    log("ERREUR GLOBALE : " + e.message);
    report.erreurs.push({ key: "global", type: "system", error: e.message });
  }

  report.dureeMs = Date.now() - startTime;
  try { saveReport(report); } catch(saveErr) { log("ERREUR saveReport : " + saveErr.message); }

  log("========================================");
  log("  RAPPORT : " + report.ticketsTraites + " traites | " +
    report.pass + " PASS | " + report.fail + " FAIL | " +
    report.bugsCreees + " bugs | " + report.erreurs.length + " erreurs");
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
    var crashReport = { date: new Date().toISOString(), ticketsTraites: 0, erreurs: [{ key:"crash", type:"system", error: e.message }], details:[], pass:0, fail:0, bugsCreees:0, usEnrichies:0, testsGeneres:0, casTestImportesXray:0, testsExecutes:0, dureeMs: 0 };
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
