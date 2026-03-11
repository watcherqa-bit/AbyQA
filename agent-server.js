// agent-server.js v2 - Serveur local
// Permet d'executer tous les agents depuis le dashboard sans terminal
// Usage : node agent-server.js
// Dashboard : http://localhost:3210

"use strict";

//  ANTI 429 (Anthropic) : throttle + retry + queue 
function _sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

// délai mini entre 2 requêtes Anthropic (évite les rafales)
var _anthLast = 0;
function _anthThrottle(minIntervalMs) {
  minIntervalMs = minIntervalMs || 1500;
  var now = Date.now();
  var waitMs = _anthLast + minIntervalMs - now;
  if (waitMs <= 0) { _anthLast = Date.now(); return Promise.resolve(); }
  return _sleep(waitMs).then(function(){ _anthLast = Date.now(); });
}

// retry 429 (backoff + jitter)
function _anthWithRetry(fn, opts) {
  opts = opts || {};
  var maxRetries = (opts.maxRetries != null) ? opts.maxRetries : 5;
  var baseMs     = (opts.baseMs != null) ? opts.baseMs : 1500;
  var maxMs      = (opts.maxMs != null) ? opts.maxMs : 20000;

  var attempt = 0;
  function run() {
    return Promise.resolve().then(fn).catch(function(err){
      var status = (err && (err.status || (err.response && err.response.status))) || 0;
      if (status !== 429 || attempt >= maxRetries) throw err;

      var exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
      var jitter = Math.floor(Math.random() * 400);
      var waitMs = exp + jitter;
      console.warn("[ANTHROPIC] 429  retry " + (attempt+1) + "/" + maxRetries + " dans " + waitMs + "ms");
      attempt++;
      return _sleep(waitMs).then(run);
    });
  }
  return run();
}

// queue globale : garantit 1 appel Anthropic à la fois
var _anthChain = Promise.resolve();
function _anthEnqueue(taskFn) {
  var run = function(){ return Promise.resolve().then(taskFn); };
  _anthChain = _anthChain.then(run, run);
  return _anthChain;
}

// options (tu peux les déplacer dans config plus tard)
var ANTH_MIN_INTERVAL_MS = (process.env.ANTH_MIN_INTERVAL_MS ? parseInt(process.env.ANTH_MIN_INTERVAL_MS,10) : 1500);
var ANTH_MAX_RETRIES     = (process.env.ANTH_MAX_RETRIES ? parseInt(process.env.ANTH_MAX_RETRIES,10) : 5);
var CHAT_MAX_TOKENS      = (process.env.CHAT_MAX_TOKENS ? parseInt(process.env.CHAT_MAX_TOKENS,10) : 1200);


const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { spawn } = require("child_process");

const CFG         = require("./config");
CFG.paths.init();

// â"€â"€ SINGLETON LEAD QA IA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const leadQA = require("./agent-lead-qa");
var mailer = null;
try { mailer = require("./agent-mailer"); } catch(e) { console.log("[SERVER] agent-mailer non disponible:", e.message); }
var purge = require("./agent-purge");

// â"€â"€ CLIENT ANTHROPIC (chat) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
var _chatAnthropicClient = null;
var _AnthropicCtor = null;

try {
  if (CFG.anthropic && CFG.anthropic.apiKey) {
    var AnthropicSDK = require("@anthropic-ai/sdk");
    // compat CommonJS: parfois { default }, parfois directement la classe, parfois { Anthropic }
    _AnthropicCtor = AnthropicSDK.Anthropic || AnthropicSDK.default || AnthropicSDK;
    _chatAnthropicClient = new _AnthropicCtor({ apiKey: CFG.anthropic.apiKey });
  }
} catch(e) { console.warn("[CHAT] SDK Anthropic non disponible :", e.message); }

const ISTQB = require("./istqb-knowledge");
const bus   = require("./agent-bus");
const CHAT_SYSTEM = ISTQB.forChat + "\n\n" + `Tu es l'assistant QA — assistant IA polyvalent intégré à la plateforme pour Safran Group.

## Domaines de compétence

### QA & Tests
- Tests automatisés, Playwright, Jira, Xray, CSS audit cross-browser
- Rédaction de cas de test, campagnes de régression, analyse PASS/FAIL
- Méthodes QA : BDD, TDD, stratégies de test, couverture

### Développement général
- Code, debug, architecture logicielle (Node.js, JavaScript, HTML/CSS, SQL, etc.)
- Revue de code, refactoring, bonnes pratiques
- APIs REST, intégrations, performances

### Contexte Safran Group
- Site corporate Safran : 3 environnements — Sophie (staging 1), Paulo (staging 2), Prod (safran-group.com)
- CMS Drupal (back-office) : 32 types de contenu (News, Interview, Event, Company, etc.)
- Stack technique : Node.js, Playwright 1.58, Jira Cloud (eurelis.atlassian.net), Xray, Ollama (llama3 local)
- Projet Jira : SAFWBST — tickets US (user stories), BUG, TEST
- Workflow Jira : Backlog → In Progress → To Test → In Validation → Done

## Comportement
- Réponds en français sauf si l'utilisateur écrit dans une autre langue
- Sois concis et orienté action — propose du code ou des étapes concrètes quand c'est utile
- Si une question concerne directement l'app ou Safran, contextualise ta réponse en conséquence`;
const PORT        = CFG.server.port;
const BASE_DIR    = __dirname;
const REPORTS_DIR = CFG.paths.reports;
const UPLOADS_DIR = CFG.paths.uploads;

// â"€â"€ ROUTER LLM (ajout V2 IA) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const router          = require("./agent-router");
const AVAILABLE_AGENTS = router.AVAILABLE_AGENTS;

// â"€â"€ POLLER JIRA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const poller = require("./agent-poller");

// â"€â"€ ORCHESTRATEUR CYCLES QA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const cycle = require("./agent-cycle");

// ── ROUTE MODULES ────────────────────────────────────────────────────────────
const handleChatRoutes     = require("./routes/chat");
const handleEnrichedRoutes = require("./routes/enriched");
const handleBacklogRoutes  = require("./routes/backlog");

var sseClients   = {};

// ── UTILITAIRE : attacher un fichier à un ticket Jira ────────────────────────
function attachFileToJira(issueKey, filePath) {
  if (!fs.existsSync(filePath)) return;
  var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
  var fileData = fs.readFileSync(filePath);
  var fileName = path.basename(filePath);
  var ext = path.extname(filePath).toLowerCase();
  var mime = ext === ".md" ? "text/markdown" : ext === ".png" ? "image/png" : ext === ".json" ? "application/json" : ext === ".csv" ? "text/csv" : "application/octet-stream";
  var boundary = "----QABnd" + Date.now();
  var header = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: " + mime + "\r\n\r\n";
  var footer = "\r\n--" + boundary + "--\r\n";
  var bodyBuf = Buffer.concat([Buffer.from(header), fileData, Buffer.from(footer)]);
  var req = require("https").request({
    hostname: CFG.jira.host,
    path: "/rest/api/3/issue/" + issueKey + "/attachments",
    method: "POST",
    headers: {
      "Authorization": "Basic " + auth,
      "X-Atlassian-Token": "no-check",
      "Content-Type": "multipart/form-data; boundary=" + boundary,
      "Content-Length": bodyBuf.length
    }
  }, function(res) {
    var d = "";
    res.on("data", function(c) { d += c; });
    res.on("end", function() {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log("[ATTACH] " + fileName + " attaché à " + issueKey);
      } else {
        console.log("[ATTACH] Erreur HTTP " + res.statusCode + " pour " + issueKey);
      }
    });
  });
  req.on("error", function(e) { console.log("[ATTACH] Erreur : " + e.message); });
  req.write(bodyBuf);
  req.end();
}
var runningProcs = {};

// Protection anti-double run : Map agent â†’ true si en cours
var agentLocks = {};

// â"€â"€ Surveillance Jira Queue â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const jiraQueue = require("./agent-jira-queue");
const dailyJob  = require("./agent-daily-job");
var DAILY_JOB_MODE = (process.env.DAILY_JOB_MODE || "").toLowerCase() === "true";

// ── Helper Jira API (Promise) ────────────────────────────────────────────────
function jiraApiCall(method, apiPath, body) {
  var CFGapi = require("./config");
  var authApi = Buffer.from(CFGapi.jira.email + ":" + CFGapi.jira.token).toString("base64");
  var httpsApi = require("https");
  var payload = body ? JSON.stringify(body) : null;
  var headers = { "Authorization": "Basic " + authApi, "Accept": "application/json" };
  if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
  return new Promise(function(resolve, reject) {
    var r = httpsApi.request({ hostname: CFGapi.jira.host, path: apiPath, method: method, headers: headers }, function(res) {
      var d = ""; res.on("data", function(c) { d += c; });
      res.on("end", function() { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Helper : poster un commentaire ADF sur un ticket Jira
function jiraComment(issueKey, text) {
  return jiraApiCall("POST", "/rest/api/3/issue/" + issueKey + "/comment", {
    body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: text }] }] }
  }).then(function(r) {
    if (r.status >= 400) console.error("[JIRA] Commentaire échoué sur " + issueKey + " (HTTP " + r.status + ")");
  }).catch(function(e) {
    console.error("[JIRA] Erreur commentaire " + issueKey + " :", e.message);
  });
}

// ── Détection Test Plan / Test Execution par release ─────────────────────────
async function findTestPlanExec(release) {
  var CFGf = require("./config");
  var project = CFGf.jira.project || "SAFWBST";
  var result = { testPlan: null, testExec: null };
  try {
    var jqlPlan = 'project = ' + project + ' AND issuetype = "Test Plan" AND summary ~ "' + release + '" ORDER BY created DESC';
    var planRes = await jiraApiCall("GET", "/rest/api/3/search/jql?jql=" + encodeURIComponent(jqlPlan) + "&fields=summary,status,key&maxResults=1");
    var planIssues = (planRes.data && planRes.data.issues) || [];
    if (planIssues.length > 0) {
      var p = planIssues[0];
      result.testPlan = { key: p.key, summary: p.fields.summary, status: (p.fields.status || {}).name || "", exists: true };
    }
  } catch(e) { console.warn("[findTestPlanExec] Plan search error:", e.message); }
  try {
    var jqlExec = 'project = ' + project + ' AND issuetype = "Test Execution" AND summary ~ "' + release + '" ORDER BY created DESC';
    var execRes = await jiraApiCall("GET", "/rest/api/3/search/jql?jql=" + encodeURIComponent(jqlExec) + "&fields=summary,status,key&maxResults=1");
    var execIssues = (execRes.data && execRes.data.issues) || [];
    if (execIssues.length > 0) {
      var e2 = execIssues[0];
      result.testExec = { key: e2.key, summary: e2.fields.summary, status: (e2.fields.status || {}).name || "", exists: true };
    }
  } catch(e) { console.warn("[findTestPlanExec] Exec search error:", e.message); }
  return result;
}

async function ensureTestPlanExec(release, testKey) {
  var CFGe = require("./config");
  var project = CFGe.jira.project || "SAFWBST";
  var planExec = await findTestPlanExec(release);

  if (!planExec.testPlan) {
    try {
      var pr = await jiraApiCall("POST", "/rest/api/3/issue", { fields: {
        project: { key: project }, summary: "Plan de Test - Release " + release,
        issuetype: { name: "Test Plan" }, labels: [release]
      }});
      if (pr.data && pr.data.key) planExec.testPlan = { key: pr.data.key, summary: "Plan de Test - Release " + release, exists: false, created: true };
      else console.warn("[ensureTestPlanExec] Plan create failed:", JSON.stringify(pr.data).substring(0, 200));
    } catch(e) { console.warn("[ensureTestPlanExec] Plan create error:", e.message); }
  }

  if (!planExec.testExec) {
    try {
      var er = await jiraApiCall("POST", "/rest/api/3/issue", { fields: {
        project: { key: project }, summary: "Test Execution - Release " + release,
        issuetype: { name: "Test Execution" }, labels: [release]
      }});
      if (er.data && er.data.key) planExec.testExec = { key: er.data.key, summary: "Test Execution - Release " + release, exists: false, created: true };
      else console.warn("[ensureTestPlanExec] Exec create failed:", JSON.stringify(er.data).substring(0, 200));
    } catch(e) { console.warn("[ensureTestPlanExec] Exec create error:", e.message); }
  }

  if (planExec.testPlan && testKey) {
    try { await jiraApiCall("POST", "/rest/raven/1.0/api/testplan/" + planExec.testPlan.key + "/test", { add: [testKey] }); }
    catch(e) { console.warn("[ensureTestPlanExec] Plan attach error:", e.message); }
  }
  if (planExec.testExec && testKey) {
    try { await jiraApiCall("POST", "/rest/raven/1.0/api/testexec/" + planExec.testExec.key + "/test", { add: [testKey] }); }
    catch(e) { console.warn("[ensureTestPlanExec] Exec attach error:", e.message); }
  }
  return planExec;
}



function sendSSE(clientId, data) {
  var clients = sseClients[clientId] || [];
  clients.forEach(function(res) {
    try { res.write("data: " + JSON.stringify(data) + "\n\n"); } catch(e) { /* client deconnecte */ }
  });
}

function runAgent(agentId, cmd, args, clientId, isDryRun, opts) {
  opts = opts || {};
  // Protection anti-double run
  if (agentLocks[agentId]) {
    sendSSE(clientId, { type: "warn", agent: agentId, line: "[SKIP] " + agentId + " dÃ©jÃ  en cours  —  ignorÃ©" });
    return;
  }
  if (runningProcs[agentId]) {
    try { runningProcs[agentId].kill(); } catch(e) { /* process deja mort */ }
  }

  // DRY_RUN : prÃ©fixer tous les logs SSE
  var dryPrefix = isDryRun ? "[DRY_RUN] " : "";
  sendSSE(clientId, { type: "start", agent: agentId, cmd: dryPrefix + cmd + " " + args.join(" ") });

  agentLocks[agentId] = true;
  // Buffer universel  —  toujours actif pour permettre l'auto-debug
  var logBuf = [];

  var proc = spawn(cmd, args, {
    cwd: BASE_DIR, shell: true,
    env: Object.assign({}, process.env, { FORCE_COLOR: "0" })
  });
  runningProcs[agentId] = proc;

  // Timeout global — 5 minutes max par agent
  var AGENT_TIMEOUT_MS = (opts.timeout || 5 * 60) * 1000;
  var killTimer = setTimeout(function() {
    if (runningProcs[agentId]) {
      console.log("[runAgent] TIMEOUT " + (AGENT_TIMEOUT_MS / 1000) + "s — kill " + agentId);
      sendSSE(clientId, { type: "err", agent: agentId, line: "⏱ Timeout " + (AGENT_TIMEOUT_MS / 1000) + "s dépassé — process arrêté" });
      try { proc.kill(); } catch(e) { /* process deja mort */ }
    }
  }, AGENT_TIMEOUT_MS);

  proc.stdout.on("data", function(data) {
    data.toString().split("\n").forEach(function(line) {
      if (line.trim()) {
        // Intercepter les événements de progression Playwright
        if (line.trim().startsWith("PLAYWRIGHT_PROGRESS:")) {
          try {
            var progressData = JSON.parse(line.trim().replace("PLAYWRIGHT_PROGRESS:", ""));
            progressData.type = "playwright-progress";
            progressData.agent = agentId;
            sendSSE(clientId, progressData);
          } catch(e) { console.error("[SERVER] Erreur parse PLAYWRIGHT_PROGRESS :", e.message); }
        }
        // Intercepter les événements bus inter-agents
        if (line.trim().startsWith("BUS_EVENT:")) {
          try {
            var busData = JSON.parse(line.trim().replace("BUS_EVENT:", ""));
            var busEvt = busData.event;
            delete busData.event;
            busData.agent = agentId;
            bus.publish(busEvt, busData);
          } catch(e) { console.error("[SERVER] Erreur parse BUS_EVENT :", e.message); }
        }
        sendSSE(clientId, { type: "log", agent: agentId, line: dryPrefix + line.trim() });
        logBuf.push(line.trim());
      }
    });
  });
  proc.stderr.on("data", function(data) {
    data.toString().split("\n").forEach(function(line) {
      if (line.trim()) {
        sendSSE(clientId, { type: "err", agent: agentId, line: dryPrefix + line.trim() });
        logBuf.push("[ERR] " + line.trim());
      }
    });
  });
  proc.on("close", function(code) {
    clearTimeout(killTimer);
    delete runningProcs[agentId];
    delete agentLocks[agentId];
    sendSSE(clientId, { type: "done", agent: agentId, code: code });
    if (opts.onDone) opts.onDone(code, logBuf);
    // Auto-debug : déclencher l'analyse IA si erreur
    if (code !== 0 && !opts.skipAutoDebug) triggerAutoDebug(agentId, logBuf, clientId);
  });
  proc.on("error", function(e) {
    clearTimeout(killTimer);
    delete agentLocks[agentId];
    sendSSE(clientId, { type: "err", agent: agentId, line: "Erreur spawn : " + e.message });
    sendSSE(clientId, { type: "done", agent: agentId, code: 1 });
    logBuf.push("[ERR] Erreur spawn : " + e.message);
    if (opts.onDone) opts.onDone(1, logBuf);
    if (!opts.skipAutoDebug) triggerAutoDebug(agentId, logBuf, clientId);
  });
}

// â"€â"€ AUTO-DEBUG  —  dÃ©tecte et analyse les erreurs d'agent â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function triggerAutoDebug(agentId, logs, clientId) {
  // 1. VÃ©rifier qu'il y a des lignes d'erreur exploitables
  var errorLines = logs.filter(function(l) {
    return /ReferenceError|TypeError|SyntaxError|RangeError|Cannot find module|is not defined|is not a function|Cannot read|ENOENT|EACCES|ERR_/i.test(l);
  });
  if (!errorLines.length) return;

  // 2. Extraire fichier:ligne depuis la stack trace Node.js
  //    Format : "at Object.<anonymous> (C:\Users\HP\AbyQA\agent-xxx.js:17:25)"
  var fileInfo = null;
  for (var i = 0; i < logs.length; i++) {
    var m = logs[i].match(/\(([A-Za-z]:[^)]+\.js):(\d+):\d+\)/);
    if (m && m[1].startsWith(BASE_DIR)) {
      fileInfo = { file: m[1], line: parseInt(m[2]) };
      break;
    }
  }

  // 3. Lire le contexte du fichier (Â±25 lignes autour de la ligne en erreur)
  var codeContext = "";
  if (fileInfo && fs.existsSync(fileInfo.file)) {
    try {
      var fileLines = fs.readFileSync(fileInfo.file, "utf8").split("\n");
      var start = Math.max(0, fileInfo.line - 26);
      var end   = Math.min(fileLines.length, fileInfo.line + 25);
      codeContext = fileLines.slice(start, end).map(function(l, i) {
        var num = start + i + 1;
        return (num === fileInfo.line ? ">>> " : "    ") + num + ": " + l;
      }).join("\n");
    } catch(e) { console.error("[SERVER] Erreur lecture contexte code :", e.message); }
  }

  // 4. Notifier le dashboard que l'analyse est en cours
  sendSSE(clientId, { type: "log", agent: agentId,
    line: "ðŸ§ [AUTO-DEBUG] Erreur dÃ©tectÃ©e  —  analyse IA en cours..." });

  // 5. Appeler IA
  leadQA.analyzeAgentError({
    agentId:     agentId,
    errorLines:  errorLines.slice(0, 15).join("\n"),
    allLogs:     logs.slice(-60).join("\n"),
    fileInfo:    fileInfo,
    codeContext: codeContext
  }).then(function(diagnosis) {
    var evt = { type: "agent-error-diagnosis", agentId: agentId,
                fileInfo: fileInfo, diagnosis: diagnosis };
    sendSSE(clientId, evt);
    if (clientId !== "default") sendSSE("default", evt);
  }).catch(function() {});
}

function parseMultipart(body, boundary) {
  var result = {};
  var boundaryBuf = Buffer.from("--" + boundary);
  var parts = []; var start = 0;
  for (var i = 0; i < body.length - boundaryBuf.length; i++) {
    var match = true;
    for (var j = 0; j < boundaryBuf.length; j++) {
      if (body[i+j] !== boundaryBuf[j]) { match = false; break; }
    }
    if (match) { if (start > 0) parts.push(body.slice(start, i-2)); start = i + boundaryBuf.length + 2; }
  }
  parts.forEach(function(part) {
    var headerEnd = -1;
    for (var i = 0; i < part.length-3; i++) {
      if (part[i]===13 && part[i+1]===10 && part[i+2]===13 && part[i+3]===10) { headerEnd = i; break; }
    }
    if (headerEnd === -1) return;
    var headers = part.slice(0, headerEnd).toString();
    var content = part.slice(headerEnd + 4);
    var nameMatch = headers.match(/name="([^"]+)"/);
    var fileMatch = headers.match(/filename="([^"]+)"/);
    if (nameMatch) {
      var key = nameMatch[1];
      result[key] = fileMatch ? { filename: fileMatch[1], data: content } : content.toString().trim();
    }
  });
  return result;
}

// â"€â"€ HELPER : construire les args d'un agent depuis les params du router â"€â"€â"€â"€â"€â"€â"€â"€
function buildAgentArgs(agentName, params) {
  var env = params.env || "sophie";
  switch(agentName) {
    case "playwright":
      return ["agent-playwright-direct.js", "--mode=ui", "--source=text", "--text=" + (params.demand || "Tester la page d'accueil"), "--envs=" + env];
    case "css-audit":
      return ["agent-css-audit.js", env];
    case "jira-reader":
      // NÃ©cessite un XML  —  skip si absent
      var xmlPathJR = path.join(BASE_DIR, "uploads", "ticket.xml");
      if (!fs.existsSync(xmlPathJR)) return null;
      return ["agent-jira-reader.js", "uploads/ticket.xml", "--env=" + env];
    case "xray-full":
      var xmlPathXR = path.join(BASE_DIR, "uploads", "ticket.xml");
      if (!fs.existsSync(xmlPathXR)) return null;
      var xArgs = ["agent-xray-full.js", "uploads/ticket.xml", "--env=" + env];
      if (params.dryRun) xArgs.push("--dry-run");
      if (params.forceKey) xArgs.push("--force-key=" + params.forceKey);
      return xArgs;
    case "matrix":
      return ["agent-matrix.js", params.version || "v1.25.0"];
    default:
      return null;
  }
}

// ── IMPORT CSV XRAY ─────────────────────────────────────────────────────────
async function importXrayCSV(ticketKey, csvContent) {
  var xrayAuth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");

  // Construire le multipart/form-data
  var boundary = "----QABoundary" + Date.now();
  var body = "--" + boundary + "\r\n" +
    "Content-Disposition: form-data; name=\"file\"; filename=\"" + ticketKey + "-cas-test.csv\"\r\n" +
    "Content-Type: text/csv\r\n\r\n" +
    csvContent + "\r\n" +
    "--" + boundary + "--\r\n";

  return new Promise(function(resolve, reject) {
    var reqOpts = {
      hostname: CFG.jira.host,
      path: "/rest/raven/1.0/import/test/csv",
      method: "POST",
      headers: {
        "Authorization": "Basic " + xrayAuth,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": Buffer.byteLength(body),
        "X-Atlassian-Token": "no-check"
      }
    };

    var xReq = require("https").request(reqOpts, function(xRes) {
      var data = "";
      xRes.on("data", function(c) { data += c; });
      xRes.on("end", function() {
        console.log("[XRAY] Import CSV " + ticketKey + " — HTTP " + xRes.statusCode);
        if (xRes.statusCode >= 200 && xRes.statusCode < 300) {
          var result = { ok: true, key: ticketKey, statusCode: xRes.statusCode };
          try {
            var parsed = JSON.parse(data);
            result.testKeys = parsed.testKeys || parsed.keys || [];
            result.count = result.testKeys.length;
          } catch(e) {
            result.rawResponse = data.substring(0, 500);
          }

          // Commenter sur le ticket Jira
          var commentAuth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
          var commentBody = JSON.stringify({
            body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: (result.count || "?") + " cas de test importés dans Xray" }] }] }
          });
          var cReq = require("https").request({
            hostname: CFG.jira.host,
            path: "/rest/api/3/issue/" + ticketKey + "/comment",
            method: "POST",
            headers: { "Authorization": "Basic " + commentAuth, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(commentBody) }
          }, function() {});
          cReq.on("error", function() {});
          cReq.write(commentBody);
          cReq.end();

          resolve(result);
        } else {
          reject(new Error("Xray HTTP " + xRes.statusCode + " : " + data.substring(0, 300)));
        }
      });
    });

    xReq.on("error", function(e) { reject(e); });
    xReq.setTimeout(30000, function() { xReq.destroy(); reject(new Error("Timeout Xray import")); });
    xReq.write(body);
    xReq.end();
  });
}

var server = http.createServer(function(req, res) {
  var url    = req.url.split("?")[0];
  var method = req.method;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Atlassian-Token");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Health check — pour monitoring et règle de stabilité ──
  if (method === "GET" && url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() }));
    return;
  }

  if (method === "GET" && (url === "/" || url === "/dashboard")) {
    var p = path.join(BASE_DIR, "aby-qa-dashboard.html");
    if (fs.existsSync(p)) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(p)); }
    else { res.writeHead(404); res.end("aby-qa-dashboard.html introuvable"); }
    return;
  }

  if (method === "GET" && url === "/form") {
    var p2 = path.join(BASE_DIR, "aby-qa-form.html");
    if (fs.existsSync(p2)) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(p2)); }
    else { res.writeHead(404); res.end("Form introuvable"); }
    return;
  }

  if (method === "GET" && url.startsWith("/events/")) {
    var clientId = url.replace("/events/", "");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    if (!sseClients[clientId]) sseClients[clientId] = [];
    sseClients[clientId].push(res);
    var ping = setInterval(function() { try { res.write(": ping\n\n"); } catch(e) { clearInterval(ping); } }, 20000);
    req.on("close", function() {
      clearInterval(ping);
      sseClients[clientId] = (sseClients[clientId] || []).filter(function(c) { return c !== res; });
    });
    return;
  }

  // ── ROUTE MODULES — délégation aux modules extraits ─────────────────────
  var _routeCtx = {
    CFG: CFG, BASE_DIR: BASE_DIR, sendSSE: sendSSE, leadQA: leadQA,
    attachFileToJira: attachFileToJira, importXrayCSV: importXrayCSV,
    _chatAnthropicClient: _chatAnthropicClient, CHAT_SYSTEM: CHAT_SYSTEM,
    REPORTS_DIR: REPORTS_DIR
  };
  if (handleChatRoutes(method, url, req, res, _routeCtx)) return;
  if (handleEnrichedRoutes(method, url, req, res, _routeCtx)) return;
  if (handleBacklogRoutes(method, url, req, res, _routeCtx)) return;

  // â"€â"€ API : Release tracker JSON â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "GET" && url === "/api/release-tracker") {
    var trackerPath = path.join(BASE_DIR, "reports", "release-tracker.json");
    if (fs.existsSync(trackerPath)) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(fs.readFileSync(trackerPath, "utf8"));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }
    return;
  }

  // ── API : Synthèse matrice QA par version ──────────────────────────────────
  if (method === "GET" && url.match(/^\/api\/matrix\/synthesis\/.+/)) {
    var synthVersion = decodeURIComponent(url.replace("/api/matrix/synthesis/", ""));
    var synthPath = path.join(BASE_DIR, "reports", "synthesis-" + synthVersion + ".json");
    if (fs.existsSync(synthPath)) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(fs.readFileSync(synthPath, "utf8"));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Synthèse non trouvée pour " + synthVersion }));
    }
    return;
  }

  // â"€â"€ API : TÃ©lÃ©charger un fichier du dossier reports â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "GET" && url.startsWith("/api/download/")) {
    var dlParts = url.replace("/api/download/", "").split("?");
    var fname = decodeURIComponent(dlParts[0]);
    var dlForce = url.includes("?dl=1");
    var fpath = path.join(BASE_DIR, "reports", fname);
    if (fs.existsSync(fpath)) {
      var ext  = path.extname(fname).toLowerCase();
      var mime = ext===".csv"?"text/csv":ext===".html"?"text/html; charset=utf-8":ext===".json"?"application/json":ext===".md"?"text/markdown; charset=utf-8":"application/octet-stream";
      var headers = { "Content-Type": mime };
      if (dlForce || (ext !== ".html" && ext !== ".md")) {
        headers["Content-Disposition"] = 'attachment; filename="' + fname + '"';
      } else {
        headers["Content-Disposition"] = "inline";
      }
      res.writeHead(200, headers);
      fs.createReadStream(fpath).pipe(res);
    } else {
      res.writeHead(404); res.end("Fichier introuvable : " + fname);
    }
    return;
  }

  // â"€â"€ API : Chercher un ticket Jira â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "GET" && url.startsWith("/api/jira-ticket/")) {
    var ticketKey = url.replace("/api/jira-ticket/", "").toUpperCase();
    var CFG2 = require("./config");
    var https2 = require("https");
    var auth2 = Buffer.from(CFG2.jira.email + ":" + CFG2.jira.token).toString("base64");
    var jiraReq = https2.request({
      hostname: CFG2.jira.host,
      path: "/rest/api/2/issue/" + ticketKey + "?fields=summary,status,issuetype,assignee,labels,description,priority,components,fixVersions,parent,customfield_10014,customfield_10016,customfield_10010,comment",
      method: "GET",
      headers: { "Authorization": "Basic " + auth2, "Accept": "application/json" }
    }, function(jiraRes) {
      var data = "";
      jiraRes.on("data", function(c) { data += c; });
      jiraRes.on("end", function() {
        try {
          var issue = JSON.parse(data);
          if (issue.errorMessages) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Ticket introuvable" }));
          } else {
            var f = issue.fields;
            // Extraction texte depuis ADF (Atlassian Document Format) ou string
            function adfText(node) {
              if (!node) return "";
              if (typeof node === "string") return node;
              var out = "";
              if (node.text) out += node.text;
              if (node.content) node.content.forEach(function(c) { out += adfText(c) + (c.type === "paragraph" ? "\n" : ""); });
              return out;
            }
            var descText = typeof f.description === "string" ? f.description : adfText(f.description);
            var epicLink = (f.customfield_10014) || (f.parent && f.parent.fields && f.parent.fields.issuetype && f.parent.fields.issuetype.name === "Epic" ? f.parent.fields.summary : null) || "";
            var lastComments = [];
            if (f.comment && f.comment.comments) {
              lastComments = f.comment.comments.slice(-3).map(function(c) {
                return { author: c.author && c.author.displayName, body: adfText(c.body).substring(0, 300) };
              });
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              key:         ticketKey,
              summary:     f.summary,
              status:      f.status && f.status.name,
              type:        f.issuetype && f.issuetype.name,
              assignee:    f.assignee ? f.assignee.displayName : "Non assigné",
              priority:    f.priority && f.priority.name,
              labels:      f.labels || [],
              components:  (f.components || []).map(function(c) { return c.name; }),
              fixVersions: (f.fixVersions || []).map(function(v) { return v.name; }),
              epic:        epicLink,
              storyPoints: f.customfield_10016 || null,
              description: descText,
              comments:    lastComments
            }));
          }
        } catch(e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    jiraReq.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    jiraReq.end();
    return;
  }

  // â"€â"€ API : Suggestion donnÃ©es de test Drupal par IA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  // ── API : Inspecteur DOM Playwright ───────────────────────────────────────
  if (method === "POST" && url === "/api/inspect") {
    var inspChunks = [];
    req.on("data", function(c) { inspChunks.push(c); });
    req.on("end", function() {
      try {
        var inspParams = JSON.parse(Buffer.concat(inspChunks).toString());
        var inspEnv    = inspParams.env   || "sophie";
        var inspUrl    = inspParams.url   || "/fr";
        var inspForce  = inspParams.force ? "true" : "false";
        var inspArgs   = ["agent-inspector.js", "--env=" + inspEnv, "--url=" + inspUrl, "--force=" + inspForce];
        var inspProc   = spawn("node", inspArgs, {
          cwd: BASE_DIR, shell: true,
          env: Object.assign({}, process.env, { FORCE_COLOR: "0" })
        });
        var inspOut = "";
        inspProc.stdout.on("data", function(d) { inspOut += d.toString(); });
        inspProc.stderr.on("data", function(d) { inspOut += d.toString(); });
        inspProc.on("close", function() {
          try {
            var resLine = inspOut.split("\n").find(function(l) { return l.startsWith("INSPECTOR_RESULT:"); });
            if (resLine) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(resLine.replace("INSPECTOR_RESULT:", ""));
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "Pas de résultat", log: inspOut.slice(0, 400) }));
            }
          } catch(e2) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e2.message }));
          }
        });
        inspProc.on("error", function(e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── API : Génération ticket structuré (US / TEST / BUG) ──────────────────────
  if (method === "POST" && url === "/api/ops-generate") {
    var genChunks = [];
    req.on("data", function(c) { genChunks.push(c); });
    req.on("end", async function() {
      try {
        var body    = JSON.parse(Buffer.concat(genChunks).toString());
        var text    = (body.text || "").trim();
        var tickets = body.tickets || [];
        var subtype = (body.subtype || "auto").toUpperCase(); // US | TEST | BUG | AUTO

        // Construire un contexte riche depuis les données Jira complètes
        var ticketCtx = "";
        if (tickets.length) {
          tickets.forEach(function(t) {
            ticketCtx += "--- Ticket " + t.key + " ---\n";
            ticketCtx += "Type     : " + (t.type || "?") + "\n";
            ticketCtx += "Titre    : " + (t.summary || "") + "\n";
            if (t.status)      ticketCtx += "Statut   : " + t.status + "\n";
            if (t.priority)    ticketCtx += "Priorité : " + t.priority + "\n";
            if (t.epic)        ticketCtx += "Epic     : " + t.epic + "\n";
            if (t.components && t.components.length) ticketCtx += "Composants: " + t.components.join(", ") + "\n";
            if (t.labels && t.labels.length)         ticketCtx += "Labels   : " + t.labels.join(", ") + "\n";
            if (t.fixVersions && t.fixVersions.length) ticketCtx += "Version  : " + t.fixVersions.join(", ") + "\n";
            if (t.description) ticketCtx += "Description:\n" + t.description.substring(0, 1500) + "\n";
            if (t.comments && t.comments.length) {
              ticketCtx += "Derniers commentaires :\n";
              t.comments.forEach(function(c) { ticketCtx += "  [" + (c.author || "?") + "] " + (c.body || "") + "\n"; });
            }
            ticketCtx += "\n";
          });
        }

        // Si subtype AUTO, déduire depuis le type du premier ticket
        if (subtype === "AUTO" && tickets.length) {
          var firstType = (tickets[0].type || "").toLowerCase();
          if (firstType.includes("bug"))   subtype = "BUG";
          else if (firstType.includes("story")) subtype = "US";
          else if (firstType.includes("test"))  subtype = "TEST";
        }

        var prompt =
          ISTQB.forGeneration + "\n\n" +
          "Tu es Lead QA expert chez Safran Group, certifié ISTQB CTFL.\n\n" +
          "RÈGLES ABSOLUES — NE PAS VIOLER :\n" +
          "1. Tu ne génères QUE du contenu basé sur les données du ticket fourni. RIEN d'autre.\n" +
          "2. Si une information n'est PAS dans le ticket (URL, sélecteur, composant, valeur), tu écris [À préciser] — tu n'inventes JAMAIS.\n" +
          "3. Les URLs dans les étapes de test doivent être EXACTEMENT celles mentionnées dans la description du ticket. Pas d'URL inventée.\n" +
          "4. Les sélecteurs CSS/XPath dans les étapes doivent être ceux mentionnés dans le ticket ou décrits comme [sélecteur à préciser].\n" +
          "5. Les noms de champs, boutons, éléments doivent correspondre exactement aux termes utilisés dans la description du ticket.\n" +
          "6. Tu ne complètes JAMAIS un contenu manquant par une supposition. Mieux vaut [À préciser] qu'une invention.\n\n" +
          (text ? "INSTRUCTION UTILISATEUR : " + text + "\n\n" : "") +
          (ticketCtx ? "DONNÉES JIRA (SOURCE UNIQUE DE VÉRITÉ) :\n" + ticketCtx : "") +
          "TYPE À GÉNÉRER : " + subtype + "\n\n" +
          "RÈGLES DE NOMENCLATURE OBLIGATOIRES :\n" +
          "- US   : \"User Story - [NOM_EPIC] - fonctionnalité à développer\"  (omettre [NOM_EPIC] si aucun epic)\n" +
          "- TEST : \"Test - [Titre de l'US] - test à effectuer\"               (omettre l'US si absente)\n" +
          "- BUG  : \"Bug - [Titre de l'US] - nom du bug\"                      (omettre l'US si absente)\n\n" +
          "Selon le type, retourne UN seul objet JSON.\n\n" +
          "CHAMP COMMUN À TOUS LES TYPES — proposedTests :\n" +
          "Génère des scénarios de test STRICTEMENT basés sur le contenu du ticket.\n" +
          "Règles pour les étapes :\n" +
          "  - Utilise UNIQUEMENT les URLs présentes dans la description du ticket\n" +
          "  - Si un sélecteur CSS n'est pas mentionné dans le ticket → écris '[sélecteur à préciser]'\n" +
          "  - Si une valeur de test n'est pas mentionnée → écris '[valeur à préciser]'\n" +
          "  - Chaque étape doit être actionnable : Naviguer vers X / Cliquer sur Y / Vérifier que Z\n" +
          "\"proposedTests\":[\n" +
          "  {\"name\":\"Nom du scénario (basé sur le ticket)\",\"type\":\"auto|manual\",\n" +
          "   \"steps\":[\"Naviguer vers [URL du ticket]\",\"Cliquer sur [élément décrit dans le ticket]\",\"Vérifier que [comportement décrit dans le ticket]\"],\n" +
          "   \"expectedResult\":\"[Résultat attendu tel que décrit dans le ticket]\"}\n" +
          "]\n\n" +
          "Si US :\n" +
          "{\"ticketType\":\"US\",\"title\":\"User Story - [EPIC] - ...\",\n" +
          " \"description\":\"En tant que [persona], je veux [action], afin de [bénéfice].\",\n" +
          " \"acceptanceCriteria\":[\"Étant donné... Lorsque... Alors...\"],\n" +
          " \"testCoverage\":{\"count\":5,\"types\":[\"e2e\"],\"notes\":\"...\"},\n" +
          " \"automationType\":\"auto|manual|mix\",\"automationJustification\":\"...\",\"priority\":\"Haute\",\n" +
          " \"niveauxTest\":[\"Système\",\"Acceptation\"],\n" +
          " \"risque\":\"Haut|Moyen|Faible\",\n" +
          " \"risqueJustification\":\"Justification basée sur la complexité et l'impact métier du ticket.\",\n" +
          " \"donneesTestRequises\":[\"Compte utilisateur avec rôle X\",\"Contenu de type Y en état Z\"],\n" +
          " \"proposedTests\":[{\"name\":\"...\",\"type\":\"auto\",\"steps\":[\"...\"],\"expectedResult\":\"...\"}]}\n\n" +
          "RÈGLES US — Niveaux de test ISTQB :\n" +
          "- niveauxTest : sélectionner parmi [\"Composant\",\"Intégration\",\"Système\",\"Acceptation\"] selon la portée du ticket\n" +
          "- risque : évaluer selon la criticité métier (Haut = fonctionnalité cœur ou données sensibles, Faible = cosmétique ou non-bloquant)\n" +
          "- donneesTestRequises : lister les prérequis concrets (comptes, contenus Drupal, config env) extraits du ticket\n\n" +
          "Si TEST :\n" +
          "{\"ticketType\":\"TEST\",\"title\":\"Test - [Titre_US] - ...\",\n" +
          " \"description\":\"...\",\"testType\":\"auto|manual\",\"testTypeJustification\":\"...\",\n" +
          " \"techniqueConception\":\"EP|BVA|DT|ST|CE\",\n" +
          " \"techniqueJustification\":\"Pourquoi cette technique est adaptée au ticket.\",\n" +
          " \"niveauTest\":\"Système|Acceptation\",\n" +
          " \"baseDeTest\":\"Description courte des exigences/spécifications utilisées comme base (tirées du ticket).\",\n" +
          " \"preconditions\":[\"Être connecté en tant que [rôle]\",\"Le contenu [type] doit exister en base\"],\n" +
          " \"testCases\":[{\"id\":\"TC-01\",\"categorie\":\"Nominal|Alternatif|Erreur|Limite\",\"action\":\"Étant donné...\\nLorsque...\\nAlors...\",\"data\":\"• Clé: Valeur\",\"expected\":\"• Critère 1\\n• Critère 2\"}],\n" +
          " \"proposedTests\":[{\"name\":\"...\",\"type\":\"auto\",\"steps\":[\"...\"],\"expectedResult\":\"...\"}]}\n\n" +
          "RÈGLES TEST — Techniques de conception ISTQB :\n" +
          "- EP (Equivalence Partitioning) : si le ticket porte sur des valeurs de champs ou des états discrets\n" +
          "- BVA (Boundary Value Analysis) : si le ticket mentionne des limites numériques, des longueurs max, des seuils\n" +
          "- DT (Decision Table) : si le ticket comporte des règles métier avec conditions multiples (si A et B alors C)\n" +
          "- ST (State Transition) : si le ticket décrit un workflow ou un changement d'état (statut, phase, cycle de vie)\n" +
          "- CE (Cause-Effect) : si le ticket décrit des relations causales complexes entre entrées et sorties\n" +
          "- categorie des testCases : 'Nominal' (chemin heureux), 'Alternatif' (variante valide), 'Erreur' (input invalide), 'Limite' (valeur frontière)\n\n" +
          "Si BUG :\n" +
          "{\"ticketType\":\"BUG\",\"title\":\"Bug - [Titre_US] - ...\",\n" +
          " \"description\":\"...\",\n" +
          " \"steps\":[\"1. Accéder à...\",\"2. Cliquer sur...\"],\n" +
          " \"actualResult\":\"...\",\"expectedResult\":\"...\",\n" +
          " \"severity\":\"Bloquant|Critique|Majeur|Mineur|Cosmétique\",\n" +
          " \"priority\":\"P1-Urgent|P2-Haut|P3-Moyen|P4-Bas\",\n" +
          " \"environment\":\"Sophie|Paulo|Prod|[À préciser]\",\n" +
          " \"rootCause\":\"Interface|Logique métier|Base de données|Configuration|Intégration|[À préciser]\",\n" +
          " \"reproducibility\":\"Toujours|Intermittent|Rare\",\n" +
          " \"fixTests\":[\"Vérifier que...\",\"Tester le cas nominal...\"],\n" +
          " \"proposedTests\":[{\"name\":\"...\",\"type\":\"auto\",\"steps\":[\"Naviguer vers URL réelle\",\"Effectuer l'action précise\",\"Vérifier le comportement attendu\"],\"expectedResult\":\"...\"}]}\n\n" +
          "RÈGLES BUG — Distinction ISTQB Sévérité vs Priorité :\n" +
          "- severity (impact technique) : Bloquant=empêche toute utilisation, Critique=perte de données/sécurité, Majeur=fonctionnalité cassée, Mineur=dégradation partielle, Cosmétique=aspect visuel seul\n" +
          "- priority (urgence métier) : P1=bloquer la release/prod immédiatement, P2=corriger dans le sprint, P3=planifier correction, P4=nice-to-have\n" +
          "- environment : déduire depuis le contexte du ticket (Sophie/Paulo=staging, Prod=production)\n" +
          "- rootCause : cause racine probable basée sur la description du bug\n\n" +
          "Génère : 3-6 acceptanceCriteria (US), 3-6 testCases avec categories variées (TEST), 3-6 steps + 2-4 fixTests (BUG).\n" +
          "Pour proposedTests : 2 à 4 scénarios couvrant le cas nominal, le cas limite, et la régression.";

        var result = await leadQA.askJSON(prompt, "claude-sonnet-4-6");

        // Générer CSV Xray pour les TEST (avec colonne Catégorie si présente)
        if (result && result.ticketType === "TEST" && Array.isArray(result.testCases)) {
          var hasCat = result.testCases.some(function(tc) { return tc.categorie; });
          var csvLines = hasCat
            ? ['"Catégorie","Action","Données","Résultat Attendu"']
            : ['"Action","Données","Résultat Attendu"'];
          result.testCases.forEach(function(tc) {
            var row = hasCat
              ? '"' + (tc.categorie || "").replace(/"/g, '""') + '",'
              : "";
            row +=
              '"' + (tc.action   || "").replace(/"/g, '""') + '",' +
              '"' + (tc.data     || "").replace(/"/g, '""') + '",' +
              '"' + (tc.expected || "").replace(/"/g, '""') + '"';
            csvLines.push(row);
          });
          result.xrayCSV = csvLines.join("\n");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: result }));
      } catch(e) {
        console.error("[ops-generate] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── API : Push ticket vers Jira (après édition) ──────────────────────────────
  // ── API : Intégrer contenu généré dans un ticket Jira existant ───────────────
  if (method === "PUT" && /^\/api\/jira-update\/[A-Z0-9-]+$/.test(url)) {
    var updateKey = url.split("/").pop();
    var updChunks = [];
    req.on("data", function(c) { updChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(updChunks).toString());
        var CFGu = require("./config");
        var authu = Buffer.from(CFGu.jira.email + ":" + CFGu.jira.token).toString("base64");
        var https_u = require("https");

        // 1. Récupérer la description ADF actuelle
        var currentIssue = await new Promise(function(resolve, reject) {
          var gr = https_u.request({
            hostname: CFGu.jira.host,
            path: "/rest/api/3/issue/" + updateKey + "?fields=description",
            method: "GET",
            headers: { "Authorization": "Basic " + authu, "Accept": "application/json" }
          }, function(gRes) {
            var gData = ""; gRes.on("data", function(d) { gData += d; });
            gRes.on("end", function() { try { resolve(JSON.parse(gData)); } catch(e) { resolve({}); } });
          });
          gr.on("error", reject); gr.end();
        });

        // 2. Construire les sections ADF à ajouter
        var appendSections = [];
        if (body.ticketType === "BUG") {
          if (body.steps && body.steps.length) {
            appendSections.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Étapes de reproduction" }] });
            body.steps.forEach(function(s, i) {
              appendSections.push({ type: "paragraph", content: [{ type: "text", text: (i + 1) + ". " + s }] });
            });
            if (body.actualResult) {
              appendSections.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Résultat obtenu" }] });
              appendSections.push({ type: "paragraph", content: [{ type: "text", text: body.actualResult }] });
            }
            if (body.expectedResult) {
              appendSections.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Résultat attendu" }] });
              appendSections.push({ type: "paragraph", content: [{ type: "text", text: body.expectedResult }] });
            }
          }
          if (body.fixTests && body.fixTests.length) {
            appendSections.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Tests de correction" }] });
            body.fixTests.forEach(function(t) {
              appendSections.push({ type: "paragraph", content: [{ type: "text", text: "• " + t }] });
            });
          }
        }
        if (body.ticketType === "US" && body.acceptanceCriteria && body.acceptanceCriteria.length) {
          appendSections.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Critères d'acceptation" }] });
          body.acceptanceCriteria.forEach(function(ac) {
            appendSections.push({ type: "paragraph", content: [{ type: "text", text: "• " + ac }] });
          });
        }
        if (body.ticketType === "TEST" && body.testCases && body.testCases.length) {
          appendSections.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Cas de test" }] });
          body.testCases.forEach(function(tc, i) {
            appendSections.push({ type: "paragraph", content: [{ type: "text", text: (tc.id || ("TC-" + (i + 1))) }] });
            if (tc.action)   appendSections.push({ type: "paragraph", content: [{ type: "text", text: "Action : " + tc.action }] });
            if (tc.data)     appendSections.push({ type: "paragraph", content: [{ type: "text", text: "Données : " + tc.data }] });
            if (tc.expected) appendSections.push({ type: "paragraph", content: [{ type: "text", text: "Attendu : " + tc.expected }] });
          });
        }

        if (!appendSections.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Aucun contenu à intégrer" }));
          return;
        }

        // 3. Fusionner avec la description existante
        var existingContent = [];
        if (currentIssue.fields && currentIssue.fields.description && currentIssue.fields.description.content) {
          existingContent = currentIssue.fields.description.content;
        }
        // Séparateur horizontal si description existante
        if (existingContent.length) appendSections.unshift({ type: "rule" });

        var newDesc = { version: 1, type: "doc", content: existingContent.concat(appendSections) };

        // 4. PUT mise à jour Jira
        var updatePayload = JSON.stringify({ fields: { description: newDesc } });
        var updateStatus = await new Promise(function(resolve, reject) {
          var ur = https_u.request({
            hostname: CFGu.jira.host,
            path: "/rest/api/3/issue/" + updateKey,
            method: "PUT",
            headers: {
              "Authorization": "Basic " + authu,
              "Content-Type": "application/json",
              "Accept": "application/json",
              "Content-Length": Buffer.byteLength(updatePayload)
            }
          }, function(uRes) { uRes.resume(); resolve(uRes.statusCode); });
          ur.on("error", reject);
          ur.write(updatePayload); ur.end();
        });

        if (updateStatus === 204) {
          console.log("[jira-update] Intégré dans : " + updateKey);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key: updateKey }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Jira PUT status : " + updateStatus }));
        }
      } catch(e) {
        console.error("[jira-update] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (method === "POST" && url === "/api/jira-push") {
    var jpChunks = [];
    req.on("data", function(c) { jpChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(jpChunks).toString());
        var CFGj = require("./config");
        var authj = Buffer.from(CFGj.jira.email + ":" + CFGj.jira.token).toString("base64");

        // Mapping type ticket → issuetype Jira
        var typeMap = { US: "Story", TEST: "Test", BUG: "Bug", TASK: "Task" };
        var issueType = typeMap[(body.ticketType || "").toUpperCase()] || "Task";

        // Mapping priorité → Jira
        var prioMap = { Critique:"Highest", Majeur:"High", Mineur:"Low", Cosmétique:"Lowest",
                        Haute:"High", Moyenne:"Medium", Basse:"Low" };
        var priority = prioMap[body.priority] || "Medium";

        // Conversion texte → ADF (Atlassian Document Format) pour description
        function toADF(text) {
          if (!text) return { version:1, type:"doc", content:[{ type:"paragraph", content:[{ type:"text", text:"" }] }] };
          var lines = String(text).split("\n");
          var content = [];
          lines.forEach(function(l) {
            if (!l.trim()) { content.push({ type:"paragraph", content:[{ type:"text", text:"" }] }); return; }
            // Listes numérotées
            var numMatch = l.match(/^(\d+)\.\s+(.*)/);
            if (numMatch) { content.push({ type:"paragraph", content:[{ type:"text", text: numMatch[1] + ". " + numMatch[2] }] }); return; }
            // Listes à puces
            var bulletMatch = l.match(/^[-•]\s+(.*)/);
            if (bulletMatch) { content.push({ type:"paragraph", content:[{ type:"text", text:"• " + bulletMatch[1] }] }); return; }
            content.push({ type:"paragraph", content:[{ type:"text", text: l }] });
          });
          return { version:1, type:"doc", content: content };
        }

        // Construire la description complète
        var fullDesc = (body.description || "") + "\n\n";
        if (body.ticketType === "BUG") {
          if (body.steps && body.steps.length) {
            fullDesc += "Étapes de reproduction :\n" + body.steps.join("\n") + "\n\n";
            fullDesc += "Résultat obtenu :\n" + (body.actualResult || "") + "\n\n";
            fullDesc += "Résultat attendu :\n" + (body.expectedResult || "") + "\n\n";
          }
          if (body.fixTests && body.fixTests.length) {
            fullDesc += "Tests de correction :\n" + body.fixTests.join("\n") + "\n\n";
          }
        }
        if (body.ticketType === "US") {
          if (body.acceptanceCriteria && body.acceptanceCriteria.length) {
            fullDesc += "Critères d'acceptation :\n" + body.acceptanceCriteria.join("\n") + "\n\n";
          }
        }
        if (body.ticketType === "TEST") {
          if (body.testCases && body.testCases.length) {
            fullDesc += "Cas de test :\n";
            body.testCases.forEach(function(tc, i) {
              fullDesc += "\n" + (tc.id || ("TC-" + (i + 1))) + "\n";
              if (tc.action)   fullDesc += "Action : " + tc.action + "\n";
              if (tc.data)     fullDesc += "Données : " + tc.data + "\n";
              if (tc.expected) fullDesc += "Attendu : " + tc.expected + "\n";
            });
            fullDesc += "\n";
          }
        }

        var fields = {
          project:     { key: CFGj.jira.project || "SAFWBST" },
          summary:     body.title || "Ticket QA",
          description: toADF(fullDesc.trim()),
          issuetype:   { name: issueType },
          priority:    { name: priority }
        };
        if (body.labels && body.labels.length) fields.labels = body.labels;
        // Ne pas utiliser fields.parent — on crée un issueLink à part (plus compatible)
        // (champ parent Jira Cloud est pour les sous-tâches uniquement)

        var payload = JSON.stringify({ fields: fields });
        var https_j = require("https");

        var createResult = await new Promise(function(resolve, reject) {
          var cr = https_j.request({
            hostname: CFGj.jira.host,
            path: "/rest/api/3/issue",
            method: "POST",
            headers: {
              "Authorization": "Basic " + authj,
              "Content-Type": "application/json",
              "Accept": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            }
          }, function(cRes) {
            var cData = ""; cRes.on("data", function(d) { cData += d; });
            cRes.on("end", function() { try { resolve(JSON.parse(cData)); } catch(e) { resolve({ error: cData }); } });
          });
          cr.on("error", reject);
          cr.write(payload); cr.end();
        });

        if (createResult.key) {
          var newKey   = createResult.key;
          var issueUrl = "https://" + CFGj.jira.host + "/browse/" + newKey;
          console.log("[jira-push] Créé : " + newKey);

          // Créer le lien Jira si un ticket parent est fourni
          var linked = false;
          if (body.parentKey) {
            try {
              // TEST teste une Story/Bug → type "Tests"
              // BUG/US liés → type "Relates"
              var linkTypeName = body.linkType || ((body.ticketType === "TEST") ? "Test" : "Relates");
              var linkPayload  = JSON.stringify({
                type:         { name: linkTypeName },
                inwardIssue:  { key: newKey },
                outwardIssue: { key: body.parentKey }
              });
              await new Promise(function(resolve) {
                var lr = https_j.request({
                  hostname: CFGj.jira.host,
                  path: "/rest/api/3/issueLink",
                  method: "POST",
                  headers: {
                    "Authorization": "Basic " + authj,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Content-Length": Buffer.byteLength(linkPayload)
                  }
                }, function(lRes) {
                  lRes.resume();
                  linked = lRes.statusCode < 300;
                  console.log("[jira-push] Lien " + linkTypeName + " → " + body.parentKey + " : " + lRes.statusCode);
                  resolve();
                });
                lr.on("error", function(e) { console.warn("[jira-push] Link err:", e.message); resolve(); });
                lr.write(linkPayload); lr.end();
              });
            } catch(le) { console.warn("[jira-push] Link exception:", le.message); }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key: newKey, url: issueUrl, linked: linked, parentKey: body.parentKey || null, ticketType: body.ticketType }));
        } else {
          var errMsg = (createResult.errors ? JSON.stringify(createResult.errors) : JSON.stringify(createResult)).substring(0, 200);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: errMsg }));
        }
      } catch(e) {
        console.error("[jira-push] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── API : Validation preview — génère payload sans pousser ──────────────────
  if (method === "POST" && url === "/api/validation/preview") {
    var vpChunks = [];
    req.on("data", function(c) { vpChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(vpChunks).toString());
        var sourceKey = body.sourceKey;
        if (!sourceKey) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "sourceKey requis" })); return; }

        // Lire ticket enrichi ou depuis Jira via Render
        var enrichedPath = path.join(BASE_DIR, "inbox", "enriched", sourceKey + ".json");
        var sourceTicket;
        if (fs.existsSync(enrichedPath)) {
          sourceTicket = JSON.parse(fs.readFileSync(enrichedPath, "utf8"));
        } else {
          // Fallback : fetch depuis Jira
          var CFGv = require("./config");
          var authV = Buffer.from(CFGv.jira.email + ":" + CFGv.jira.token).toString("base64");
          var ticketData = await new Promise(function(resolve, reject) {
            var tr = require("https").request({
              hostname: CFGv.jira.host,
              path: "/rest/api/2/issue/" + sourceKey + "?fields=summary,status,issuetype,priority,labels,description,fixVersions,customfield_10014",
              method: "GET",
              headers: { "Authorization": "Basic " + authV, "Accept": "application/json" }
            }, function(tRes) {
              var d = ""; tRes.on("data", function(c) { d += c; });
              tRes.on("end", function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
            });
            tr.on("error", reject); tr.end();
          });
          if (ticketData.errorMessages) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Ticket introuvable : " + sourceKey })); return; }
          sourceTicket = {
            key: ticketData.key,
            summary: ticketData.fields.summary,
            type: ticketData.fields.issuetype.name,
            status: (ticketData.fields.status || {}).name || "",
            priority: (ticketData.fields.priority || {}).name || "Medium",
            labels: ticketData.fields.labels || [],
            description: ticketData.fields.description || "",
            epic: (ticketData.fields.customfield_10014) || ""
          };
        }

        // Générer payload Jira + steps Xray
        var testResult = { status: "N/A", scenarios: [], duration: 0, browser: "chromium", url: "", epic: sourceTicket.epic || "" };
        var extPayload = leadQA.buildExternalJiraPayload(testResult, sourceTicket, { testType: body.testType || "Mix" });
        var validation = leadQA.validateJiraPayload(extPayload);
        var xraySteps  = await leadQA.buildXraySteps(sourceTicket);

        // Déterminer la release — source unique : settings.currentRelease
        var settingsV = {};
        try { settingsV = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); } catch(e) { console.error("[SERVER] Erreur lecture settings.json :", e.message); }
        var release = settingsV.currentRelease || "v1.25.0";

        // Détecter si un ticket TEST existe déjà pour ce sourceKey
        var existingTest = null;
        try {
          var CFGvp = require("./config");
          var authVP = Buffer.from(CFGvp.jira.email + ":" + CFGvp.jira.token).toString("base64");
          var sourceIssue = await new Promise(function(resolve, reject) {
            var sr = require("https").request({
              hostname: CFGvp.jira.host,
              path: "/rest/api/3/issue/" + sourceKey + "?fields=issuelinks",
              method: "GET",
              headers: { "Authorization": "Basic " + authVP, "Accept": "application/json" }
            }, function(sRes) {
              var d = ""; sRes.on("data", function(c) { d += c; });
              sRes.on("end", function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
            });
            sr.on("error", function() { resolve({}); }); sr.end();
          });
          var links = (sourceIssue.fields && sourceIssue.fields.issuelinks) || [];
          for (var li = 0; li < links.length; li++) {
            var lk = links[li];
            // Chercher un lien "Test" entrant (inwardIssue = ticket TEST)
            var linkedIssue = lk.inwardIssue || lk.outwardIssue;
            if (linkedIssue && linkedIssue.fields && linkedIssue.fields.issuetype) {
              var ltName = (linkedIssue.fields.issuetype.name || "").toLowerCase();
              if (ltName === "test" || ltName === "test case") {
                existingTest = { key: linkedIssue.key, summary: linkedIssue.fields.summary || "" };
                break;
              }
            }
          }
        } catch(e) { /* ignore — on proposera création */ }

        // Détecter Test Plan / Test Execution existants
        var planExecInfo = await findTestPlanExec(release);

        // Bibliothèque de Test — informatif uniquement (API non disponible sur Jira Cloud)
        var folderName = "Release " + release.replace(/^v/, "");
        var libraryFolder = { name: folderName, info: true };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          sourceKey: sourceKey,
          release: release,
          existingTest: existingTest,
          ticket: {
            summary:        extPayload.title || extPayload.fields.summary,
            descriptionADF: extPayload.fields.description,
            descriptionText: "Vérifier que la fonction « " + sourceTicket.summary + " » fonctionne correctement selon les critères d'acceptation de " + sourceKey + ".",
            issuetype:      (extPayload.fields.issuetype || {}).name || "Test",
            priority:       (sourceTicket.priority || "Medium"),
            labels:         extPayload.fields.labels || [],
            testType:       extPayload.testType || "Mix",
            parentKey:      sourceKey
          },
          xraySteps: xraySteps,
          validation: validation,
          source: sourceTicket,
          testPlan: planExecInfo.testPlan || { exists: false, willCreate: true, summary: "Plan de Test - Release " + release },
          testExec: planExecInfo.testExec || { exists: false, willCreate: true, summary: "Test Execution - Release " + release },
          library: libraryFolder
        }));
      } catch(e) {
        console.error("[validation/preview] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── API : Validation push — envoi séquentiel vers Jira + Xray ─────────────
  if (method === "POST" && url === "/api/validation/push") {
    var vxChunks = [];
    req.on("data", function(c) { vxChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(vxChunks).toString());
        var CFGp = require("./config");
        var authP = Buffer.from(CFGp.jira.email + ":" + CFGp.jira.token).toString("base64");
        var httpsP = require("https");
        var results = { steps: [] };

        function emitProgress(step, status, detail) {
          var evt = { type: "validation-progress", step: step, status: status };
          if (detail) evt.detail = detail;
          // Broadcast à tous les clients SSE connectés
          Object.keys(sseClients).forEach(function(cid) {
            sendSSE(cid, evt);
          });
          results.steps.push(evt);
        }

        // STEP 1 — Créer ou Mettre à jour ticket TEST dans Jira
        var updateMode = !!(body.existingTestKey);
        var newKey;

        if (updateMode) {
          // MODE UPDATE — mettre à jour le ticket existant
          newKey = body.existingTestKey;
          emitProgress("jira-create", "running", "Mise à jour " + newKey + "...");
          var updateFields = {
            summary:     body.ticket.summary,
            description: body.ticket.descriptionADF,
            priority:    { name: body.ticket.priority || "Medium" }
          };
          if (body.ticket.labels && body.ticket.labels.length) updateFields.labels = body.ticket.labels;

          var updatePayload = JSON.stringify({ fields: updateFields });
          var updateResult = await new Promise(function(resolve, reject) {
            var ur = httpsP.request({
              hostname: CFGp.jira.host, path: "/rest/api/3/issue/" + newKey, method: "PUT",
              headers: { "Authorization": "Basic " + authP, "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(updatePayload) }
            }, function(uRes) {
              var d = ""; uRes.on("data", function(c) { d += c; });
              uRes.on("end", function() { resolve({ statusCode: uRes.statusCode, body: d }); });
            });
            ur.on("error", reject);
            ur.write(updatePayload); ur.end();
          });

          if (updateResult.statusCode >= 300) {
            emitProgress("jira-create", "error", "Mise à jour échouée — HTTP " + updateResult.statusCode);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Mise à jour ticket échouée", results: results }));
            return;
          }

          // Supprimer les anciens CSV attachés (CAS-TEST-*.csv)
          try {
            var existingIssue = await new Promise(function(resolve, reject) {
              var er = httpsP.request({
                hostname: CFGp.jira.host, path: "/rest/api/3/issue/" + newKey + "?fields=attachment", method: "GET",
                headers: { "Authorization": "Basic " + authP, "Accept": "application/json" }
              }, function(eRes) {
                var d = ""; eRes.on("data", function(c) { d += c; });
                eRes.on("end", function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
              });
              er.on("error", function() { resolve({}); }); er.end();
            });
            var oldAttachments = (existingIssue.fields && existingIssue.fields.attachment || [])
              .filter(function(a) { return /^CAS-TEST-.*\.csv$/i.test(a.filename); });
            for (var ai = 0; ai < oldAttachments.length; ai++) {
              await new Promise(function(resolve) {
                var dr = httpsP.request({
                  hostname: CFGp.jira.host, path: "/rest/api/3/attachment/" + oldAttachments[ai].id, method: "DELETE",
                  headers: { "Authorization": "Basic " + authP }
                }, function(dRes) { dRes.resume(); resolve(); });
                dr.on("error", function() { resolve(); }); dr.end();
              });
              console.log("[validation/push] Ancien CSV supprimé : " + oldAttachments[ai].filename);
            }
          } catch(e) { /* ignore cleanup errors */ }

          emitProgress("jira-create", "done", newKey + " mis à jour");
        } else {
          // MODE CREATE — créer un nouveau ticket
          emitProgress("jira-create", "running");
          var fields = {
            project:     { key: CFGp.jira.project || "SAFWBST" },
            summary:     body.ticket.summary,
            description: body.ticket.descriptionADF,
            issuetype:   { name: body.ticket.issuetype || "Test" },
            priority:    { name: body.ticket.priority || "Medium" }
          };
          if (body.ticket.labels && body.ticket.labels.length) fields.labels = body.ticket.labels;

          var createPayload = JSON.stringify({ fields: fields });
          var createResult = await new Promise(function(resolve, reject) {
            var cr = httpsP.request({
              hostname: CFGp.jira.host, path: "/rest/api/3/issue", method: "POST",
              headers: { "Authorization": "Basic " + authP, "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(createPayload) }
            }, function(cRes) {
              var d = ""; cRes.on("data", function(c) { d += c; });
              cRes.on("end", function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({ error: d }); } });
            });
            cr.on("error", reject);
            cr.write(createPayload); cr.end();
          });

          if (!createResult.key) {
            emitProgress("jira-create", "error", (createResult.errors ? JSON.stringify(createResult.errors) : "Erreur création ticket").substring(0, 200));
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Création ticket échouée", results: results }));
            return;
          }
          newKey = createResult.key;
          emitProgress("jira-create", "done", newKey);
        }

        // STEP 2 — Lien avec ticket source (skip en mode update, le lien existe déjà)
        var linked = false;
        var linkError = "";
        if (updateMode) {
          linked = true;
          emitProgress("jira-link", "done", body.ticket.parentKey + " (lien existant)");
        } else if (body.ticket.parentKey) {
          emitProgress("jira-link", "running");
          try {
            var linkPayload = JSON.stringify({
              type: { name: "Test" },
              inwardIssue: { key: newKey },
              outwardIssue: { key: body.ticket.parentKey }
            });
            await new Promise(function(resolve) {
              var lr = httpsP.request({
                hostname: CFGp.jira.host, path: "/rest/api/3/issueLink", method: "POST",
                headers: { "Authorization": "Basic " + authP, "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(linkPayload) }
              }, function(lRes) {
                var ld = ""; lRes.on("data", function(c) { ld += c; });
                lRes.on("end", function() {
                  linked = lRes.statusCode < 300;
                  if (!linked) {
                    linkError = "HTTP " + lRes.statusCode + " : " + ld.substring(0, 300);
                    console.error("[validation/push] Lien " + newKey + " → " + body.ticket.parentKey + " échoué — " + linkError);
                  } else {
                    console.log("[validation/push] Lien Tests créé : " + newKey + " → " + body.ticket.parentKey);
                  }
                  resolve();
                });
              });
              lr.on("error", function(e) { linkError = "Network: " + e.message; console.error("[validation/push] Lien erreur réseau:", e.message); resolve(); });
              lr.write(linkPayload); lr.end();
            });
          } catch(e) { linkError = "Exception: " + e.message; console.error("[validation/push] Lien exception:", e.message); }
          emitProgress("jira-link", linked ? "done" : "error", linked ? body.ticket.parentKey : "Lien non créé" + (linkError ? " — " + linkError : ""));
        }

        // STEP 3 — Générer CSV cas de test + attacher au ticket Jira
        emitProgress("csv-export", "running");
        var csvAttached = false;
        var csvFileName = "";
        var stepsCount = (body.xraySteps || []).length;
        if (body.xraySteps && body.xraySteps.length) {
          try {
            // Générer le CSV — format Xray import
            var csvHeader = "\uFEFFAction,Données,Résultat Attendu";
            var csvRows = body.xraySteps.map(function(s) {
              var esc = function(v) { return '"' + (v || "").replace(/"/g, '""').replace(/,/g, ';') + '"'; };
              return esc(s.action) + "," + esc(s.data) + "," + esc(s.result);
            });
            var csvContent = csvHeader + "\n" + csvRows.join("\n");

            // Afficher le contenu CSV dans le terminal
            console.log("\n╔══════════════════════════════════════════════════════════════╗");
            console.log("║  CSV CAS DE TEST — " + newKey + " (" + body.xraySteps.length + " cas)");
            console.log("╠══════════════════════════════════════════════════════════════╣");
            console.log(csvContent);
            console.log("╚══════════════════════════════════════════════════════════════╝\n");

            // Sauver localement
            var csvDir = path.join(BASE_DIR, "inbox", "xray-pending");
            if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });
            csvFileName = "CAS-TEST-" + newKey + "-" + Date.now() + ".csv";
            var csvPath = path.join(csvDir, csvFileName);
            fs.writeFileSync(csvPath, csvContent, "utf8");

            // Attacher le CSV au ticket Jira
            attachFileToJira(newKey, csvPath);
            csvAttached = true;

            console.log("[validation/push] CSV " + csvFileName + " attaché sur " + newKey);
          } catch(csvErr) {
            console.error("[validation/push] CSV erreur:", csvErr.message);
          }
        }
        if (csvAttached) {
          emitProgress("csv-export", "done", csvFileName + " attaché — " + stepsCount + " cas de test prêts à importer dans Xray");
        } else if (!stepsCount) {
          emitProgress("csv-export", "done", "Aucun cas de test à exporter");
        } else {
          emitProgress("csv-export", "error", "Erreur lors de la génération du CSV");
        }

        // STEP 4 — Bibliothèque de Test (informatif)
        var release = body.release || "v1.25.0";
        var libFolderName = "Release " + release.replace(/^v/, "");
        emitProgress("xray-library", "done", libFolderName);

        // STEP 5 — Finalisation
        emitProgress("complete", "done", newKey);
        var issueUrl = "https://" + CFGp.jira.host + "/browse/" + newKey;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          key: newKey,
          url: issueUrl,
          linked: linked,
          linkError: linkError || null,
          csvAttached: csvAttached,
          csvFileName: csvFileName || null,
          stepsCount: stepsCount,
          results: results
        }));
      } catch(e) {
        console.error("[validation/push] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── API : Upload session storageState (cookies Cloudflare + Drupal) ──────────
  if (method === "POST" && /^\/api\/session\/[a-z-]+$/.test(url)) {
    var sessEnv = url.split("/").pop();
    var sessChunks = [];
    req.on("data", function(c) { sessChunks.push(c); });
    req.on("end", function() {
      try {
        var sessBody = JSON.parse(Buffer.concat(sessChunks).toString());
        // Accepte { cookies:[...] } ou storageState complet
        var authDir = path.join(BASE_DIR, "auth");
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        var sessFile = path.join(authDir, sessEnv + ".json");
        fs.writeFileSync(sessFile, JSON.stringify(sessBody, null, 2));
        console.log("[session] Saved auth/" + sessEnv + ".json (" + (sessBody.cookies || []).length + " cookies)");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, env: sessEnv, cookies: (sessBody.cookies || []).length }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (method === "GET" && /^\/api\/session\/[a-z-]+$/.test(url)) {
    var sessEnvG = url.split("/").pop();
    var sessFileG = path.join(BASE_DIR, "auth", sessEnvG + ".json");
    if (fs.existsSync(sessFileG)) {
      try {
        var sessData = JSON.parse(fs.readFileSync(sessFileG, "utf8"));
        var cookieCount = (sessData.cookies || []).length;
        var savedAt = fs.statSync(sessFileG).mtime.toISOString();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, env: sessEnvG, cookies: cookieCount, savedAt: savedAt }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Pas de session pour " + sessEnvG }));
    }
    return;
  }

  if (method === "POST" && url === "/api/drupal-suggest") {
    var dsChunks = [];
    req.on("data", function(c) { dsChunks.push(c); });
    req.on("end", async function() {
      try {
        var dsBody      = JSON.parse(Buffer.concat(dsChunks).toString());
        var dsContext   = (dsBody.context       || "").trim();
        var dsJiraKey   = (dsBody.jiraKey       || "").trim().toUpperCase();
        var dsImageB64  = dsBody.imageBase64    || null;
        var dsImageMime = dsBody.imageMediaType || "image/png";
        var jiraExtra   = "";

        // 1. RÃ©cupÃ©rer le ticket Jira si fourni
        if (dsJiraKey) {
          try {
            var dsAuth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
            var dsRaw  = await new Promise(function(ok, ko) {
              var r = require("https").request({
                hostname: CFG.jira.host,
                path: "/rest/api/2/issue/" + dsJiraKey + "?fields=summary,description,issuetype",
                method: "GET",
                headers: { "Authorization": "Basic " + dsAuth, "Accept": "application/json" }
              }, function(jr) { var d = ""; jr.on("data", function(c) { d += c; }); jr.on("end", function() { ok(d); }); });
              r.on("error", ko); r.end();
            });
            var dsParsed = JSON.parse(dsRaw);
            if (dsParsed.fields) {
              jiraExtra = "\n\nTicket Jira " + dsJiraKey + " (" + ((dsParsed.fields.issuetype || {}).name || "?") + ") :\n" +
                "Titre : " + (dsParsed.fields.summary || "") + "\n" +
                "Description : " + String(dsParsed.fields.description || "").slice(0, 600);
            }
          } catch(e) { jiraExtra = "\n(Ticket " + dsJiraKey + " non rÃ©cupÃ©rÃ©)"; }
        }

        // 2. Si image, obtenir une description textuelle via Vision
        var imageDesc = "";
        if (dsImageB64) {
          try { imageDesc = "\n\nCapture d'Ã©cran analysÃ©e :\n" + await leadQA.analyzeImage(dsImageB64, dsImageMime); }
          catch(e) { imageDesc = ""; }
        }

        // 3. Prompt de suggestion Drupal
        var fullCtx  = (dsContext || "") + jiraExtra + imageDesc;
        var dsPrompt =
          "Tu es un expert QA Drupal. SuggÃ¨re les donnÃ©es de test Ã  crÃ©er dans le BO Drupal.\n" +
          "Types disponibles : news, interview, event, company, commercial_sheet, contact, country, historical_event, question, newsletter\n\n" +
          "Contexte fourni :\n" + (fullCtx || "Aucun contexte spÃ©cifique") + "\n\n" +
          'RÃ©ponds UNIQUEMENT avec ce JSON (pas d\'explication) :\n' +
          '{"type":"news","subject":"sujet prÃ©cis adaptÃ© au contexte","count":3,"env":"sophie",' +
          '"rationale":"Une phrase expliquant pourquoi ce type et ce sujet"}';

        var suggestion = await leadQA.askJSON(dsPrompt);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(suggestion));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || "Erreur analyse IA" }));
      }
    });
    return;
  }

  // â"€â"€ API : Import Jira  —  ticket complet avec dÃ©pendances â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/jira-import") {
    var importBody = "";
    req.on("data", function(c) { importBody += c; });
    req.on("end", function() {
      var importKey = "";
      try { importKey = JSON.parse(importBody).key; } catch(e) { console.error("[SERVER] Erreur parse import body :", e.message); }
      if (!importKey) { res.writeHead(400); res.end(JSON.stringify({ error: "ClÃ© manquante" })); return; }

      var httpsJI = require("https");
      var authJI  = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
      var fields  = "summary,status,issuetype,assignee,labels,priority,description,issuelinks,fixVersions,comment,created,updated,parent,subtasks";
      var jiraJI  = httpsJI.request({
        hostname: CFG.jira.host,
        path: "/rest/api/3/issue/" + importKey + "?fields=" + fields,
        method: "GET",
        headers: { "Authorization": "Basic " + authJI, "Accept": "application/json" }
      }, function(jRes) {
        var raw = "";
        jRes.on("data", function(c) { raw += c; });
        jRes.on("end", function() {
          try {
            var issue = JSON.parse(raw);
            if (issue.errorMessages || issue.errors) {
              res.writeHead(404); res.end(JSON.stringify({ error: "Ticket introuvable : " + importKey })); return;
            }
            var f = issue.fields;

            // Extraire description texte brut + URLs depuis l'ADF Jira
            var descText = "";
            var adfUrls  = [];
            function walkADF(nodes) {
              if (!Array.isArray(nodes)) return;
              nodes.forEach(function(node) {
                if (node.type === "text") {
                  descText += (node.text || "") + " ";
                  // URLs dans les marks (liens hypertextes)
                  if (node.marks) node.marks.forEach(function(m) {
                    if (m.type === "link" && m.attrs && m.attrs.href) adfUrls.push(m.attrs.href);
                  });
                }
                if (node.type === "inlineCard" && node.attrs && node.attrs.url) adfUrls.push(node.attrs.url);
                if (node.content) walkADF(node.content);
                descText += node.type === "paragraph" || node.type === "heading" ? "\n" : "";
              });
            }
            if (f.description && f.description.content) {
              walkADF(f.description.content);
            }

            // Liens (dÃ©pendances)
            var links = (f.issuelinks || []).map(function(link) {
              var linked = link.inwardIssue || link.outwardIssue;
              if (!linked) return null;
              return {
                key:      linked.key,
                summary:  linked.fields ? linked.fields.summary : "",
                type:     linked.fields && linked.fields.issuetype ? linked.fields.issuetype.name : "?",
                status:   linked.fields && linked.fields.status    ? linked.fields.status.name    : "?",
                relation: link.type ? (link.inwardIssue ? link.type.inward : link.type.outward) : "liÃ© Ã "
              };
            }).filter(Boolean);

            // Sous-tÃ¢ches
            var subtasks = (f.subtasks || []).map(function(sub) {
              return { key: sub.key, summary: sub.fields.summary, type: "Sub-task",
                       status: sub.fields.status.name, relation: "sous-tÃ¢che" };
            });

            var ticketData = {
              key:     importKey,
              summary: f.summary || "",
              type:    f.issuetype ? f.issuetype.name : "Story",
              status:  f.status   ? f.status.name    : "Backlog",
              epic:    (f.parent  && f.parent.fields  ? f.parent.fields.summary : (f["customfield_10014"] || "")),
              priority: f.priority ? f.priority.name : "Medium",
              description: descText.trim(),
              links:   links.concat(subtasks),
              fixVersions: (f.fixVersions || []).map(function(v) { return v.name; }).join(", "),
              createdAt: f.created || new Date().toISOString(),
              score:   null,
              issues:  [],
              originalMarkdown: "# " + importKey + "  —  " + (f.summary || "") + "\n\n" +
                "**Type :** " + (f.issuetype ? f.issuetype.name : "Story") + "  \n" +
                "**Statut :** " + (f.status ? f.status.name : "") + "  \n" +
                "**PrioritÃ© :** " + (f.priority ? f.priority.name : "") + "  \n\n" +
                "## Description\n" + (descText.trim() || "_Aucune description_") + "\n\n" +
                (links.length > 0 ? "## DÃ©pendances\n" + links.map(function(l) {
                  return "- **" + l.key + "** (" + l.type + ")  —  " + l.summary + " [" + l.status + "]";
                }).join("\n") : ""),
              enrichedMarkdown: "",
              status: "pending",
              importedAt: new Date().toISOString()
            };
            ticketData.enrichedMarkdown = ticketData.originalMarkdown;

            // Extraire URLs : ADF links + URLs dans le texte brut
            var textUrls = leadQA.extractUrlsFromDescription(descText);
            var allUrls  = adfUrls.slice();
            textUrls.forEach(function(u) { if (!allUrls.includes(u)) allUrls.push(u); });
            ticketData.testUrls = allUrls;

            // Sauvegarder dans inbox/enriched/
            var EIMPORT_DIR = path.join(BASE_DIR, "inbox", "enriched");
            if (!fs.existsSync(EIMPORT_DIR)) fs.mkdirSync(EIMPORT_DIR, { recursive: true });
            fs.writeFileSync(path.join(EIMPORT_DIR, importKey + ".json"), JSON.stringify(ticketData, null, 2), "utf8");

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, key: importKey, type: ticketData.type, summary: ticketData.summary, links: links }));
          } catch(e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
      jiraJI.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      jiraJI.end();
    });
    return;
  }

  if (method === "GET" && url === "/api/reports") {
    var files = [];
    try {
      files = fs.readdirSync(REPORTS_DIR)
        .filter(function(f) { return f.match(/\.(md|xlsx|csv)$/); })
        .map(function(f) { var s = fs.statSync(path.join(REPORTS_DIR, f)); return { name: f, size: s.size, date: s.mtime }; })
        .sort(function(a, b) { return b.date - a.date; }).slice(0, 20);
    } catch(e) { console.error("[SERVER] Erreur listage rapports :", e.message); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }

  // Route /api/download/ dupliquée supprimée — voir la version unifiée plus haut

  if (method === "POST" && url === "/api/stop") {
    var b = ""; req.on("data", function(c) { b += c; });
    req.on("end", function() {
      try {
        var d = JSON.parse(b);
        if (runningProcs[d.agent]) { runningProcs[d.agent].kill(); delete runningProcs[d.agent]; }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(400); res.end(e.message); }
    });
    return;
  }

  if (method === "POST" && url === "/api/run") {
    var chunks = [];
    req.on("data", function(c) { chunks.push(c); });
    req.on("end", function() {
      var rawBody = Buffer.concat(chunks);
      var ctype   = req.headers["content-type"] || "";
      try {
        var params = {};
        if (ctype.includes("multipart/form-data")) {
          var boundary = ctype.split("boundary=")[1];
          if (boundary) params = parseMultipart(rawBody, boundary);
          if (params.xmlFile && params.xmlFile.data) {
            var xmlPath = path.join(UPLOADS_DIR, params.xmlFile.filename);
            fs.writeFileSync(xmlPath, params.xmlFile.data);
            params.xmlPath = xmlPath;
          }
        } else {
          params = JSON.parse(rawBody.toString());
        }

        var agent    = params.agent;
        var clientId = params.clientId || "default";

        switch(agent) {
          case "css-audit":
            var envs = params.envs || "";
            var cssArgs = ["agent-css-audit.js"].concat(envs && envs !== "all" ? envs.split(" ") : []);
            if (params.browsers) cssArgs.push("--browsers=" + params.browsers);
            if (params.devices) {
              var devsTmpFile = path.join(BASE_DIR, "uploads", ".css-devices-tmp.json");
              try { fs.writeFileSync(devsTmpFile, params.devices, "utf8"); cssArgs.push("--devices-file=" + devsTmpFile); } catch(e2) {}
            }
            if (params.urls) {
              // Ã‰crire les URLs dans un fichier temporaire pour Ã©viter toute
              // interprÃ©tation shell de & sur Windows (cmd.exe, shell:true)
              var urlsTmpFile = path.join(BASE_DIR, "uploads", ".css-urls-tmp.txt");
              var cleanUrlsTmp = params.urls
                .replace(/&[a-z0-9]+;?/gi, function(e) {
                  // DÃ©coder les entitÃ©s HTML connues, supprimer les autres
                  var map = { "&amp;":"&","&lt;":"","&gt;":"","&quot;":"","&#39;":"","&apos;":"" };
                  return map[e.toLowerCase()] !== undefined ? map[e.toLowerCase()] : "";
                })
                .replace(/['"[\]<>]/g, "")  // caractÃ¨res non valides dans les paths
                .trim();
              if (cleanUrlsTmp) {
                try { fs.writeFileSync(urlsTmpFile, cleanUrlsTmp, "utf8"); } catch(e2) {}
                cssArgs.push("--urls-file=" + urlsTmpFile);
              }
            }
            if (params.ticketKey) cssArgs.push("--key=" + params.ticketKey);
            runAgent(agent, "node", cssArgs, clientId);
            break;
          case "playwright":
            runAgent(agent, "node", ["agent-playwright-direct.js", "--mode=ui", "--source=text", "--text=" + (params.demand || "Tester la page d'accueil"), "--envs=" + (params.env || "sophie")], clientId);
            break;
          case "xray-pipeline":
            if (!params.xmlPath) { sendSSE(clientId, { type: "err", agent: agent, line: "Fichier XML manquant" }); break; }
            var localXml1 = path.join(BASE_DIR, "uploads", "ticket.xml");
            try { fs.copyFileSync(params.xmlPath, localXml1); } catch(e) { console.error("[SERVER] Erreur copie XML :", e.message); }
            var xArgs = ["agent-xray-full.js", "uploads/ticket.xml", "--env=" + (params.env || "sophie")];
            if (params.devices)      xArgs.push("--devices=" + params.devices);
            if (params.browsers)     xArgs.push("--browsers=" + params.browsers);
            if (params.testType)     xArgs.push("--testtype=" + params.testType);
            if (params.instructions) xArgs.push("--instructions=" + params.instructions);
            if (params.forceKey)     xArgs.push("--force-key=" + params.forceKey);
            runAgent(agent, "node", xArgs, clientId);
            break;

          case "playwright-multi":
            if (!params.xmlPath) { sendSSE(clientId, { type: "err", agent: agent, line: "Fichier XML manquant" }); break; }
            var localXmlPW = path.join(BASE_DIR, "uploads", "ticket.xml");
            try { fs.copyFileSync(params.xmlPath, localXmlPW); } catch(e) { console.error("[SERVER] Erreur copie XML :", e.message); }
            var pwArgs = ["agent-playwright-direct.js", "--mode=ui", "--source=xml", "--xml=uploads/ticket.xml"];
            if (params.envs)         pwArgs.push("--envs=" + params.envs);
            if (params.devices)      pwArgs.push("--devices-file=" + params.devices);
            if (params.browsers)     pwArgs.push("--browsers=" + params.browsers);
            if (params.instructions) pwArgs.push("--instructions=" + params.instructions);
            runAgent(agent, "node", pwArgs, clientId);
            break;
          case "jira-reader":
            if (!params.xmlPath) { sendSSE(clientId, { type: "err", agent: agent, line: "Fichier XML manquant" }); break; }
            var localXml2 = path.join(BASE_DIR, "uploads", "ticket.xml");
            try { fs.copyFileSync(params.xmlPath, localXml2); } catch(e) { console.error("[SERVER] Erreur copie XML :", e.message); }
            var rArgs = ["agent-jira-reader.js", "uploads/ticket.xml", "--env=" + (params.env || "sophie")];
            if (params.noPlaywright) rArgs.push("--no-playwright");
            runAgent(agent, "node", rArgs, clientId);
            break;
          case "matrix":
            var mArgs = ["agent-matrix.js", params.version || "v1.25.0"];
            if (params.output) mArgs.push("--output=" + params.output);
            runAgent(agent, "node", mArgs, clientId);
            break;
          case "drupal":
            var d2 = "Creer " + (params.count||"3") + " " + (params.type||"news") + " sur " + (params.subject||"l'aeronautique");
            var drupalArgs = ["agent-drupal.js", d2, params.env || "sophie"];
            if (params.ticketKey) drupalArgs.push("--key=" + params.ticketKey);
            runAgent(agent, "node", drupalArgs, clientId);
            break;
          case "drupal-audit":
            runAgent(agent, "node", ["agent-drupal-audit.js", params.env || "sophie"], clientId);
            break;
          case "generate-ticket":
            // Legacy — redirige vers le daily-job pipeline
            sendSSE(clientId, { type: "log", agent: agent, line: "Utilisez le pipeline automatique (daily-job) ou le chat IA pour générer des tickets" });
            sendSSE(clientId, { type: "done", agent: agent, code: 0 });
            break;
          case "update-ticket":
            var uKey     = params.key     || "";
            var uAction  = params.action  || "add-comment";
            var uContent = params.content || "";
            if (!uKey) { sendSSE(clientId, { type: "err", agent: "update-ticket", line: "ClÃ© ticket manquante" }); break; }
            var uArgs = ["agent-jira-update.js", uKey, "--action=" + uAction, "--content=" + uContent];
            runAgent("update-ticket", "node", uArgs, clientId);
            break;

          // â"€â"€ PLAYWRIGHT DIRECT (nouveau) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
          case "playwright-direct":
            // Normaliser envs : string JSON → tableau
            var pdEnvs = params.envs || [];
            if (typeof pdEnvs === "string") { try { pdEnvs = JSON.parse(pdEnvs); } catch(e) { pdEnvs = pdEnvs.split(","); } }
            if (!Array.isArray(pdEnvs)) pdEnvs = [pdEnvs];
            var pdArgs = [
              "agent-playwright-direct.js",
              "--mode="    + (params.mode    || "ui"),
              "--source="  + (params.source  || "url"),
              (pdEnvs.length > 1
                ? "--envs=" + pdEnvs.join(",")
                : "--env="  + (params.env || pdEnvs[0] || "sophie"))
            ];
            if (params.urls) {
              // Ã‰crire les URLs dans un fichier temporaire pour Ã©viter toute
              // interprÃ©tation shell de & sur Windows (cmd.exe, shell:true)
              var pdUrlsTmpFile = path.join(BASE_DIR, "uploads", ".pw-urls-tmp.txt");
              var cleanPdUrls = params.urls
                .replace(/&[a-z0-9]+;?/gi, function(e) {
                  var map = { "&amp;":"&","&lt;":"","&gt;":"","&quot;":"","&#39;":"","&apos;":"" };
                  return map[e.toLowerCase()] !== undefined ? map[e.toLowerCase()] : "";
                })
                .replace(/['"[\]<>]/g, "")
                .trim();
              if (cleanPdUrls) {
                try { fs.writeFileSync(pdUrlsTmpFile, cleanPdUrls, "utf8"); } catch(e2) {}
                pdArgs.push("--urls-file=" + pdUrlsTmpFile);
              }
            }
            if (params.key)      pdArgs.push("--key="      + params.key);
            if (params.text)     pdArgs.push("--text="     + params.text);
            if (params.devices)  pdArgs.push("--devices="  + params.devices);
            if (params.browsers) pdArgs.push("--browsers=" + params.browsers);
            if (params.steps)    pdArgs.push("--steps="    + params.steps);
            if (params.dryRun)      pdArgs.push("--dry-run");
            if (params.noJiraPush) pdArgs.push("--no-jira-push");
            // XML uploadÃ©
            if (params.xmlPath) {
              var pdXml = path.join(BASE_DIR, "uploads", "ticket.xml");
              try { fs.copyFileSync(params.xmlPath, pdXml); } catch(e) { console.error("[SERVER] Erreur copie XML :", e.message); }
              pdArgs.push("--xml=uploads/ticket.xml");
            }
            var pdClientId = clientId;
            var pdParams   = params;
            runAgent("playwright-direct", "node", pdArgs, clientId, params.dryRun || false, {
              bufferLogs: true,
              onDone: function(exitCode, logs) {
                // Extraire le rÃ©sultat JSON Ã©mis par agent-playwright-direct.js
                var rLine = logs.find(function(l) { return l.startsWith("PLAYWRIGHT_DIRECT_RESULT:"); });
                if (!rLine) return;
                var result;
                try { result = JSON.parse(rLine.replace("PLAYWRIGHT_DIRECT_RESULT:", "")); }
                catch(e) { return; }
                result.mode      = result.mode      || pdParams.mode    || "ui";
                result.env       = result.env       || pdParams.env     || "sophie";
                result.source    = result.source    || pdParams.source  || "url";
                result.ticketKey = result.ticketKey || pdParams.key     || null;
                result.runDate   = new Date().toISOString();

                function broadcastReport(resultObj, diag) {
                  var evt = { type: "playwright-report-ready", result: resultObj };
                  if (diag) evt.diagnostic = diag;
                  sendSSE(pdClientId, evt);
                  if (pdClientId !== "default") sendSSE("default", evt);
                }

                // Toujours �crire le diag.json (PASS = minimal, FAIL = avec diagnostic IA)
                function saveDiag(diagContent) {
                  if (!result.reportPath) return;
                  var dName = path.basename(result.reportPath).replace(".html", "-diag.json");
                  try { fs.writeFileSync(path.join(BASE_DIR, "reports", dName), JSON.stringify(diagContent, null, 2), "utf8"); } catch(e) { console.error("[SERVER] Erreur ecriture diag :", e.message); }
                }
                // Capturer les logs de tests FAIL → inbox/logs/
                var logLines2 = logs.filter(function(l) { return l.startsWith("PLAYWRIGHT_TEST_LOG:"); });
                if (logLines2.length > 0) {
                  var logsDir2 = path.join(BASE_DIR, "inbox", "logs");
                  if (!fs.existsSync(logsDir2)) { try { fs.mkdirSync(logsDir2, { recursive: true }); } catch(e) { console.error("[SERVER] Erreur creation logsDir :", e.message); } }
                  logLines2.forEach(function(line) {
                    try {
                      var logData2 = JSON.parse(line.replace("PLAYWRIGHT_TEST_LOG:", ""));
                      var logId2   = (logData2.ticketKey || "NO-KEY") + "-" + Date.now();
                      var logFile2 = path.join(logsDir2, logId2 + ".json");
                      fs.writeFileSync(logFile2, JSON.stringify(Object.assign({ id: logId2 }, logData2), null, 2), "utf8");
                      sendSSE(pdClientId,  { type: "test-log-new", log: Object.assign({ id: logId2 }, logData2) });
                      if (pdClientId !== "default") sendSSE("default", { type: "test-log-new", log: Object.assign({ id: logId2 }, logData2) });
                    } catch(e) { console.error("[SERVER] Erreur traitement test-log :", e.message); }
                  });
                }

                if (result.fail > 0) {
                  leadQA.analyzePlaywrightFail(logs, result).then(function(diag) {
                    saveDiag({ result: result, diagnostic: diag, generatedAt: new Date().toISOString() });
                    broadcastReport(result, diag);
                  }).catch(function() {
                    saveDiag({ result: result, generatedAt: new Date().toISOString() });
                    broadcastReport(result, null);
                  });
                } else {
                  saveDiag({ result: result, generatedAt: new Date().toISOString() });
                  broadcastReport(result, null);
                }
              }
            });
            break;

          case "postman":
            var postmanMode = params.mode || "generate";
            var postmanSource = params.source || "text";
            runAgent("postman", "node", ["agent-postman.js", postmanMode, postmanSource], clientId);
            break;
          case "appium":
            var appiumMode = params.mode || "generate";
            var appiumSource = params.source || "text";
            runAgent("appium", "node", ["agent-appium.js", appiumMode, appiumSource], clientId);
            break;
          default:
            sendSSE(clientId, { type: "err", agent: agent, line: "Agent inconnu : " + agent });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, agent: agent }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // â"€â"€ API : LLM Router  —  IA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/route") {
    var routeChunks = [];
    req.on("data", function(c) { routeChunks.push(c); });
    req.on("end", function() {
      var routeBody = "";
      try {
        routeBody = Buffer.concat(routeChunks).toString();
        var routeParams = JSON.parse(routeBody);

        var demand  = routeParams.demand  || "";
        var context = routeParams.context || "";
        var env     = routeParams.env     || "sophie";
        var mode    = routeParams.mode    || "ASSISTED";

        if (!demand) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "demand manquante" }));
          return;
        }

        router.route(demand, context, env, mode).then(function(plan) {
          // Mode AUTO : enchaÃ®ner les agents sÃ©quentiellement
          if (mode === "AUTO" && plan.selectedAgents && plan.selectedAgents.length > 0) {
            var clientId = routeParams.clientId || "router-auto";
            sendSSE(clientId, { type: "log", agent: "router", line: "[ROUTER AUTO] DÃ©marrage sÃ©quence : " + plan.selectedAgents.join(" â†’ ") });

            // Lancement sÃ©quentiel via Promise chain
            var seq = Promise.resolve();
            plan.selectedAgents.forEach(function(agentName) {
              seq = seq.then(function() {
                return new Promise(function(seqResolve) {
                  sendSSE(clientId, { type: "log", agent: "router", line: "[AUTO] Lancement : " + agentName });
                  var agentArgs = buildAgentArgs(agentName, routeParams);
                  if (agentArgs === null) {
                    sendSSE(clientId, { type: "warn", agent: "router", line: "[AUTO] Agent ignorÃ© (args manquants) : " + agentName });
                    seqResolve();
                    return;
                  }
                  // Attendre la fin de l'agent via l'Ã©vÃ©nement done
                  var origSend = sendSSE;
                  runAgent(agentName, "node", agentArgs, clientId, routeParams.dryRun || false);
                  // Polling sur agentLocks pour savoir quand l'agent est terminÃ©
                  var poll = setInterval(function() {
                    if (!agentLocks[agentName]) { clearInterval(poll); seqResolve(); }
                  }, 500);
                });
              });
            });

            seq.then(function() {
              sendSSE(clientId, { type: "done", agent: "router", code: 0 });
            }).catch(function(e) {
              sendSSE(clientId, { type: "err", agent: "router", line: "[AUTO] Erreur sÃ©quence : " + e.message });
            });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, plan: plan }));

        }).catch(function(e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });

      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "JSON invalide : " + e.message }));
      }
    });
    return;
  }

  // â"€â"€ API : Attacher des fichiers locaux Ã  un ticket Jira â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url.startsWith("/api/attach-jira/")) {
    var ajKey = url.replace("/api/attach-jira/", "").split("/")[0];
    var ajDir = path.join(BASE_DIR, "inbox", "enriched", "attachments", ajKey);
    if (!fs.existsSync(ajDir)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, attached: 0, msg: "Aucun fichier Ã  attacher" }));
      return;
    }

    var ajFiles = fs.readdirSync(ajDir);
    if (!ajFiles.length) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, attached: 0 }));
      return;
    }

    var ajAuth   = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var ajHttps  = require("https");
    var attached = 0;
    var errors   = [];

    function attachNextFile(idx) {
      if (idx >= ajFiles.length) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, attached: attached, errors: errors }));
        return;
      }
      var fname   = ajFiles[idx];
      var fpath   = path.join(ajDir, fname);
      var fdata   = fs.readFileSync(fpath);
      var ext     = fname.split(".").pop().toLowerCase();
      var mimeMap = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif",
                      webp:"image/webp", html:"text/html", txt:"text/plain", md:"text/plain",
                      pdf:"application/pdf", csv:"text/csv" };
      var fmime   = mimeMap[ext] || "application/octet-stream";
      var boundary = "----QABoundary" + Date.now();
      var CRLF = "\r\n";

      var headerPart = Buffer.from(
        "--" + boundary + CRLF +
        "Content-Disposition: form-data; name=\"file\"; filename=\"" + fname + "\"" + CRLF +
        "Content-Type: " + fmime + CRLF + CRLF
      );
      var footerPart = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
      var body = Buffer.concat([headerPart, fdata, footerPart]);

      var ajReq = ajHttps.request({
        hostname: CFG.jira.host,
        path: "/rest/api/3/issue/" + ajKey + "/attachments",
        method: "POST",
        headers: {
          "Authorization": "Basic " + ajAuth,
          "X-Atlassian-Token": "no-check",
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          "Content-Length": body.length
        }
      }, function(ajRes) {
        var ajRaw = "";
        ajRes.on("data", function(c) { ajRaw += c; });
        ajRes.on("end", function() {
          if (ajRes.statusCode < 300) {
            attached++;
          } else {
            errors.push(fname + " : HTTP " + ajRes.statusCode);
          }
          attachNextFile(idx + 1);
        });
      });
      ajReq.on("error", function(e) { errors.push(fname + " : " + e.message); attachNextFile(idx + 1); });
      ajReq.write(body);
      ajReq.end();
    }
    attachNextFile(0);
    return;
  }

  if (method === "GET" && url === "/api/jira-activity") {
    var https3   = require("https");
    var auth3    = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var jql3     = "project = " + CFG.jira.project +
      " AND assignee = currentUser() ORDER BY updated DESC";
    var search3  = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql3) +
      "&fields=summary,status,issuetype,priority,updated&maxResults=50";
    var jiraReq3 = https3.request({
      hostname: CFG.jira.host, path: search3, method: "GET",
      headers: { "Authorization": "Basic " + auth3, "Accept": "application/json" }
    }, function(jiraRes3) {
      var data3 = "";
      jiraRes3.on("data", function(c) { data3 += c; });
      jiraRes3.on("end", function() {
        try {
          var parsed3 = JSON.parse(data3);
          var items = (parsed3.issues || []).map(function(i) {
            return {
              key:     i.key,
              summary: i.fields.summary,
              status:  i.fields.status.name,
              type:    i.fields.issuetype.name,
              priority: i.fields.priority ? i.fields.priority.name : "Medium",
              updated: i.fields.updated
            };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(items));
        } catch(e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("[]");
        }
      });
    });
    jiraReq3.on("error", function() {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });
    jiraReq3.setTimeout(8000, function() { jiraReq3.destroy(); res.writeHead(504); res.end("{}"); });
    jiraReq3.end();
    return;
  }

  // â"€â"€ API : RÃ©ception SSE depuis agent-jira-queue â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/queue-sse") {
    var qsseChunks = [];
    req.on("data", function(c) { qsseChunks.push(c); });
    req.on("end", function() {
      try {
        var qsseBody  = JSON.parse(Buffer.concat(qsseChunks).toString());
        var qclientId = qsseBody.clientId || "queue";
        var qdata     = qsseBody.data     || {};
        sendSSE(qclientId, qdata);
        if (qclientId !== "default") sendSSE("default", qdata);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // â"€â"€ API : Liste des rapports (Playwright Direct + Audit CSS) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "GET" && url === "/api/playwright-reports") {
    try {
      var rDir   = path.join(BASE_DIR, "reports");
      var rFiles = fs.existsSync(rDir) ? fs.readdirSync(rDir) : [];

      // â"€â"€ Rapports Playwright Direct â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      var pwReports = rFiles
        .filter(function(f) { return /^RAPPORT-(OK|FAIL)-PW-DIRECT-.*\.html$/.test(f); })
        .map(function(f) {
          var stat     = fs.statSync(path.join(rDir, f));
          var parts    = f.replace(".html","").split("-");
          var status   = parts[1] || "?";
          var modeIdx  = parts.indexOf("PW") + 3;
          var mode     = parts[modeIdx] || "?";
          var diagFile = f.replace(".html", "-diag.json");
          var diag     = null;
          if (fs.existsSync(path.join(rDir, diagFile))) {
            try { diag = JSON.parse(fs.readFileSync(path.join(rDir, diagFile), "utf8")); }
            catch(e) { console.error("[SERVER] Erreur parse diag.json :", e.message); }
          }
          // Extraire la clé ticket : depuis diag.json en priorité, sinon depuis le nom de fichier
          var ticketKey = (diag && diag.result && diag.result.ticketKey) || null;
          if (!ticketKey) { var km = f.match(/-([A-Z]+-\d+)\.html$/i); if (km) ticketKey = km[1].toUpperCase(); }
          return {
            filename:   f,
            type:       "playwright",
            status:     status,
            mode:       (diag && diag.result && diag.result.mode) || mode.replace(/COMPARE/,"").replace(/^-/,"") || mode,
            isCompare:  f.includes("-COMPARE-"),
            date:       stat.mtime,
            size:       stat.size,
            ticketKey:  ticketKey,
            diagnostic: diag ? diag.diagnostic : null,
            result:     diag ? diag.result     : null
          };
        });

      // â"€â"€ Rapports Audit CSS â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
      var cssReports = rFiles
        .filter(function(f) { return /^AUDIT-CSS-.*\.md$/.test(f); })
        .map(function(f) {
          var stat = fs.statSync(path.join(rDir, f));
          // Parser le MD pour extraire les scores par env
          var scores = {};   // { sophie: 8, paulo: 67, prod: 67 }
          var pages  = 0;
          var envs   = [];
          try {
            var lines = fs.readFileSync(path.join(rDir, f), "utf8").split("\n");
            lines.forEach(function(l) {
              // Ligne de score : "[X] SOPHIE : 8% moyen" ou "[OK] PROD : 95% moyen"
              var sm = l.match(/\[(X|OK|~)\]\s+([A-Z]+)\s*:\s*(\d+)%/i);
              if (sm) {
                var env = sm[2].toLowerCase();
                scores[env] = parseInt(sm[3]);
                envs.push(env);
              }
              // Compter les lignes de tableau (pages)
              if (l.match(/^\|\s*[a-z]+\s*\|/i)) pages++;
            });
          } catch(e2) {}
          // DÃ©terminer le statut global : OK si tous les scores >= 80%
          var scoreValues = Object.values ? Object.values(scores) : Object.keys(scores).map(function(k){return scores[k];});
          var minScore    = scoreValues.length ? Math.min.apply(null, scoreValues) : 0;
          var avgScore    = scoreValues.length ? Math.round(scoreValues.reduce(function(s,v){return s+v;},0) / scoreValues.length) : 0;
          var status      = minScore >= 80 ? "OK" : "FAIL";
          // Extraire les envs du nom de fichier si pas trouvÃ©s dans le contenu
          if (!envs.length) {
            var nameParts = f.replace(/^AUDIT-CSS-[^-]+-/, "").replace(/-\d+\.md$/, "");
            envs = nameParts.split("-").filter(function(p) { return /^(sophie|paulo|prod)$/i.test(p); });
          }
          return {
            filename:   f,
            type:       "css",
            status:     status,
            mode:       "CSS",
            isCompare:  envs.length > 1,
            envs:       envs,
            scores:     scores,
            avgScore:   avgScore,
            pages:      pages,
            date:       stat.mtime,
            size:       stat.size
          };
        });

      var rList = pwReports.concat(cssReports)
        .sort(function(a, b) { return new Date(b.date) - new Date(a.date); })
        .slice(0, 80);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rList));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
    return;
  }

  // ── API : Liste des logs de tests ──────────────────────────────────────────
  if (method === "GET" && url === "/api/test-logs") {
    var tlDir = path.join(BASE_DIR, "inbox", "logs");
    if (!fs.existsSync(tlDir)) { res.writeHead(200, { "Content-Type": "application/json" }); res.end("[]"); return; }
    var tlFiles = fs.readdirSync(tlDir).filter(function(f) { return f.endsWith(".json"); })
      .sort().reverse().slice(0, 100);
    var tlItems = tlFiles.map(function(f) {
      try { return JSON.parse(fs.readFileSync(path.join(tlDir, f), "utf8")); } catch(e) { return null; }
    }).filter(Boolean);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(tlItems));
    return;
  }

  // ── API : Détail d'un log ──────────────────────────────────────────────────
  if (method === "GET" && url.startsWith("/api/test-logs/") && !url.endsWith("/push-jira")) {
    var tlId = decodeURIComponent(url.replace("/api/test-logs/", ""));
    if (tlId.includes("..")) { res.writeHead(400); res.end("Invalid"); return; }
    var tlPath = path.join(BASE_DIR, "inbox", "logs", tlId + ".json");
    if (!fs.existsSync(tlPath)) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found" })); return; }
    try { res.writeHead(200, { "Content-Type": "application/json" }); res.end(fs.readFileSync(tlPath, "utf8")); }
    catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── API : Supprimer un log ─────────────────────────────────────────────────
  if (method === "DELETE" && url.startsWith("/api/test-logs/") && !url.endsWith("/push-jira")) {
    var dlId = decodeURIComponent(url.replace("/api/test-logs/", ""));
    if (dlId.includes("..")) { res.writeHead(400); res.end("Invalid"); return; }
    var dlPath = path.join(BASE_DIR, "inbox", "logs", dlId + ".json");
    try { if (fs.existsSync(dlPath)) fs.unlinkSync(dlPath); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); }
    catch(e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // ── API : Intégrer log dans Jira (commentaire) ─────────────────────────────
  if (method === "POST" && url.match(/^\/api\/test-logs\/[^/]+\/push-jira$/)) {
    var pjId     = decodeURIComponent(url.replace("/api/test-logs/", "").replace("/push-jira", ""));
    var pjChunks = []; req.on("data", function(c) { pjChunks.push(c); });
    req.on("end", async function() {
      try {
        var body    = JSON.parse(Buffer.concat(pjChunks).toString() || "{}");
        var pjPath  = path.join(BASE_DIR, "inbox", "logs", pjId + ".json");
        var logItem = JSON.parse(fs.readFileSync(pjPath, "utf8"));
        var jiraKey = body.jiraKey || logItem.ticketKey;
        if (!jiraKey) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Clé Jira manquante" })); return; }

        var CFGpj  = require("./config");
        var authpj = Buffer.from(CFGpj.jira.email + ":" + CFGpj.jira.token).toString("base64");
        var https_pj = require("https");

        // Construire le commentaire Jira (wiki markup)
        var sections = body.sections || {};  // { jsExceptions, consoleErrors, networkFails, domSnippets, steps }
        var comment  = "h3. 🔬 Rapport de test — " + logItem.testLabel + "\n";
        comment += "*Date* : " + new Date(logItem.timestamp).toLocaleString("fr-FR") +
          " | *Env* : " + (logItem.env||"?") +
          " | *Browser* : " + (logItem.browser||"?") +
          " | *Device* : " + (logItem.device||"?") + "\n";
        comment += "*URL* : " + logItem.url + "\n\n";

        // Étapes FAIL
        var steps = sections.steps !== undefined ? sections.steps : (logItem.steps||[]);
        if (steps && steps.length) {
          comment += "h3. ❌ Étapes en échec\n{noformat}\n";
          steps.forEach(function(s) { comment += "❌ " + s.label + " : " + (s.detail||"") + (s.selector ? " [" + s.selector + "]" : "") + "\n"; });
          comment += "{noformat}\n\n";
        }

        // JS Exceptions
        var jsEx = sections.jsExceptions !== undefined ? sections.jsExceptions : (logItem.jsExceptions||[]);
        if (jsEx && jsEx.length) {
          comment += "h3. ⚡ Exceptions JavaScript\n";
          jsEx.forEach(function(ex, i) {
            comment += "*Exception " + (i+1) + "* : " + ex.message + "\n";
            if (ex.stack) comment += "{noformat:title=Stack trace}\n" + ex.stack + "\n{noformat}\n";
          });
          comment += "\n";
        }

        // Console errors
        var ceList = sections.consoleErrors !== undefined ? sections.consoleErrors : (logItem.consoleErrors||[]);
        if (ceList && ceList.length) {
          comment += "h3. 🖥️ Erreurs Console\n{noformat}\n";
          ceList.forEach(function(ce) {
            var loc = ce.file ? "[" + ce.file + (ce.line != null ? ":" + ce.line : "") + "]  " : "";
            comment += loc + ce.text + "\n";
          });
          comment += "{noformat}\n\n";
        }

        // Network fails
        var nfList = sections.networkFails !== undefined ? sections.networkFails : (logItem.networkFails||[]);
        if (nfList && nfList.length) {
          comment += "h3. 🌐 Requêtes KO\n{noformat}\n";
          nfList.forEach(function(nf) { comment += nf.method + "  " + nf.status + "  " + nf.url + "\n"; });
          comment += "{noformat}\n\n";
        }

        // DOM snippets
        var domList = sections.domSnippets !== undefined ? sections.domSnippets : (logItem.domSnippets||[]);
        if (domList && domList.length) {
          comment += "h3. 🔍 Contexte DOM\n";
          domList.forEach(function(ds) {
            comment += "*" + ds.label + "* — {{" + ds.selector + "}}";
            if (!ds.visible) comment += " — *ABSENT / CACHÉ*";
            comment += "\n{noformat}\n" + ds.outerHTML + "\n{noformat}\n";
          });
          comment += "\n";
        }

        comment += "_QA_";

        // POST commentaire Jira
        var commentPayload = JSON.stringify({ body: comment });
        var commentResult  = await new Promise(function(resolve, reject) {
          var cr = https_pj.request({
            hostname: CFGpj.jira.host,
            path:     "/rest/api/2/issue/" + jiraKey + "/comment",
            method:   "POST",
            headers: {
              "Authorization":  "Basic " + authpj,
              "Content-Type":   "application/json",
              "Accept":         "application/json",
              "Content-Length": Buffer.byteLength(commentPayload)
            }
          }, function(cRes) {
            var cData = ""; cRes.on("data", function(d) { cData += d; });
            cRes.on("end", function() { resolve({ status: cRes.statusCode, body: cData }); });
          });
          cr.on("error", reject);
          cr.write(commentPayload); cr.end();
        });

        if (commentResult.status < 300) {
          // Marquer le log comme intégré
          logItem.pushedToJira = jiraKey;
          logItem.pushedAt     = new Date().toISOString();
          fs.writeFileSync(pjPath, JSON.stringify(logItem, null, 2), "utf8");
          console.log("[test-log] Intégré dans " + jiraKey);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, jiraKey: jiraKey }));
        } else {
          var errBody = commentResult.body.substring(0, 200);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Jira " + commentResult.status + " : " + errBody }));
        }
      } catch(e) {
        console.error("[test-log] Erreur push-jira:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // â"€â"€ API : Supprimer un rapport Playwright â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "DELETE" && url.startsWith("/api/delete-report/")) {
    var drFname = decodeURIComponent(url.replace("/api/delete-report/", ""));
    if (!/^RAPPORT-(OK|FAIL)-PW-DIRECT-.*\.html$/.test(drFname) && !/^AUDIT-CSS-.*\.md$/.test(drFname)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Fichier non autorisÃ©" }));
      return;
    }
    var drPath = path.join(REPORTS_DIR, drFname);
    var drDiag = path.join(REPORTS_DIR, drFname.replace(".html", "-diag.json"));
    try {
      if (fs.existsSync(drPath)) fs.unlinkSync(drPath);
      if (fs.existsSync(drDiag)) fs.unlinkSync(drDiag);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // â"€â"€ API : Attacher un rapport HTML Ã  un ticket Jira â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/attach-report-jira") {
    var arChunks = [];
    req.on("data", function(c) { arChunks.push(c); });
    req.on("end", function() {
      try {
        var arBody2   = JSON.parse(Buffer.concat(arChunks).toString());
        var arFname   = arBody2.filename || "";
        var arJiraKey = (arBody2.jiraKey || "").trim().toUpperCase();
        if (!/^RAPPORT-(OK|FAIL)-PW-DIRECT-.*\.(html|pdf)$/.test(arFname) && !/^RAPPORT-(OK|FAIL)-.*\.(html|pdf)$/.test(arFname) && !/^AUDIT-CSS-.*\.md$/.test(arFname)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fichier non autoris\u00e9" })); return;
        }
        if (!/^[A-Z]+-\d+$/.test(arJiraKey)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Cl\u00e9 Jira invalide (ex : SAFE-1234)" })); return;
        }
        // Si HTML fourni, préférer le PDF correspondant s'il existe
        var arPath2 = path.join(REPORTS_DIR, arFname);
        if (/\.html$/.test(arFname)) {
          var pdfAlt = arFname.replace(/\.html$/, ".pdf");
          var pdfAltPath = path.join(REPORTS_DIR, pdfAlt);
          if (fs.existsSync(pdfAltPath)) { arFname = pdfAlt; arPath2 = pdfAltPath; }
        }
        if (!fs.existsSync(arPath2)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fichier introuvable" })); return;
        }
        var fdata2     = fs.readFileSync(arPath2);
        var arAuth2    = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
        var arHttps    = require("https");
        var arBoundary = "----QABoundary" + Date.now();
        var CRLF2      = "\r\n";
        var arMime     = /\.pdf$/i.test(arFname) ? "application/pdf" : /\.md$/i.test(arFname) ? "text/markdown" : "text/html";
        var hPart2     = Buffer.from("--" + arBoundary + CRLF2 + 'Content-Disposition: form-data; name="file"; filename="' + arFname + '"' + CRLF2 + "Content-Type: " + arMime + CRLF2 + CRLF2);
        var fPart2     = Buffer.from(CRLF2 + "--" + arBoundary + "--" + CRLF2);
        var arPayload  = Buffer.concat([hPart2, fdata2, fPart2]);

        var arReq = arHttps.request({
          hostname: CFG.jira.host,
          path: "/rest/api/3/issue/" + arJiraKey + "/attachments",
          method: "POST",
          headers: {
            "Authorization": "Basic " + arAuth2,
            "X-Atlassian-Token": "no-check",
            "Content-Type": "multipart/form-data; boundary=" + arBoundary,
            "Content-Length": arPayload.length
          }
        }, function(arRes) {
          var arRaw2 = "";
          arRes.on("data", function(c) { arRaw2 += c; });
          arRes.on("end", function() {
            res.writeHead(200, { "Content-Type": "application/json" });
            if (arRes.statusCode < 300) res.end(JSON.stringify({ ok: true, key: arJiraKey }));
            else res.end(JSON.stringify({ error: "Jira HTTP " + arRes.statusCode + "  —  " + arRaw2.slice(0, 200) }));
          });
        });
        arReq.on("error", function(e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
        arReq.write(arPayload);
        arReq.end();
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // â"€â"€ API : Logs router â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "GET" && url === "/api/router-log") {
    var logPath = path.join(BASE_DIR, "reports", "router-log.jsonl");
    if (fs.existsSync(logPath)) {
      var lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      var entries = lines.map(function(l) { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries.slice(-50))); // 50 derniÃ¨res entrÃ©es
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
    return;
  }

  // â"€â"€ API : Appliquer un correctif proposÃ© par l'auto-debug â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/apply-fix") {
    var afixChunks = [];
    req.on("data", function(c) { afixChunks.push(c); });
    req.on("end", function() {
      try {
        var afixBody = JSON.parse(Buffer.concat(afixChunks).toString());
        var afixFile    = afixBody.file    || "";
        var afixOldCode = afixBody.oldCode || "";
        var afixNewCode = afixBody.newCode || "";

        // SÃ©curitÃ© : uniquement les .js du rÃ©pertoire projet
        if (!afixFile.startsWith(BASE_DIR) || !afixFile.endsWith(".js")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fichier non autorisÃ©" })); return;
        }
        if (!fs.existsSync(afixFile)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fichier introuvable" })); return;
        }
        if (!afixOldCode) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "oldCode manquant" })); return;
        }

        var afixContent = fs.readFileSync(afixFile, "utf8");
        if (!afixContent.includes(afixOldCode)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Code source introuvable dans le fichier (peut-Ãªtre dÃ©jÃ  corrigÃ© ?)" })); return;
        }

        // Backup + Ã©criture
        fs.writeFileSync(afixFile + ".bak", afixContent, "utf8");
        var afixFixed = afixContent.replace(afixOldCode, afixNewCode);
        fs.writeFileSync(afixFile, afixFixed, "utf8");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, file: path.basename(afixFile) }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/settings  —  lecture settings.json (+ infos config non-sensibles)
  if (method === "GET" && url === "/api/settings") {
    var settingsFile = path.join(BASE_DIR, "settings.json");
    try {
      var settingsData = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      settingsData.jiraHost    = CFG.jira.host;
      settingsData.jiraProject = CFG.jira.project;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(settingsData));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Impossible de lire settings.json : " + e.message }));
    }
    return;
  }

  // PUT /api/settings  —  Ã©criture settings.json
  if (method === "PUT" && url === "/api/settings") {
    var settingsFile2 = path.join(BASE_DIR, "settings.json");
    var settingsBody = "";
    req.on("data", function(c) { settingsBody += c; });
    req.on("end", function() {
      try {
        var parsed = JSON.parse(settingsBody);
        fs.writeFileSync(settingsFile2, JSON.stringify(parsed, null, 2), "utf8");
        // RedÃ©marrer le poller et le cron avec les nouveaux paramÃ¨tres
        poller.restart(parsed, sendSSE);
        cycle.stopCron();
        cycle.startCron(sendSSE, runAgent, function() {
          try { return JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); } catch(e) { return {}; }
        }, leadQA);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "JSON invalide : " + e.message }));
      }
    });
    return;
  }

  // GET /api/cycle/state  —  Ã©tat des 3 cycles
  if (method === "GET" && url === "/api/cycle/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cycle.getState()));
    return;
  }

  // POST /api/cycle/tnr  —  dÃ©clencher TNR Complet manuellement
  if (method === "POST" && url === "/api/cycle/tnr") {
    try {
      var tnrSettings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8"));
      cycle.triggerTNRComplet(tnrSettings, "default");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/cycle/tnr-release  —  dÃ©clencher TNR par release
  if (method === "POST" && url === "/api/cycle/tnr-release") {
    var tnrReleaseBody = "";
    req.on("data", function(c) { tnrReleaseBody += c; });
    req.on("end", function() {
      try {
        var tnrReleaseParams  = JSON.parse(tnrReleaseBody);
        var tnrReleaseVersion = tnrReleaseParams.release || "v1.25.0";
        var tnrReleaseSettings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8"));
        var ok = cycle.triggerTNRRelease(tnrReleaseVersion, tnrReleaseSettings, "default", runAgent, sendSSE);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: ok }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/cycle/history  —  historique des runs
  if (method === "GET" && url === "/api/cycle/history") {
    var history = cycle.getHistory();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(history));
    return;
  }

  // POST /api/cycle/stop/:id  —  arrÃªter un cycle TNR en cours (2 ou 3)
  if (method === "POST" && url.startsWith("/api/cycle/stop/")) {
    var stopId = url.replace("/api/cycle/stop/", "").trim();
    try {
      if (stopId === "2") {
        // Tuer tous les process c2 en cours (par ticket)
        Object.keys(runningProcs).forEach(function(k) {
          if (k.startsWith("playwright-direct-c2-") || k === "playwright-direct-tnr-release") {
            try { runningProcs[k].kill(); } catch(e) { /* process deja mort */ }
            delete runningProcs[k];
            delete agentLocks[k];
          }
        });
        cycle.stopCycle2();
      } else if (stopId === "3") {
        if (runningProcs["playwright-direct-tnr"]) {
          try { runningProcs["playwright-direct-tnr"].kill(); } catch(e) { /* process deja mort */ }
          delete runningProcs["playwright-direct-tnr"];
          delete agentLocks["playwright-direct-tnr"];
        }
        cycle.stopCycle3();
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cycle invalide : " + stopId }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/cycle/ticket/:key/run  —  lancer test Playwright sur un ticket validé
  if (method === "POST" && url.startsWith("/api/cycle/ticket/") && url.endsWith("/run")) {
    var ticketKey = url.replace("/api/cycle/ticket/", "").replace("/run", "");
    var c1Body = "";
    req.on("data", function(c) { c1Body += c; });
    req.on("end", function() {
      try {
        var c1Opts = {};
        try { c1Opts = JSON.parse(c1Body); } catch(e) { console.error("[SERVER] Erreur parse c1Body :", e.message); }
        cycle.markTicketRunning(ticketKey);
        var c1Settings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8"));

        // Phase 2 — Auto-déduire le mode depuis le ticket Jira via leadQA.decideStrategy
        var deduceMode = Promise.resolve(c1Opts.mode || null);
        if (!c1Opts.mode) {
          deduceMode = (function() {
            var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
            return new Promise(function(resolve) {
              var jr = require("https").request({
                hostname: CFG.jira.host,
                path: "/rest/api/3/issue/" + ticketKey + "?fields=summary,description,issuetype",
                method: "GET",
                headers: { "Authorization": "Basic " + auth, "Accept": "application/json" }
              }, function(jRes) {
                var d = "";
                jRes.on("data", function(c) { d += c; });
                jRes.on("end", function() {
                  try {
                    var issue = JSON.parse(d);
                    if (!issue || !issue.fields) { resolve("ui"); return; }
                    sendSSE("default", { type: "cycle1-progress", key: ticketKey, step: "analyze", message: "Analyse du ticket " + ticketKey + "..." });
                    leadQA.decideStrategy(issue).then(function(strategy) {
                      var mode = (strategy && strategy.playwrightMode) || "ui";
                      // Modes valides pour playwright-direct : ui, api, fix, tnr
                      var validModes = { ui:1, api:1, fix:1, tnr:1 };
                      if (!validModes[mode]) mode = "ui";
                      sendSSE("default", { type: "cycle1-progress", key: ticketKey, step: "strategy", message: "Stratégie : " + mode + " (" + (strategy.reasoning || "") + ")" });
                      resolve(mode);
                    }).catch(function(e) {
                      sendSSE("default", { type: "cycle1-progress", key: ticketKey, step: "strategy", message: "Stratégie fallback ui (erreur analyse)" });
                      resolve("ui");
                    });
                  } catch(e) { resolve("ui"); }
                });
              });
              jr.on("error", function() { resolve("ui"); });
              jr.end();
            });
          })();
        }

        deduceMode.then(function(mode) {
          var c1Args = [
            "agent-playwright-direct.js",
            "--mode=" + (mode || "ui"),
            "--source=jira-key",
            "--key=" + ticketKey,
            "--envs=" + (c1Settings.envs || ["sophie"]).join(","),
            "--browsers=" + (c1Settings.browsers || ["chromium"]).join(","),
            "--no-jira-push"
          ];
          runAgent("playwright-direct-c1-" + ticketKey, "node", c1Args, "default", false, {
            onDone: function(exitCode, logs) {
              var c1Result = { pass: 0, fail: 0, total: 0 };
              var rLine = logs.find(function(l) { return l.startsWith("PLAYWRIGHT_DIRECT_RESULT:"); });
              if (rLine) { try { c1Result = JSON.parse(rLine.replace("PLAYWRIGHT_DIRECT_RESULT:","")); } catch(e) { console.error("[SERVER] Erreur parse c1Result :", e.message); } }
              cycle.markTicketDone(ticketKey, c1Result);
              var allPass = c1Result.fail === 0 && c1Result.total > 0;

              // Phase 1 — Plus d'attachement automatique. Le rapport reste local.
              // L'utilisateur peut l'attacher manuellement via POST /api/attach-report/:key

              // Si FAIL → lancer l'analyse IA en arrière-plan
              if (!allPass) {
                var failLogs = logs.slice(-150).join("\n");
                var reportContent = "";
                if (c1Result.reportPath) {
                  var rpPath = path.join(BASE_DIR, "reports", c1Result.reportPath);
                  try { reportContent = fs.readFileSync(rpPath, "utf8"); } catch(e) { console.error("[SERVER] Erreur lecture rapport :", e.message); }
                }
                leadQA.analyzePlaywrightFail(failLogs, {
                  ticketKey: ticketKey, mode: mode || "ui", env: (c1Settings.envs || ["sophie"]).join(","),
                  pass: c1Result.pass, fail: c1Result.fail, total: c1Result.total
                }).then(function(diag) {
                  sendSSE("default", {
                    type: "cycle1-fail-analysis",
                    key: ticketKey,
                    result: c1Result,
                    reportFile: c1Result.reportPath || null,
                    pdfFile: c1Result.pdfPath || null,
                    reportContent: reportContent.substring(0, 5000),
                    diagnostic: diag
                  });
                }).catch(function() {});
              }

              sendSSE("default", {
                type: "cycle1-ticket-done",
                key: ticketKey,
                result: c1Result,
                ok: allPass,
                reportFile: c1Result.reportPath || null,
                pdfFile: c1Result.pdfPath || null,
                mode: mode || "ui"
              });
            }
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key: ticketKey, mode: mode }));
        });
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/attach-report/:key  —  attacher manuellement un rapport à un ticket Jira
  if (method === "POST" && url.startsWith("/api/attach-report/")) {
    var arKey = url.replace("/api/attach-report/", "").split("?")[0];
    var arBody = "";
    req.on("data", function(c) { arBody += c; });
    req.on("end", function() {
      try {
        var arData = JSON.parse(arBody);
        var arFile = arData.file; // nom du fichier dans reports/
        if (!arFile) { res.writeHead(400); res.end(JSON.stringify({ error: "file requis" })); return; }
        var arFullPath = path.join(BASE_DIR, "reports", arFile);
        if (!fs.existsSync(arFullPath)) { res.writeHead(404); res.end(JSON.stringify({ error: "Fichier introuvable" })); return; }
        attachFileToJira(arKey, arFullPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, key: arKey, file: arFile }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/css-report  —  dernier rapport d'audit CSS (JSON)
  // GET /api/css-report/download  —  tÃ©lÃ©charger le .md brut
  if (method === "GET" && (url === "/api/css-report" || url === "/api/css-report/download")) {
    try {
      var reportsDir2 = path.join(BASE_DIR, "reports");
      var cssFiles = fs.existsSync(reportsDir2)
        ? fs.readdirSync(reportsDir2).filter(function(f) { return f.startsWith("AUDIT-CSS") && f.endsWith(".md"); })
        : [];
      if (cssFiles.length === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Aucun rapport CSS trouvÃ©" }));
        return;
      }
      cssFiles.sort(function(a, b) {
        var ta = parseInt(a.replace(/.*-(\d+)\.md$/, "$1")) || 0;
        var tb = parseInt(b.replace(/.*-(\d+)\.md$/, "$1")) || 0;
        return tb - ta;
      });
      var latestCss  = cssFiles[0];
      var contentCss = fs.readFileSync(path.join(reportsDir2, latestCss), "utf8");
      if (url === "/api/css-report/download") {
        res.writeHead(200, {
          "Content-Type":        "text/markdown; charset=utf-8",
          "Content-Disposition": 'attachment; filename="' + latestCss + '"'
        });
        res.end(contentCss);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ filename: latestCss, content: contentCss, count: cssFiles.length }));
      }
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/jira-search?q=...  —  recherche tickets Jira via JQL
  if (method === "GET" && url.startsWith("/api/jira-search")) {
    var qRaw   = req.url.split("?")[1] || "";
    var qParam = qRaw.replace(/^.*q=([^&]*).*$/, "$1");
    var q      = decodeURIComponent(qParam).trim();
    var httpsJS = require("https");
    var authJS  = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var project = CFG.jira.project || "SAFWBST";

    // JQL : clÃ© exacte si Ã§a ressemble Ã  SAFWBST-123, sinon recherche texte
    var jql;
    if (/^[A-Z]+-\d+$/i.test(q)) {
      jql = "key = \"" + q.toUpperCase() + "\"";
    } else {
      jql = "project = " + project + " AND summary ~ \"" + q.replace(/"/g, "") + "*\" ORDER BY updated DESC";
    }
    var jqlPath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
      "&fields=key,summary,status,issuetype&maxResults=10";

    var jsSearch = httpsJS.request({
      hostname: CFG.jira.host, path: jqlPath, method: "GET",
      headers: { "Authorization": "Basic " + authJS, "Accept": "application/json" }
    }, function(jsRes) {
      var data = "";
      jsRes.on("data", function(c) { data += c; });
      jsRes.on("end", function() {
        try {
          var parsed  = JSON.parse(data);
          var results = (parsed.issues || []).map(function(issue) {
            return {
              key:     issue.key,
              summary: (issue.fields && issue.fields.summary) || "",
              type:    (issue.fields && issue.fields.issuetype && issue.fields.issuetype.name) || "",
              status:  (issue.fields && issue.fields.status && issue.fields.status.name) || ""
            };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(results));
        } catch(e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("[]");
        }
      });
    });
    jsSearch.on("error", function() { res.writeHead(200); res.end("[]"); });
    jsSearch.setTimeout(8000, function() { jsSearch.destroy(); res.writeHead(200); res.end("[]"); });
    jsSearch.end();
    return;
  }

  // POST /api/css-report/attach  —  attacher le rapport CSS Ã  un ticket Jira
  if (method === "POST" && url === "/api/css-report/attach") {
    var attachBody = "";
    req.on("data", function(c) { attachBody += c; });
    req.on("end", function() {
      try {
        var attachParams = JSON.parse(attachBody);
        var issueKey     = (attachParams.key || "").trim().toUpperCase();
        if (!issueKey) { res.writeHead(400); res.end(JSON.stringify({ error: "ClÃ© ticket manquante" })); return; }

        var reportsDir3  = path.join(BASE_DIR, "reports");
        var cssFiles3    = fs.existsSync(reportsDir3)
          ? fs.readdirSync(reportsDir3).filter(function(f) { return f.startsWith("AUDIT-CSS") && f.endsWith(".md"); })
          : [];
        if (!cssFiles3.length) { res.writeHead(404); res.end(JSON.stringify({ error: "Aucun rapport CSS" })); return; }

        cssFiles3.sort(function(a, b) {
          return (parseInt(b.replace(/.*-(\d+)\.md$/, "$1")) || 0) - (parseInt(a.replace(/.*-(\d+)\.md$/, "$1")) || 0);
        });
        var latestFile = cssFiles3[0];
        var mdContent  = fs.readFileSync(path.join(reportsDir3, latestFile));

        // Extraire les screenshots citÃ©s dans le rapport (max 1 par env)
        var mdText  = mdContent.toString("utf8");
        var shotRe  = /- Screenshot : (css-[^\n]+\.png)/g;
        var shots   = {}, m2;
        while ((m2 = shotRe.exec(mdText)) !== null) {
          var fn3   = m2[1].trim().split(/[\\/]/).pop();
          var envTag = fn3.replace(/^css-([a-z]+)-.*/, "$1");
          if (!shots[envTag]) shots[envTag] = fn3; // 1 screenshot par env
        }
        var shotFiles = Object.values(shots).slice(0, 4); // max 4 screenshots

        var httpsAT  = require("https");
        var authAT   = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
        var attached = [], errors = [];

        function attachFile(filename, buffer, mime, next) {
          var boundary = "QABoundary" + Date.now();
          var CRLF     = "\r\n";
          var hdr = Buffer.from(
            "--" + boundary + CRLF +
            "Content-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"" + CRLF +
            "Content-Type: " + mime + CRLF + CRLF
          );
          var ftr  = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
          var body2 = Buffer.concat([hdr, buffer, ftr]);

          var atReq = httpsAT.request({
            hostname: CFG.jira.host,
            path:     "/rest/api/3/issue/" + issueKey + "/attachments",
            method:   "POST",
            headers: {
              "Authorization":    "Basic " + authAT,
              "X-Atlassian-Token": "no-check",
              "Content-Type":     "multipart/form-data; boundary=" + boundary,
              "Content-Length":   body2.length
            }
          }, function(atRes) {
            var d = "";
            atRes.on("data", function(c) { d += c; });
            atRes.on("end", function() {
              if (atRes.statusCode < 300) attached.push(filename);
              else errors.push(filename + " (" + atRes.statusCode + ")");
              next();
            });
          });
          atReq.on("error", function(e) { errors.push(filename + " (erreur rÃ©seau)"); next(); });
          atReq.write(body2);
          atReq.end();
        }

        // Queue d'upload : rapport .md puis screenshots
        var queue = [{ name: latestFile, buf: mdContent, mime: "text/markdown" }];
        shotFiles.forEach(function(fn3) {
          var fp3 = path.join(BASE_DIR, "screenshots", fn3);
          if (fs.existsSync(fp3)) queue.push({ name: fn3, buf: fs.readFileSync(fp3), mime: "image/png" });
        });

        var qi = 0;
        function nextUpload() {
          if (qi >= queue.length) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, attached: attached, errors: errors, ticket: issueKey }));
            return;
          }
          var item = queue[qi++];
          attachFile(item.name, item.buf, item.mime, nextUpload);
        }
        nextUpload();

      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /screenshots/:filename  —  servir un screenshot PNG
  if (method === "GET" && url.startsWith("/screenshots/")) {
    var shotFile = url.replace("/screenshots/", "").split("?")[0];
    // SÃ©curitÃ© : interdire les traversÃ©es de rÃ©pertoire
    if (shotFile.includes("..") || shotFile.includes("/") || shotFile.includes("\\")) {
      res.writeHead(400); res.end("Invalid filename");
      return;
    }
    var shotPath = path.join(BASE_DIR, "screenshots", shotFile);
    if (!fs.existsSync(shotPath)) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    fs.createReadStream(shotPath).pipe(res);
    return;
  }

  // GET /reports/:filename  —  servir un rapport (PDF, HTML, MD)
  if (method === "GET" && url.startsWith("/reports/")) {
    var rptFile = url.replace("/reports/", "").split("?")[0];
    if (rptFile.includes("..") || rptFile.includes("/") || rptFile.includes("\\")) {
      res.writeHead(400); res.end("Invalid filename");
      return;
    }
    var rptPath = path.join(BASE_DIR, "reports", rptFile);
    if (!fs.existsSync(rptPath)) { res.writeHead(404); res.end("Not found"); return; }
    var rptMime = /\.pdf$/i.test(rptFile) ? "application/pdf"
      : /\.html$/i.test(rptFile) ? "text/html; charset=utf-8"
      : "text/markdown; charset=utf-8";
    var rptHeaders = { "Content-Type": rptMime };
    // PDF et HTML : inline (affichage dans le navigateur), MD : download
    if (/\.(pdf|html)$/i.test(rptFile)) {
      rptHeaders["Content-Disposition"] = 'inline; filename="' + rptFile + '"';
    } else {
      rptHeaders["Content-Disposition"] = 'attachment; filename="' + rptFile + '"';
    }
    res.writeHead(200, rptHeaders);
    fs.createReadStream(rptPath).pipe(res);
    return;
  }

  // GET /api/jira-dryrun — état du dryRun
  // GET /api/xray-search?type=plan|exec&release=v1.25.0 — recherche par release
  if (method === "GET" && url.startsWith("/api/xray-search")) {
    var xsParams = new URLSearchParams((req.url.split("?")[1]) || "");
    var xsType = xsParams.get("type");
    var xsRelease = xsParams.get("release") || "";
    if (!xsRelease) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "release requis" }));
      return;
    }
    (async function() {
      try {
        if (xsType === "plan" || xsType === "exec") {
          var issuetype = xsType === "plan" ? "Test Plan" : "Test Execution";
          var xsProject = (require("./config").jira.project) || "SAFWBST";
          var xsJql = 'project = ' + xsProject + ' AND issuetype = "' + issuetype + '" AND summary ~ "' + xsRelease + '" ORDER BY created DESC';
          var xsRes = await jiraApiCall("GET", "/rest/api/3/search/jql?jql=" + encodeURIComponent(xsJql) + "&fields=summary,status,key&maxResults=5");
          var xsIssues = (xsRes.data && xsRes.data.issues) || [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, type: xsType, release: xsRelease, results: xsIssues.map(function(i) { return { key: i.key, summary: i.fields.summary, status: (i.fields.status || {}).name || "" }; }) }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "type invalide (plan|exec)" }));
        }
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  if (method === "GET" && url === "/api/jira-dryrun") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dryRun: jiraQueue.isDryRun() }));
    return;
  }

  // POST /api/jira-dryrun — basculer dryRun on/off
  if (method === "POST" && url === "/api/jira-dryrun") {
    var bodyDR = "";
    req.on("data", function(c) { bodyDR += c; });
    req.on("end", function() {
      try {
        var parsed = JSON.parse(bodyDR);
        jiraQueue.setDryRun(parsed.dryRun !== false);
        console.log("[Server] Jira dryRun = " + jiraQueue.isDryRun());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dryRun: jiraQueue.isDryRun() }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/polling/status  —  Ã©tat du poller
  if (method === "GET" && url === "/api/polling/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(poller.getStatus()));
    return;
  }

  // POST /api/polling/toggle  —  activer/dÃ©sactiver le poller
  if (method === "POST" && url === "/api/polling/toggle") {
    var st = poller.getStatus();
    var settingsFilePoll = path.join(BASE_DIR, "settings.json");
    try {
      var settingsPoll = JSON.parse(fs.readFileSync(settingsFilePoll, "utf8"));
      if (st.running) {
        poller.stop();
        settingsPoll.polling = settingsPoll.polling || {};
        settingsPoll.polling.enabled = false;
      } else {
        settingsPoll.polling = settingsPoll.polling || {};
        settingsPoll.polling.enabled = true;
        poller.start(settingsPoll, sendSSE);
      }
      fs.writeFileSync(settingsFilePoll, JSON.stringify(settingsPoll, null, 2), "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, running: poller.getStatus().running }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/generate-bug-preview — génère un ticket Bug pré-rempli depuis un diagnostic FAIL
  if (method === "POST" && url === "/api/generate-bug-preview") {
    var gbChunks = [];
    req.on("data", function(c) { gbChunks.push(c); });
    req.on("end", function() {
      try {
        var body = JSON.parse(Buffer.concat(gbChunks).toString());
        var sourceKey = body.sourceKey || "";
        var diag = body.diagnostic || {};
        var reportContent = body.reportContent || "";

        // Récupérer le summary du ticket source
        var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
        var infoReq = require("https").request({
          hostname: CFG.jira.host,
          path: "/rest/api/3/issue/" + sourceKey + "?fields=summary,issuetype",
          method: "GET",
          headers: { "Authorization": "Basic " + auth, "Accept": "application/json" }
        }, function(iRes) {
          var iData = "";
          iRes.on("data", function(c) { iData += c; });
          iRes.on("end", function() {
            var issueInfo = {};
            try { issueInfo = JSON.parse(iData); } catch(e) { console.error("[SERVER] Erreur parse issueInfo :", e.message); }
            var usSummary = (issueInfo.fields && issueInfo.fields.summary) || sourceKey;

            var fonction = (diag.pages && diag.pages[0]) || diag.causeProbable || "Dysfonctionnement détecté";
            var bugTitle = "BUG - [" + usSummary.substring(0, 80) + "] - " + fonction.substring(0, 80);

            // Construire la description du bug
            var desc = "## Diagnostic\n\n" + (diag.diagnostic || "Erreur détectée lors du test automatisé") + "\n\n";
            desc += "## Cause probable\n\n" + (diag.causeProbable || "À investiguer") + "\n\n";
            desc += "## Correction suggérée\n\n" + (diag.correction || "Aucune suggestion") + "\n\n";
            if (diag.pages && diag.pages.length > 0) {
              desc += "## Pages affectées\n\n" + diag.pages.map(function(p) { return "- " + p; }).join("\n") + "\n\n";
            }
            desc += "## Ticket source\n\n" + sourceKey + "\n\n";
            if (reportContent) {
              desc += "## Extrait du rapport\n\n" + reportContent.substring(0, 2000) + "\n";
            }

            var priority = diag["priorité"] === "HIGH" ? "High" : diag["priorité"] === "LOW" ? "Low" : "Medium";

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              title: bugTitle,
              description: desc,
              priority: priority,
              sourceKey: sourceKey,
              labels: ["qa-auto", "auto-generated"],
              issuetype: "Bug"
            }));
          });
        });
        infoReq.on("error", function(e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
        infoReq.end();
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }


  // ── DAILY JOB — check journalier QA ──────────────────────────────────────
  if (method === "POST" && url === "/api/daily-job/run") {
    if (dailyJob.isRunning()) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Job deja en cours" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Job lance" }));
    // S'assurer que sendSSE est injecte meme hors mode cron
    dailyJob.setSendSSE(sendSSE);
    dailyJob.runDailyQAJob().catch(function(e) {
      console.log("[DAILY-JOB] Erreur non capturee : " + e.message);
    });
    return;
  }

  if (method === "GET" && url === "/api/daily-job/last-report") {
    var djReport = dailyJob.getLastReport();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(djReport || { date: null, ticketsTraites: 0 }));
    return;
  }

  // Debug : lister les statuts Jira du projet
  if (method === "GET" && url === "/api/jira-statuses") {
    var httpsDbg = require("https");
    var authDbg = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var dbgReq = httpsDbg.request({
      hostname: CFG.jira.host,
      path: "/rest/api/3/project/" + (CFG.jira.project || "SAFWBST") + "/statuses",
      method: "GET",
      headers: { "Authorization": "Basic " + authDbg, "Accept": "application/json" }
    }, function(dbgRes) {
      var dbgData = "";
      dbgRes.on("data", function(c) { dbgData += c; });
      dbgRes.on("end", function() {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          var parsed = JSON.parse(dbgData);
          var statuses = [];
          (parsed || []).forEach(function(issueType) {
            (issueType.statuses || []).forEach(function(s) {
              if (!statuses.find(function(x) { return x.name === s.name; }))
                statuses.push({ name: s.name, id: s.id, category: s.statusCategory && s.statusCategory.name });
            });
          });
          res.end(JSON.stringify({ project: CFG.jira.project, statuses: statuses }));
        } catch(e) { res.end(dbgData); }
      });
    });
    dbgReq.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    dbgReq.end();
    return;
  }

  if (method === "GET" && url === "/api/daily-job/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: dailyJob.isRunning(), mode: DAILY_JOB_MODE ? "daily" : "polling" }));
    return;
  }
  // ── COLONNE SOPHIE — tickets QA prêts à tester ─────────────────────────
  if (method === "GET" && url === "/api/sophie-column") {
    // Chercher directement dans Jira les tickets QA assignés
    var sophieStatuses = ["To Test", "In Test", "To Test UAT", "In validation", "Reopened"];
    var statusClause = sophieStatuses.map(function(s) { return '"' + s + '"'; }).join(", ");
    var sophieJql = "project = " + CFG.jira.project +
      " AND assignee = currentUser()" +
      " AND status in (" + statusClause + ")" +
      " AND issuetype in (Story, Bug)" +
      " ORDER BY priority DESC";
    var sophiePath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(sophieJql) +
      "&fields=summary,description,status,issuetype,priority,labels,issuelinks&maxResults=50";
    var sophieAuth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");

    var sReq = require("https").request({
      hostname: CFG.jira.host,
      path: sophiePath,
      method: "GET",
      headers: { "Authorization": "Basic " + sophieAuth, "Accept": "application/json" }
    }, function(sRes) {
      var sData = "";
      sRes.on("data", function(c) { sData += c; });
      sRes.on("end", function() {
        try {
          var parsed = JSON.parse(sData);
          var issues = (parsed.issues || []).map(function(t) {
            var status = (t.fields.status && t.fields.status.name) || "";
            var labels = t.fields.labels || [];
            var hasLinkedTest = (t.fields.issuelinks || []).some(function(l) {
              var linked = l.outwardIssue || l.inwardIssue;
              return linked && linked.fields && linked.fields.issuetype &&
                (linked.fields.issuetype.name === "Test" || linked.fields.issuetype.name === "Test Case");
            });

            // Extraire description texte pour le score
            var descText = "";
            if (t.fields.description) {
              if (typeof t.fields.description === "string") descText = t.fields.description;
              else if (t.fields.description.content) {
                descText = t.fields.description.content.map(function(b) {
                  return (b.content || []).map(function(c) { return c.text || ""; }).join("");
                }).join("\n");
              }
            }

            // Score de complétude
            var score = 0;
            var missing = [];
            var isBug = (t.fields.issuetype && t.fields.issuetype.name) === "Bug";

            if (descText.length > 30) score += 30; else missing.push("description");
            if (/tant que|je veux|afin de/i.test(descText) || isBug) score += 15; else missing.push("persona");
            if (/donn|lorsque|alors|given|when|then/i.test(descText)) score += 25; else missing.push("AC Gherkin");
            if (hasLinkedTest) score += 20; else missing.push("ticket TEST");
            if (/https?:\/\//.test(descText)) score += 10; else missing.push("URL");

            // Déterminer le type de test depuis les labels
            var testType = "auto";
            if (labels.indexOf("test-manuel") !== -1) testType = "manuel";
            else if (labels.indexOf("test-mixte") !== -1) testType = "mixte";
            else if (labels.indexOf("test-drupal") !== -1) testType = "drupal";
            else if (labels.indexOf("test-auto") !== -1) testType = "auto";

            // État : canTest = vrai seulement si description + AC + TEST lié
            var hasDesc = descText.length > 30;
            var hasAC = /donn|lorsque|alors|given|when|then/i.test(descText);
            var state = "incomplete";
            var canTest = false;
            if (hasDesc && hasAC && hasLinkedTest) { state = "ready"; canTest = true; }
            else if (hasDesc && hasAC) { state = "partial"; } // TEST manquant → préparer

            return {
              key: t.key,
              summary: t.fields.summary || "",
              type: (t.fields.issuetype && t.fields.issuetype.name) || "",
              jiraStatus: status,
              priority: (t.fields.priority && t.fields.priority.name) || "",
              state: state,
              score: score,
              missing: missing,
              canTest: canTest,
              testType: testType,
              hasTest: hasLinkedTest,
              labels: labels,
              jiraUrl: "https://" + CFG.jira.host + "/browse/" + t.key
            };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(issues));
        } catch(e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    sReq.on("error", function(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    sReq.setTimeout(15000, function() { sReq.destroy(); });
    sReq.end();
    return;
  }

  // ── RESTORE BACKUP — remet la description originale dans Jira ──────────────
  if (method === "POST" && url.match(/^\/api\/restore-backup\/[A-Z]+-\d+$/)) {
    var restoreKey = url.split("/").pop();
    var backupDir = path.join(BASE_DIR, "backup");
    try {
      if (!fs.existsSync(backupDir)) throw new Error("Dossier backup/ inexistant");
      // Trouver le backup le plus récent pour cette clé
      var backups = fs.readdirSync(backupDir)
        .filter(function(f) { return f.startsWith(restoreKey + "-backup-") && f.endsWith(".json"); })
        .sort().reverse();
      if (backups.length === 0) throw new Error("Aucun backup trouvé pour " + restoreKey);

      var backupFile = path.join(backupDir, backups[0]);
      var originalDesc = JSON.parse(fs.readFileSync(backupFile, "utf8"));

      // Restaurer dans Jira via API v3
      var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
      var restoreBody = JSON.stringify({ fields: { description: originalDesc } });
      var restoreReq = require("https").request({
        hostname: CFG.jira.host,
        path: "/rest/api/3/issue/" + restoreKey,
        method: "PUT",
        headers: {
          "Authorization": "Basic " + auth,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(restoreBody)
        }
      }, function(jRes) {
        var data = "";
        jRes.on("data", function(c) { data += c; });
        jRes.on("end", function() {
          if (jRes.statusCode >= 200 && jRes.statusCode < 300) {
            console.log("[RESTORE] " + restoreKey + " restauré depuis " + backups[0]);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, key: restoreKey, from: backups[0], backupsAvailable: backups.length }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Jira HTTP " + jRes.statusCode, body: data.substring(0, 300) }));
          }
        });
      });
      restoreReq.on("error", function(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
      restoreReq.write(restoreBody);
      restoreReq.end();
    } catch(e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── LIST BACKUPS ──────────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/backups") {
    var bDir = path.join(BASE_DIR, "backup");
    var list = [];
    try {
      if (fs.existsSync(bDir)) {
        list = fs.readdirSync(bDir)
          .filter(function(f) { return f.endsWith(".json"); })
          .map(function(f) {
            var match = f.match(/^([A-Z]+-\d+)-backup-(.+)\.json$/);
            return { file: f, key: match ? match[1] : f, timestamp: match ? match[2] : "" };
          })
          .sort(function(a, b) { return b.timestamp.localeCompare(a.timestamp); });
      }
    } catch(e) { console.error("[SERVER] Erreur listage backups :", e.message); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  // ── SOPHIE MANUAL RESULT — rapport attaché au ticket Jira ────────────────
  if (method === "POST" && url === "/api/sophie-manual-result") {
    var manBody = "";
    req.on("data", function(c) { manBody += c; });
    req.on("end", function() {
      try {
        var params = JSON.parse(manBody);
        var manKey = params.key;
        var manResult = params.result; // "PASS" ou "FAIL"
        if (!manKey || !manResult) throw new Error("key et result requis");

        // Rapport local
        var reportDir = path.join(BASE_DIR, "reports");
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
        var reportFile = path.join(reportDir, "MANUAL-" + manKey + "-" + Date.now() + ".md");
        var report = "# Test Manuel — " + manKey + "\n\n";
        report += "- **Résultat :** " + manResult + "\n";
        report += "- **Type :** Test manuel\n";
        fs.writeFileSync(reportFile, report, "utf8");

        // Attacher au ticket Jira
        attachFileToJira(manKey, reportFile);

        console.log("[MANUAL] " + manKey + " → " + manResult);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, key: manKey, result: manResult, reportFile: path.basename(reportFile) }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /api/enriched/:key/push — Pousser un ticket enrichi vers Jira ────
  if (method === "POST" && url.match(/^\/api\/enriched\/[A-Za-z0-9_-]+\/push$/)) {
    var pushKey = url.split("/")[3];
    var enrichedFile = path.join(BASE_DIR, "inbox", "enriched", pushKey + ".json");
    if (!fs.existsSync(enrichedFile)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Ticket enrichi introuvable : " + pushKey }));
      return;
    }
    var pushChunks = [];
    req.on("data", function(c) { pushChunks.push(c); });
    req.on("end", async function() {
      try {
        var enrichedData = JSON.parse(fs.readFileSync(enrichedFile, "utf8"));
        var pushType = "enrichment"; // default
        try { var pushBody = JSON.parse(Buffer.concat(pushChunks).toString()); pushType = pushBody.type || "enrichment"; } catch(e) {}

        if (pushType === "enrichment") {
          // Push enrichissement US vers Jira (mise à jour description)
          var adfDoc;
          if (enrichedData.enrichedMarkdown) {
            // Tenter ADF structuré si structured existe
            if (enrichedData.structured) {
              adfDoc = leadQA.buildADFDescription(enrichedData.structured);
            } else {
              adfDoc = enrichedData.enrichedMarkdown;
            }
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Pas de contenu enrichi pour " + pushKey }));
            return;
          }
          // Mettre à jour Jira
          await jiraApiCall("PUT", "/rest/api/3/issue/" + pushKey, {
            fields: { description: typeof adfDoc === "object" ? adfDoc : { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: String(adfDoc).substring(0, 30000) }] }] } }
          });
          await jiraComment(pushKey, "[QA Auto] US enrichie — Score : " + (enrichedData.score || "?") + "/100");
          enrichedData.status = "pushed";
          enrichedData.pushedAt = new Date().toISOString();
          fs.writeFileSync(enrichedFile, JSON.stringify(enrichedData, null, 2));
          console.log("[PUSH] " + pushKey + " — Enrichissement poussé vers Jira");
          bus.publish("jira:updated", { key: pushKey, field: "description", action: "enrichment-pushed" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key: pushKey, action: "enrichment-pushed" }));

        } else if (pushType === "test") {
          // Créer le ticket TEST dans Jira
          if (!enrichedData.testMarkdown) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Pas de TEST généré pour " + pushKey }));
            return;
          }
          var sourceTicket = { key: pushKey, epic: (enrichedData.analysis && enrichedData.analysis.epic) || "", summary: enrichedData.summary || "" };
          var testResult = { title: enrichedData.testTitle || "TEST - " + pushKey, markdown: enrichedData.testMarkdown };
          var jiraPriority = (enrichedData.analysis && enrichedData.analysis.priority === "Critique") ? "Highest" :
                             (enrichedData.analysis && enrichedData.analysis.priority === "Haute") ? "High" :
                             (enrichedData.analysis && enrichedData.analysis.priority === "Basse") ? "Low" : "Medium";
          var extPayload = leadQA.buildExternalJiraPayload(testResult, sourceTicket, { priority: jiraPriority });
          var valResult = leadQA.validateJiraPayload(extPayload.fields);
          if (!valResult.valid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Contenu interdit : " + valResult.violations.join(", ") }));
            return;
          }
          var jiraResult = await jiraApiCall("POST", "/rest/api/3/issue", { fields: extPayload.fields });
          var testKey = (jiraResult.data && jiraResult.data.key) ? jiraResult.data.key : null;
          if (testKey) {
            enrichedData.jiraTestKey = testKey;
            enrichedData.status = "test-pushed";
            enrichedData.testPushedAt = new Date().toISOString();
            fs.writeFileSync(enrichedFile, JSON.stringify(enrichedData, null, 2));
            console.log("[PUSH] " + pushKey + " — Ticket TEST créé : " + testKey);
            bus.publish("jira:updated", { key: pushKey, field: "test", action: "test-created", testKey: testKey });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key: pushKey, testKey: testKey || null, action: "test-created" }));

        } else if (pushType === "bug") {
          // Créer le ticket Bug dans Jira depuis le bug local
          if (!enrichedData.enrichedMarkdown) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Pas de contenu pour le bug " + pushKey }));
            return;
          }
          var bugDesc = enrichedData.enrichedMarkdown || enrichedData.originalMarkdown || "";
          var bugPriority = enrichedData.priority === "High" ? "High" : "Medium";
          var bugLabels = enrichedData.labels || ["pw-direct", "qa-auto"];
          var bugFields = {
            project: { key: CFG.jira.project },
            issuetype: { name: "Bug" },
            summary: enrichedData.summary || "BUG - " + pushKey,
            description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: String(bugDesc).substring(0, 30000) }] }] },
            priority: { name: bugPriority },
            labels: bugLabels
          };
          // Lier au ticket source si disponible
          var jiraResult = await jiraApiCall("POST", "/rest/api/3/issue", { fields: bugFields });
          var bugJiraKey = (jiraResult.data && jiraResult.data.key) ? jiraResult.data.key : null;
          if (bugJiraKey) {
            // Lier le bug au ticket source
            if (enrichedData.sourceKey) {
              try {
                await jiraApiCall("POST", "/rest/api/3/issueLink", {
                  type: { name: "Blocks" },
                  inwardIssue: { key: enrichedData.sourceKey },
                  outwardIssue: { key: bugJiraKey }
                });
              } catch(linkErr) { console.error("[PUSH] Lien bug→source KO :", linkErr.message); }
            }
            // Attacher le screenshot si dispo
            if (enrichedData.screenshot) {
              var screenshotPath = path.join(BASE_DIR, "screenshots", enrichedData.screenshot);
              if (fs.existsSync(screenshotPath)) {
                try { attachFileToJira(bugJiraKey, screenshotPath); } catch(e2) {}
              }
            }
            enrichedData.jiraBugKey = bugJiraKey;
            enrichedData.status = "pushed";
            enrichedData.pushedAt = new Date().toISOString();
            fs.writeFileSync(enrichedFile, JSON.stringify(enrichedData, null, 2));
            console.log("[PUSH] " + pushKey + " — Bug créé dans Jira : " + bugJiraKey);
            bus.publish("jira:updated", { key: pushKey, field: "bug", action: "bug-created", bugKey: bugJiraKey });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key: pushKey, bugKey: bugJiraKey || null, action: "bug-created" }));

        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Type inconnu : " + pushType }));
        }
      } catch(e) {
        console.error("[PUSH] Erreur " + pushKey + " :", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /api/email/send-report — Envoyer un rapport par mail ──────────────
  if (method === "POST" && url === "/api/email/send-report") {
    var emailChunks = [];
    req.on("data", function(c) { emailChunks.push(c); });
    req.on("end", async function() {
      try {
        if (!mailer) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: "Module mailer non disponible" })); return; }
        var body = JSON.parse(Buffer.concat(emailChunks).toString());
        var settings = {};
        try { settings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); } catch(e) {}
        var to = body.to || (settings.email && settings.email.contributeurs) || "";
        if (!to) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "Aucun destinataire (configurez email.contributeurs dans Paramètres)" })); return; }

        // Chercher le rapport
        var reportFile = body.reportPath ? path.join(CFG.paths.reports, body.reportPath) : null;
        var pdfFile = body.pdfPath ? path.join(CFG.paths.reports, body.pdfPath) : null;
        if (reportFile && !pdfFile) {
          var possiblePdf = reportFile.replace(/\.html$/, ".pdf");
          if (fs.existsSync(possiblePdf)) pdfFile = possiblePdf;
        }

        // Charger la synthèse release si version fournie
        var synthesis = body.synthesis || {};
        if (body.version && !body.synthesis) {
          var synthFile = path.join(CFG.paths.reports, "synthesis-" + body.version + ".json");
          if (fs.existsSync(synthFile)) {
            try { synthesis = JSON.parse(fs.readFileSync(synthFile, "utf8")); } catch(e) {}
          }
        }

        var template = (settings.email && settings.email.releaseTemplate) || null;
        var info = await mailer.sendReleaseReport({
          to: to,
          version: body.version || settings.currentRelease || "?",
          synthesis: synthesis,
          reportPath: reportFile,
          pdfPath: pdfFile,
          template: template
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, messageId: info ? info.messageId : null }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /api/email/send-alert — Envoyer une alerte par mail ──────────────
  if (method === "POST" && url === "/api/email/send-alert") {
    var alertChunks = [];
    req.on("data", function(c) { alertChunks.push(c); });
    req.on("end", async function() {
      try {
        if (!mailer) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: "Module mailer non disponible" })); return; }
        var body = JSON.parse(Buffer.concat(alertChunks).toString());
        var settings = {};
        try { settings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); } catch(e) {}
        var to = body.to || (settings.email && settings.email.recipients) || "";
        if (!to) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "Aucun destinataire" })); return; }
        var info = await mailer.sendAlert(to, body.diagnostic || body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, messageId: info ? info.messageId : null }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/email/status — Vérifier si SMTP est configuré ────────────────
  if (method === "GET" && url === "/api/email/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ enabled: !!(mailer && CFG.email.enabled()), host: CFG.email.host || null }));
    return;
  }

  // ── GET /api/purge/preview — Aperçu de ce qui serait purgé ──────────────
  if (method === "GET" && url === "/api/purge/preview") {
    var prev = purge.preview();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(prev));
    return;
  }

  // ── POST /api/purge/run — Lancer la purge ─────────────────────────────────
  if (method === "POST" && url === "/api/purge/run") {
    var purgeReport = purge.run();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(purgeReport));
    return;
  }

  // ── GET /api/bus/history — Derniers événements du bus inter-agents ────────
  if (method === "GET" && url.startsWith("/api/bus/history")) {
    var busN = parseInt((url.split("?n=")[1]) || "50", 10);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(bus.getHistory(busN)));
    return;
  }

  // ── GET /api/session/status — Statut de toutes les sessions ──────────────
  if (method === "GET" && url === "/api/session/status") {
    var authDir = path.join(__dirname, "auth");
    var sessionEnvs = ["prod", "sophie", "paulo"];
    var statuses = {};
    sessionEnvs.forEach(function(envName) {
      var filePath = path.join(authDir, envName + ".json");
      if (!fs.existsSync(filePath)) {
        statuses[envName] = { exists: false, age_hours: null, valid: false, expires_at: null, savedAt: null };
        return;
      }
      try {
        var stat = fs.statSync(filePath);
        var ageMs = Date.now() - stat.mtimeMs;
        var ageH = ageMs / 3600000;
        var maxAge = 24 * 60 * 60 * 1000;
        var valid = ageMs < maxAge;
        var expiresAt = new Date(stat.mtimeMs + maxAge).toISOString();
        var data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        var cookieCount = (data.cookies || []).length;
        statuses[envName] = {
          exists: true,
          age_hours: Math.round(ageH * 10) / 10,
          valid: valid,
          expires_at: expiresAt,
          savedAt: new Date(stat.mtimeMs).toISOString(),
          cookies: cookieCount
        };
      } catch(e) {
        console.error("[SESSION] Erreur lecture " + envName + " :", e.message);
        statuses[envName] = { exists: true, age_hours: null, valid: false, expires_at: null, error: e.message };
      }
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(statuses));
    return;
  }

  // ── POST /api/session/upload — Upload storageState JSON ────────────────────
  if (method === "POST" && url === "/api/session/upload") {
    var bodyChunks = [];
    req.on("data", function(c) { bodyChunks.push(c); });
    req.on("end", function() {
      try {
        var payload = JSON.parse(Buffer.concat(bodyChunks).toString());
        var envName = (payload.env || "").toLowerCase().trim();
        var storageState = payload.storageState;

        // Valider l'env
        if (["prod", "sophie", "paulo"].indexOf(envName) === -1) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Env invalide. Valeurs acceptées : prod, sophie, paulo" }));
          return;
        }

        // Valider le format storageState Playwright
        if (!storageState || typeof storageState !== "object") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "storageState manquant ou invalide" }));
          return;
        }
        if (!Array.isArray(storageState.cookies)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Format invalide — champ 'cookies' (array) requis" }));
          return;
        }
        if (!Array.isArray(storageState.origins)) {
          // origins peut être vide mais doit être un array
          storageState.origins = [];
        }

        // Sauvegarder dans auth/[env].json
        var authDir = path.join(__dirname, "auth");
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        var authFile = path.join(authDir, envName + ".json");
        fs.writeFileSync(authFile, JSON.stringify(storageState, null, 2));

        console.log("[SESSION] ✅ " + envName + " uploadé — " + storageState.cookies.length + " cookies");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, env: envName, cookies: storageState.cookies.length, savedAt: new Date().toISOString() }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "JSON invalide : " + e.message }));
      }
    });
    return;
  }

  // ── GET /api/session/:env — Statut d'une session spécifique ────────────────
  if (method === "GET" && url.match(/^\/api\/session\/[a-z]+$/)) {
    var sEnvName = url.split("/").pop();
    var sAuthFile = path.join(__dirname, "auth", sEnvName + ".json");
    if (!fs.existsSync(sAuthFile)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Aucune session pour " + sEnvName }));
      return;
    }
    try {
      var sStat = fs.statSync(sAuthFile);
      var sData = JSON.parse(fs.readFileSync(sAuthFile, "utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cookies: (sData.cookies || []).length, savedAt: new Date(sStat.mtimeMs).toISOString() }));
    } catch(e) {
      console.error("[SESSION] Erreur lecture " + sEnvName + " :", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST /api/session/:env — Upload session (ancien format, compat) ────────
  if (method === "POST" && url.match(/^\/api\/session\/[a-z]+$/)) {
    var pEnvName = url.split("/").pop();
    if (["prod", "sophie", "paulo"].indexOf(pEnvName) === -1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Env invalide" }));
      return;
    }
    var pChunks = [];
    req.on("data", function(c) { pChunks.push(c); });
    req.on("end", function() {
      try {
        var pData = JSON.parse(Buffer.concat(pChunks).toString());
        if (!Array.isArray(pData.cookies)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Format invalide — champ 'cookies' requis" }));
          return;
        }
        var pAuthDir = path.join(__dirname, "auth");
        if (!fs.existsSync(pAuthDir)) fs.mkdirSync(pAuthDir, { recursive: true });
        fs.writeFileSync(path.join(pAuthDir, pEnvName + ".json"), JSON.stringify(pData, null, 2));
        console.log("[SESSION] ✅ " + pEnvName + " uploadé (compat) — " + pData.cookies.length + " cookies");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, cookies: pData.cookies.length, savedAt: new Date().toISOString() }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "JSON invalide : " + e.message }));
      }
    });
    return;
  }

  // -- API : Postman ---------------------------------------------------------------
  if (method === "POST" && url === "/api/postman/generate") {
    var pmgChunks = [];
    req.on("data", function(c) { pmgChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(pmgChunks).toString());
        var result = await leadQA.generatePostmanCollection(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: result }));
      } catch(e) {
        console.error("[postman/generate] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (method === "POST" && url === "/api/postman/run") {
    var pmrChunks = [];
    req.on("data", function(c) { pmrChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(pmrChunks).toString());
        var agentPostman = require("./agent-postman");
        var result = await agentPostman.runCollection(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: result }));
      } catch(e) {
        console.error("[postman/run] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (method === "GET" && url === "/api/postman/collections") {
    try {
      var colDir = CFG.paths.collections || path.join(BASE_DIR, "collections");
      var files = fs.existsSync(colDir) ? fs.readdirSync(colDir).filter(function(f) { return f.endsWith(".json"); }) : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, collections: files }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (method === "GET" && /^\/api\/postman\/report\/[^/]+$/.test(url)) {
    var pmReportId = url.split("/").pop();
    try {
      var pmReportPath = path.join(REPORTS_DIR, pmReportId);
      if (!fs.existsSync(pmReportPath)) { res.writeHead(404); res.end("Not found"); return; }
      var pmReportData = fs.readFileSync(pmReportPath, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(pmReportData);
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (method === "DELETE" && /^\/api\/postman\/collection\/[^/]+$/.test(url)) {
    var pmDelId = url.split("/").pop();
    try {
      var colDir2 = CFG.paths.collections || path.join(BASE_DIR, "collections");
      var pmDelPath = path.join(colDir2, pmDelId);
      if (fs.existsSync(pmDelPath)) fs.unlinkSync(pmDelPath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // -- API : Appium ---------------------------------------------------------------
  if (method === "POST" && url === "/api/appium/generate") {
    var apgChunks = [];
    req.on("data", function(c) { apgChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(apgChunks).toString());
        var result = await leadQA.generateAppiumScript(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: result }));
      } catch(e) {
        console.error("[appium/generate] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (method === "POST" && url === "/api/appium/run") {
    var aprChunks = [];
    req.on("data", function(c) { aprChunks.push(c); });
    req.on("end", async function() {
      try {
        var body = JSON.parse(Buffer.concat(aprChunks).toString());
        var agentAppium = require("./agent-appium");
        var result = await agentAppium.runScript(body.script, body.platform, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: result }));
      } catch(e) {
        console.error("[appium/run] Erreur:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (method === "GET" && url === "/api/appium/scripts") {
    try {
      var scriptDir = CFG.paths.appiumScripts || path.join(BASE_DIR, "appium-scripts");
      var files = fs.existsSync(scriptDir) ? fs.readdirSync(scriptDir).filter(function(f) { return f.endsWith(".js"); }) : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scripts: files }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (method === "GET" && /^\/api\/appium\/report\/[^/]+$/.test(url)) {
    var apReportId = url.split("/").pop();
    try {
      var apReportPath = path.join(REPORTS_DIR, apReportId);
      if (!fs.existsSync(apReportPath)) { res.writeHead(404); res.end("Not found"); return; }
      var apReportData = fs.readFileSync(apReportPath, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(apReportData);
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (method === "DELETE" && /^\/api\/appium\/script\/[^/]+$/.test(url)) {
    var apDelId = url.split("/").pop();
    try {
      var scriptDir2 = CFG.paths.appiumScripts || path.join(BASE_DIR, "appium-scripts");
      var apDelPath = path.join(scriptDir2, apDelId);
      if (fs.existsSync(apDelPath)) fs.unlinkSync(apDelPath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", function() {
  console.log("==================================================");
  console.log("  ABY QA V2 - SERVEUR LOCAL v2");
  console.log("==================================================");
  console.log("  Dashboard : http://localhost:" + PORT);
  console.log("  Form      : http://localhost:" + PORT + "/form");
  console.log("==================================================");

  // â"€â"€ Health check Ollama (non bloquant) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  var ollamaCheck = http.request({
    hostname: "127.0.0.1",
    port:     11434,
    path:     "/api/tags",
    method:   "GET"
  }, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try {
        var parsed  = JSON.parse(data);
        var models  = (parsed.models || []).map(function(m) { return m.name; });
        if (models.length > 0) {
          console.log("  ðŸ¤– Ollama     : OK  —  modÃ¨les : " + models.join(", "));
        } else {
          console.log("  ðŸ¤– Ollama     : OK  —  aucun modÃ¨le chargÃ© (lancer : ollama pull mistral)");
        }
      } catch(e) {
        console.log("  ðŸ¤– Ollama     : OK (rÃ©ponse non parseable)");
      }
      console.log("  ðŸ‹ Router     : LLM actif");
      console.log("==================================================");
    });
  });
  ollamaCheck.setTimeout(3000, function() {
    ollamaCheck.destroy();
    console.log("  ðŸ¤– Ollama     : indisponible â†’ fallback rule-based actif");
    console.log("  ðŸ‹ Router     : mode dÃ©gradÃ© (rÃ¨gles mÃ©tier)");
    console.log("==================================================");
  });
  ollamaCheck.on("error", function() {
    console.log("  ðŸ¤– Ollama     : indisponible â†’ fallback rule-based actif");
    console.log("  ðŸ‹ Router     : mode dÃ©gradÃ© (rÃ¨gles mÃ©tier)");
    console.log("==================================================");
  });
  ollamaCheck.end();

  require("child_process").exec("start http://localhost:" + PORT);

  // â"€â"€ DÃ©marrage du poller Jira â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  var startupSettings = {};
  try {
    var pollerSettingsFile = path.join(BASE_DIR, "settings.json");
    startupSettings = fs.existsSync(pollerSettingsFile)
      ? JSON.parse(fs.readFileSync(pollerSettingsFile, "utf8"))
      : {};
    poller.start(startupSettings, sendSSE);
  } catch(e) {
    console.log("  [POLLER] Erreur demarrage : " + e.message);
  }

  // ── Demarrage Jira Queue OU Daily Job selon le mode ────────────────────────
  if (DAILY_JOB_MODE) {
    try {
      dailyJob.startCron(sendSSE);
      console.log("  [DAILY-JOB] Mode journalier actif — declenchement a 06:00");
    } catch(e) {
      console.log("  [DAILY-JOB] Erreur demarrage : " + e.message);
    }
  } else {
    try {
      jiraQueue.start();
      console.log("  [JIRA-QUEUE] Polling continu actif (US + Bug + Test + Backlog)");
    } catch(e) {
      console.log("  [JIRA-QUEUE] Erreur demarrage : " + e.message);
    }
  }

  // â"€â"€ DÃ©marrage du cron TNR (Cycle 3) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function getFreshSettings() {
    try { return JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); }
    catch(e) { return {}; }
  }
  try {
    cycle.startCron(sendSSE, runAgent, getFreshSettings, leadQA);
    if (startupSettings.tnr && startupSettings.tnr.enabled) {
      console.log("  â° TNR Cron  : actif  —  dÃ©clenchement Ã  " + (startupSettings.tnr.hour || "22:00"));
    } else {
      console.log("  â° TNR Cron  : dÃ©sactivÃ© (activer dans ParamÃ¨tres QA)");
    }
  } catch(e) {
    console.log("  [CYCLE] Erreur dÃ©marrage cron : " + e.message);
  }

  // ── Purge auto quotidienne (si activée) ─────────────────────────────────────
  if (startupSettings.purge && startupSettings.purge.enabled !== false) {
    // Purge toutes les 24h (première exécution après 1h pour laisser le serveur démarrer)
    setTimeout(function() {
      try {
        var report = purge.run();
        console.log("[PURGE] Auto — " + report.totalDeleted + " fichiers supprimés");
      } catch(e) { console.error("[PURGE] Erreur auto:", e.message); }
    }, 60 * 60 * 1000);
    setInterval(function() {
      try {
        var report = purge.run();
        console.log("[PURGE] Auto — " + report.totalDeleted + " fichiers supprimés");
      } catch(e) { console.error("[PURGE] Erreur auto:", e.message); }
    }, 24 * 60 * 60 * 1000);
    console.log("  🗑️ Purge auto : active (rétention " + (startupSettings.purge.retentionDays || 30) + "j)");
  } else {
    console.log("  🗑️ Purge auto : désactivée");
  }

  // ── EVENT BUS — Bridge SSE + câblage réactif inter-agents ──────────────────
  bus.on("error", function(err) {
    console.error("[BUS] Erreur non gérée :", err.message || err);
  });

  // ── Mise à jour automatique du plan de test enrichi ──────────────────────
  function updateTestPlanStep(ticketKey, tool, mode, status, result) {
    if (!ticketKey) return;
    var enrichedFile = path.join(BASE_DIR, "inbox", "enriched", ticketKey + ".json");
    if (!fs.existsSync(enrichedFile)) return;
    try {
      var data = JSON.parse(fs.readFileSync(enrichedFile, "utf8"));
      var plan = data.testPlan;
      if (!Array.isArray(plan) || plan.length === 0) return;
      // Trouver l'étape : d'abord running, sinon première pending du tool
      var step = plan.find(function(s) {
        return s.status === "running" && s.tool === tool;
      }) || plan.find(function(s) {
        return s.tool === tool && (s.mode === mode || !mode) && s.status === "pending";
      });
      if (!step) return;
      step.status    = status;
      step.result    = result || {};
      step.updatedAt = new Date().toISOString();
      if (result && result.reportPath) step.reportPath = result.reportPath;
      data.testPlan = plan;
      fs.writeFileSync(enrichedFile, JSON.stringify(data, null, 2), "utf8");
      console.log("[PLAN] " + ticketKey + " étape " + step.order + " → " + status);
    } catch(e) { console.error("[PLAN] Erreur update :", e.message); }
  }

  // ── Tracker retry diagnostic (1 seul retry par ticket+tool) ──────────────
  var _diagRetried = {};

  // ── Diagnostic IA post-test (générique, tous outils) ──────────────────────
  function runDiagnosticIA(tool, evt) {
    if (!evt.key) return;
    var enrichedFile = path.join(BASE_DIR, "inbox", "enriched", evt.key + ".json");
    // Charger le contexte du ticket si disponible
    var context = {};
    if (fs.existsSync(enrichedFile)) {
      try {
        var eData = JSON.parse(fs.readFileSync(enrichedFile, "utf8"));
        context.ticketSummary = eData.summary || "";
      } catch(e) {}
    }
    leadQA.analyzeTestResult(tool, evt, context)
      .then(function(diag) {
        console.log("[DIAG] " + tool + " " + evt.key + " → " + diag.verdict + " (" + diag.confidence + "%) — " + (diag.diagnostic || "").substring(0, 80));
        // Sauvegarder le diagnostic dans le ticket enrichi
        if (fs.existsSync(enrichedFile)) {
          try {
            var data = JSON.parse(fs.readFileSync(enrichedFile, "utf8"));
            if (!data.diagnostics) data.diagnostics = [];
            diag._tool = tool;
            diag._event = evt.status || null;
            data.diagnostics.push(diag);
            // Garder les 20 derniers diagnostics max
            if (data.diagnostics.length > 20) data.diagnostics = data.diagnostics.slice(-20);
            data.lastDiagnostic = diag;
            fs.writeFileSync(enrichedFile, JSON.stringify(data, null, 2), "utf8");
          } catch(e) { console.error("[DIAG] Erreur save:", e.message); }
        }
        // Auto-alerte mail si sévérité critique
        if (mailer && (diag.severity === "CRITICAL" || diag.severity === "MAJOR")) {
          try {
            var emailSettings = {};
            try { emailSettings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")).email || {}; } catch(e2) {}
            if (emailSettings.alertsEnabled && emailSettings.recipients) {
              var minSev = emailSettings.alertSeverity || "CRITICAL";
              var shouldSend = minSev === "MAJOR" || (minSev === "CRITICAL" && diag.severity === "CRITICAL");
              if (shouldSend) {
                mailer.sendAlert(emailSettings.recipients, Object.assign({ key: evt.key }, diag));
              }
            }
          } catch(e2) { console.error("[DIAG] Erreur alerte mail:", e2.message); }
        }
        // Publier le diagnostic sur le bus → SSE dashboard
        bus.publish("diagnostic:ready", {
          key: evt.key, tool: tool, verdict: diag.verdict,
          confidence: diag.confidence, diagnostic: diag.diagnostic,
          category: diag.category, severity: diag.severity,
          action: diag.action, actionType: diag.actionType
        });

        // Auto-retry si diagnostic recommande RERUN (1 seule fois par ticket+tool)
        if (diag.actionType === "RERUN" && evt.key && tool === "playwright") {
          var retrySettings = {};
          try { retrySettings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")).retry || {}; } catch(e2) {}
          if (retrySettings.enabled !== false) {
            var retryKey = evt.key + ":" + tool;
            if (!_diagRetried[retryKey]) {
              _diagRetried[retryKey] = true;
              console.log("[DIAG] Auto-retry recommandé pour " + evt.key + " (" + tool + ") — " + diag.category);
              bus.publish("test:retry", {
                key: evt.key, tool: tool, reason: diag.category, diagnostic: diag.diagnostic,
                env: evt.env || "sophie", mode: evt.mode || "ui", urls: evt.urls || null
              });
            }
          }
        }
      })
      .catch(function(e) {
        console.error("[DIAG] Erreur " + tool + " " + evt.key + ":", e.message);
      });
  }

  // Bridge : tous les événements bus → SSE dashboard
  bus.on("*", function(event) {
    try {
      var ssePayload = Object.assign({}, event, { type: "bus-event" });
      Object.keys(sseClients).forEach(function(cid) {
        sendSSE(cid, ssePayload);
      });
    } catch(e) { /* SSE best-effort */ }
  });

  // ticket:detected → auto-trigger workflow selon le type
  bus.on("ticket:detected", function(evt) {
    try {
      var qaStatuses = ["To Test", "IN TEST", "Reopened", "TO TEST UAT", "To Test UAT"];
      if (qaStatuses.indexOf(evt.status) === -1) return;
      console.log("[BUS] ticket:detected → " + evt.key + " (" + evt.type + " / " + evt.status + ")");
      if (typeof jiraQueue.poll === "function") {
        jiraQueue.poll();
      }
    } catch(e) { console.error("[BUS] Erreur ticket:detected :", e.message); }
  });

  // test:generated → auto-ajouter à la file Playwright
  bus.on("test:generated", function(evt) {
    try {
      var testsDir = path.join(BASE_DIR, "inbox", "tests");
      if (!fs.existsSync(testsDir)) fs.mkdirSync(testsDir, { recursive: true });
      var testData = {
        key: evt.testKey || evt.key,
        sourceKey: evt.key,
        summary: evt.summary || "",
        strategy: evt.strategy || "auto",
        csvPath: evt.csvPath || null,
        status: "queued",
        queuedAt: new Date().toISOString()
      };
      fs.writeFileSync(path.join(testsDir, testData.key + ".json"), JSON.stringify(testData, null, 2));
      console.log("[BUS] test:generated → " + testData.key + " ajouté à la file");
      bus.publish("test:queued", testData);
    } catch(e) { console.error("[BUS] Erreur test:generated :", e.message); }
  });

  // test:completed PASS → commenter le ticket Jira
  bus.on("test:completed", function(evt) {
    try {
      if (!evt.key || !evt.status) return;
      if (evt.status === "PASS") {
        console.log("[BUS] test:completed PASS → commentaire Jira " + evt.key);
        var comment = "Test Playwright " + (evt.mode || "ui") + " : " + evt.pass + " PASS / " + evt.fail + " FAIL — env " + (evt.env || "?");
        jiraComment(evt.key, comment);
      }
      if (evt.status === "FAIL" && evt.key) {
        console.log("[BUS] test:completed FAIL → " + evt.key + " (failType: " + (evt.failType || "?") + ")");
        var failComment = "Test Playwright FAIL : " + evt.fail + " échec(s) — " + (evt.failType || "unknown") + " — env " + (evt.env || "?");
        jiraComment(evt.key, failComment);
      }
      if (evt.status === "BLOCKED" && evt.failType === "CLOUDFLARE_BLOCKED") {
        bus.publish("session:expired", {
          env: evt.env || "sophie",
          reason: "Cloudflare block durant test " + evt.key
        });
      }
      // Mettre à jour le plan de test si le ticket en a un
      updateTestPlanStep(evt.key, "playwright", evt.mode || "ui",
        evt.status === "PASS" || evt.status === "FAIL" ? evt.status.toLowerCase() : "fail",
        { pass: evt.pass, fail: evt.fail, total: evt.total, reportPath: evt.reportPath });
      // Diagnostic IA
      if (evt.key && evt.status !== "BLOCKED") runDiagnosticIA("playwright", evt);
    } catch(e) { console.error("[BUS] Erreur test:completed :", e.message); }
  });

  // test:api-completed → commenter le ticket Jira
  bus.on("test:api-completed", function(evt) {
    try {
      if (!evt.key) return;
      var comment = "Test API (" + (evt.collectionName || "?") + ") : " + (evt.pass || 0) + " PASS / " + (evt.fail || 0) + " FAIL — env " + (evt.env || "?");
      console.log("[BUS] test:api-completed → commentaire Jira " + evt.key);
      jiraComment(evt.key, comment);
      updateTestPlanStep(evt.key, "newman", "api",
        (evt.fail || 0) > 0 ? "fail" : "pass",
        { pass: evt.pass, fail: evt.fail, total: evt.total });
      // Diagnostic IA
      if (evt.key) runDiagnosticIA("newman", evt);
    } catch(e) { console.error("[BUS] Erreur test:api-completed :", e.message); }
  });

  // test:mobile-completed → commenter le ticket Jira
  bus.on("test:mobile-completed", function(evt) {
    try {
      if (!evt.key) return;
      var comment = "Test Mobile (" + (evt.device || "?") + ") : " + (evt.pass || 0) + " PASS / " + (evt.fail || 0) + " FAIL — env " + (evt.env || "?");
      console.log("[BUS] test:mobile-completed → commentaire Jira " + evt.key);
      jiraComment(evt.key, comment);
      updateTestPlanStep(evt.key, "appium", null,
        (evt.fail || 0) > 0 ? "fail" : "pass",
        { pass: evt.pass, fail: evt.fail, total: evt.total });
      // Diagnostic IA
      if (evt.key) runDiagnosticIA("appium", evt);
    } catch(e) { console.error("[BUS] Erreur test:mobile-completed :", e.message); }
  });

  // css:completed → log + update plan
  bus.on("css:completed", function(evt) {
    try {
      if (evt.issues && evt.issues.length > 0) {
        console.log("[BUS] css:completed → " + evt.issues.length + " issue(s) sur " + (evt.env || "?") + "/" + (evt.browser || "?"));
      }
      if (evt.key) {
        var cssPass = (evt.scores && evt.scores.length > 0) ? evt.scores.every(function(s) { return s >= 80; }) : true;
        updateTestPlanStep(evt.key, "css-audit", "css",
          cssPass ? "pass" : "fail",
          { pages: evt.pages, scores: evt.scores, reportPath: evt.reportPath });
        // Diagnostic IA
        evt.status = cssPass ? "PASS" : "FAIL";
        runDiagnosticIA("css-audit", evt);
      }
    } catch(e) { console.error("[BUS] Erreur css:completed :", e.message); }
  });

  // drupal:completed → update plan
  bus.on("drupal:completed", function(evt) {
    try {
      if (!evt.key) return;
      console.log("[BUS] drupal:completed → " + evt.key + " (" + evt.pass + "/" + evt.total + " pass)");
      var drupalStatus = (evt.fail || 0) > 0 ? "fail" : "pass";
      updateTestPlanStep(evt.key, "drupal", null, drupalStatus,
        { pass: evt.pass, fail: evt.fail, total: evt.total, env: evt.env, type: evt.type, reportPath: evt.reportPath });
      // Diagnostic IA
      evt.status = drupalStatus === "pass" ? "PASS" : "FAIL";
      runDiagnosticIA("drupal", evt);
    } catch(e) { console.error("[BUS] Erreur drupal:completed :", e.message); }
  });

  // test:retry → re-lancer un test Playwright après diagnostic IA RERUN
  bus.on("test:retry", function(evt) {
    try {
      if (!evt.key) return;
      console.log("[BUS] test:retry → re-lancement " + evt.key + " (" + (evt.tool || "playwright") + ") — raison: " + (evt.reason || "?"));
      var retryArgs = [
        "agent-playwright-direct.js",
        "--mode=" + (evt.mode || "ui"),
        "--source=url",
        "--env=" + (evt.env || "sophie"),
        "--key=" + evt.key
      ];
      if (evt.urls) {
        var urlsTmpFile = path.join(BASE_DIR, "uploads", ".pw-retry-urls.txt");
        try { fs.writeFileSync(urlsTmpFile, Array.isArray(evt.urls) ? evt.urls.join("\n") : String(evt.urls), "utf8"); } catch(e2) {}
        retryArgs.push("--urls-file=" + urlsTmpFile);
      }
      runAgent("playwright-retry", "node", retryArgs, "default", false, {
        bufferLogs: true,
        timeout: 5 * 60,
        onDone: function(exitCode, logs) {
          var rLine = logs.find(function(l) { return l.startsWith("PLAYWRIGHT_DIRECT_RESULT:"); });
          if (!rLine) return;
          try {
            var result = JSON.parse(rLine.replace("PLAYWRIGHT_DIRECT_RESULT:", ""));
            result._retried = true;
            result._retryReason = evt.reason || "diagnostic-rerun";
            console.log("[RETRY] " + evt.key + " terminé → " + (result.status || "?") + " (" + (result.pass || 0) + " pass / " + (result.fail || 0) + " fail)");
            bus.publish("test:retry-completed", {
              key: evt.key, status: result.status, pass: result.pass, fail: result.fail,
              reason: evt.reason, diagnostic: evt.diagnostic
            });
          } catch(e) { console.error("[RETRY] Erreur parse résultat:", e.message); }
        }
      });
    } catch(e) { console.error("[BUS] Erreur test:retry :", e.message); }
  });

  // bug:detected → notification dashboard (bug local créé, en attente de revue)
  bus.on("bug:detected", function(evt) {
    try {
      console.log("[BUS] bug:detected → " + evt.key + " — " + (evt.summary || "").substring(0, 60));
    } catch(e) { console.error("[BUS] Erreur bug:detected :", e.message); }
  });

  // session:expired → log alerte
  bus.on("session:expired", function(evt) {
    console.log("[BUS] ⚠️ session:expired → " + (evt.env || "?") + " : " + (evt.reason || ""));
  });

  // agent:error → log
  bus.on("agent:error", function(evt) {
    console.error("[BUS] ❌ agent:error → " + (evt.agent || "?") + " : " + (evt.error || ""));
  });

  console.log("  🔌 Event Bus : actif — " + bus.eventNames().length + " événements câblés");
  console.log("==================================================");
});

server.on("error", function(e) {
  if (e.code === "EADDRINUSE") {
    console.error("[ERR] Port " + PORT + " deja utilise. Ferme l'ancien serveur.");
  } else {
    console.error("[ERR]", e.message);
  }
  process.exit(1);
});

// ── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────
process.on("SIGTERM", function() {
  console.log("[SHUTDOWN] SIGTERM reçu — fermeture propre...");
  server.close(function() {
    console.log("[SHUTDOWN] Serveur fermé");
    process.exit(0);
  });
  setTimeout(function() {
    console.error("[SHUTDOWN] Timeout 10s — forçage sortie");
    process.exit(1);
  }, 10000);
});

process.on("SIGINT", function() {
  console.log("[SHUTDOWN] SIGINT reçu — fermeture propre...");
  server.close(function() { process.exit(0); });
  setTimeout(function() { process.exit(1); }, 5000);
});

process.on("uncaughtException", function(err) {
  console.error("[CRITIQUE] Exception non capturée :", err.message, err.stack);
});

process.on("unhandledRejection", function(reason) {
  console.error("[CRITIQUE] Promise rejetée non gérée :", reason);
});


