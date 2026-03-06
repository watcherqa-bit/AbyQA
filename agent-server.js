// agent-server.js v2 - Serveur local Aby QA V2
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

const CHAT_SYSTEM = `Tu es Aby — assistant IA polyvalent intégré à la plateforme AbyQA V3 pour Safran Group.

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
- Si une question concerne directement l'app AbyQA ou Safran, contextualise ta réponse en conséquence`;
const PORT        = CFG.server.port;
const BASE_DIR    = __dirname;
const REPORTS_DIR = CFG.paths.reports;
const UPLOADS_DIR = CFG.paths.uploads;

// â"€â"€ ROUTER LLM (ajout V2 Lead QA IA) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const router          = require("./agent-router");
const AVAILABLE_AGENTS = router.AVAILABLE_AGENTS;

// â"€â"€ POLLER JIRA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const poller = require("./agent-poller");

// â"€â"€ ORCHESTRATEUR CYCLES QA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const cycle = require("./agent-cycle");

var sseClients   = {};
var runningProcs = {};

// Protection anti-double run : Map agent â†’ true si en cours
var agentLocks = {};

// â"€â"€ Surveillance Jira Queue â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
var queueProc  = null;
var queueStats = { count: 0, lastCheck: null, running: false };

function sendSSE(clientId, data) {
  var clients = sseClients[clientId] || [];
  clients.forEach(function(res) {
    try { res.write("data: " + JSON.stringify(data) + "\n\n"); } catch(e) {}
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
    try { runningProcs[agentId].kill(); } catch(e) {}
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

  proc.stdout.on("data", function(data) {
    data.toString().split("\n").forEach(function(line) {
      if (line.trim()) {
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
    delete runningProcs[agentId];
    delete agentLocks[agentId];
    sendSSE(clientId, { type: "done", agent: agentId, code: code });
    if (opts.onDone) opts.onDone(code, logBuf);
    // Auto-debug : dÃ©clencher l'analyse IA si erreur
    if (code !== 0 && !opts.skipAutoDebug) triggerAutoDebug(agentId, logBuf, clientId);
  });
  proc.on("error", function(e) {
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
    } catch(e) {}
  }

  // 4. Notifier le dashboard que l'analyse est en cours
  sendSSE(clientId, { type: "log", agent: agentId,
    line: "ðŸ§ [AUTO-DEBUG] Erreur dÃ©tectÃ©e  —  analyse IA en cours..." });

  // 5. Appeler Claude
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
      return ["agent-playwright.js", params.demand || "Tester la page d'accueil", env];
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

var server = http.createServer(function(req, res) {
  var url    = req.url.split("?")[0];
  var method = req.method;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Atlassian-Token");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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

  // â"€â"€ API : TÃ©lÃ©charger un fichier du dossier reports â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "GET" && url.startsWith("/api/download/")) {
    var fname = decodeURIComponent(url.replace("/api/download/", ""));
    var fpath = path.join(BASE_DIR, "reports", fname);
    if (fs.existsSync(fpath)) {
      var ext  = path.extname(fname).toLowerCase();
      var mime = ext===".csv"?"text/csv":ext===".html"?"text/html":ext===".json"?"application/json":"application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, 'Content-Disposition': 'attachment; filename="' + fname + '"' });
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
          "Tu es expert QA chez Safran Group.\n\n" +
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
          " \"proposedTests\":[{\"name\":\"...\",\"type\":\"auto\",\"steps\":[\"...\"],\"expectedResult\":\"...\"}]}\n\n" +
          "Si TEST :\n" +
          "{\"ticketType\":\"TEST\",\"title\":\"Test - [Titre_US] - ...\",\n" +
          " \"description\":\"...\",\"testType\":\"auto|manual\",\"testTypeJustification\":\"...\",\n" +
          " \"testCases\":[{\"id\":\"TC-01\",\"action\":\"Étant donné...\\nLorsque...\\nAlors...\",\"data\":\"• Clé: Valeur\",\"expected\":\"• Critère 1\\n• Critère 2\"}],\n" +
          " \"proposedTests\":[{\"name\":\"...\",\"type\":\"auto\",\"steps\":[\"...\"],\"expectedResult\":\"...\"}]}\n\n" +
          "Si BUG :\n" +
          "{\"ticketType\":\"BUG\",\"title\":\"Bug - [Titre_US] - ...\",\n" +
          " \"description\":\"...\",\n" +
          " \"steps\":[\"1. Accéder à...\",\"2. Cliquer sur...\"],\n" +
          " \"actualResult\":\"...\",\"expectedResult\":\"...\",\n" +
          " \"severity\":\"Critique|Majeur|Mineur|Cosmétique\",\n" +
          " \"fixTests\":[\"Vérifier que...\",\"Tester le cas nominal...\"],\n" +
          " \"proposedTests\":[{\"name\":\"...\",\"type\":\"auto\",\"steps\":[\"Naviguer vers URL réelle\",\"Effectuer l'action précise\",\"Vérifier le comportement attendu\"],\"expectedResult\":\"...\"}]}\n\n" +
          "Génère : 3-6 acceptanceCriteria (US), 3-6 testCases (TEST), 3-6 steps + 2-4 fixTests (BUG).\n" +
          "Pour proposedTests : 2 à 4 scénarios couvrant le cas nominal, le cas limite, et la régression.";

        var result = await leadQA.askJSON(prompt, "claude-sonnet-4-6");

        // Générer CSV Xray pour les TEST
        if (result && result.ticketType === "TEST" && Array.isArray(result.testCases)) {
          var csvLines = ['"Action","Données","Résultat Attendu"'];
          result.testCases.forEach(function(tc) {
            csvLines.push(
              '"' + (tc.action   || "").replace(/"/g, '""') + '",' +
              '"' + (tc.data     || "").replace(/"/g, '""') + '",' +
              '"' + (tc.expected || "").replace(/"/g, '""') + '"'
            );
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
          summary:     body.title || "Ticket généré par AbyQA",
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
              var linkTypeName = (body.ticketType === "TEST") ? "Tests" : "Relates";
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
      try { importKey = JSON.parse(importBody).key; } catch(e) {}
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
    } catch(e) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }

  if (method === "GET" && url.startsWith("/api/download/")) {
    var fileName = decodeURIComponent(url.replace("/api/download/", ""));
    var filePath = path.join(REPORTS_DIR, fileName);
    if (fs.existsSync(filePath)) {
      var ext = path.extname(fileName);
      var ct  = ext === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : ext === ".csv"  ? "text/csv"
              : ext === ".md"   ? "text/markdown; charset=utf-8"
              : ext === ".html" ? "text/html; charset=utf-8"
              : "text/plain";
      res.writeHead(200, { "Content-Type": ct, "Content-Disposition": "attachment; filename=\"" + fileName + "\"" });
      fs.createReadStream(filePath).pipe(res);
    } else { res.writeHead(404); res.end("Fichier introuvable"); }
    return;
  }

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
            runAgent(agent, "node", cssArgs, clientId);
            break;
          case "playwright":
            runAgent(agent, "node", ["agent-playwright.js", params.demand || "Tester la page d'accueil", params.env || "sophie"], clientId);
            break;
          case "xray-pipeline":
            if (!params.xmlPath) { sendSSE(clientId, { type: "err", agent: agent, line: "Fichier XML manquant" }); break; }
            var localXml1 = path.join(BASE_DIR, "uploads", "ticket.xml");
            try { fs.copyFileSync(params.xmlPath, localXml1); } catch(e) {}
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
            try { fs.copyFileSync(params.xmlPath, localXmlPW); } catch(e) {}
            var pwArgs = ["agent-playwright-multi.js", "uploads/ticket.xml"];
            if (params.envs)         pwArgs.push("--envs=" + params.envs);
            if (params.devices)      pwArgs.push("--devices=" + params.devices);
            if (params.browsers)     pwArgs.push("--browsers=" + params.browsers);
            if (params.instructions) pwArgs.push("--instructions=" + params.instructions);
            runAgent(agent, "node", pwArgs, clientId);
            break;
          case "jira-reader":
            if (!params.xmlPath) { sendSSE(clientId, { type: "err", agent: agent, line: "Fichier XML manquant" }); break; }
            var localXml2 = path.join(BASE_DIR, "uploads", "ticket.xml");
            try { fs.copyFileSync(params.xmlPath, localXml2); } catch(e) {}
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
            runAgent(agent, "node", ["agent-drupal.js", d2, params.env || "sophie"], clientId);
            break;
          case "drupal-audit":
            runAgent(agent, "node", ["agent-drupal-audit.js", params.env || "sophie"], clientId);
            break;
          case "generate-ticket":
            var tt = params.ticketType || "us";
            var te = params.epic || "API Drupal";
            var td = params.desc || "";
            var tp = tt === "us"   ? "GÃ©nÃ¨re une US pour " + td + " dans l'epic '" + te + "'" :
                     tt === "test" ? "GÃ©nÃ¨re un ticket de test pour " + td + (params.us ? " de "+params.us : "") + " dans l'epic '" + te + "'" :
                     tt === "bug"  ? "GÃ©nÃ¨re un ticket bug pour " + td + " dans l'epic '" + te + "'" :
                                     "GÃ©nÃ¨re un CSV avec " + (params.nb||"5") + " cas de test pour " + td;
            runAgent(agent, "node", ["agent.js", tp], clientId);
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
            var pdArgs = [
              "agent-playwright-direct.js",
              "--mode="    + (params.mode    || "ui"),
              "--source="  + (params.source  || "url"),
              (params.envs && params.envs.length > 1
                ? "--envs=" + params.envs.join(",")
                : "--env="  + (params.env || (Array.isArray(params.envs) && params.envs[0]) || "sophie"))
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
            if (params.dryRun)   pdArgs.push("--dry-run");
            // XML uploadÃ©
            if (params.xmlPath) {
              var pdXml = path.join(BASE_DIR, "uploads", "ticket.xml");
              try { fs.copyFileSync(params.xmlPath, pdXml); } catch(e) {}
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
                  try { fs.writeFileSync(path.join(BASE_DIR, "reports", dName), JSON.stringify(diagContent, null, 2), "utf8"); } catch(e) {}
                }
                // Capturer les logs de tests FAIL → inbox/logs/
                var logLines2 = logs.filter(function(l) { return l.startsWith("PLAYWRIGHT_TEST_LOG:"); });
                if (logLines2.length > 0) {
                  var logsDir2 = path.join(BASE_DIR, "inbox", "logs");
                  if (!fs.existsSync(logsDir2)) { try { fs.mkdirSync(logsDir2, { recursive: true }); } catch(e) {} }
                  logLines2.forEach(function(line) {
                    try {
                      var logData2 = JSON.parse(line.replace("PLAYWRIGHT_TEST_LOG:", ""));
                      var logId2   = (logData2.ticketKey || "NO-KEY") + "-" + Date.now();
                      var logFile2 = path.join(logsDir2, logId2 + ".json");
                      fs.writeFileSync(logFile2, JSON.stringify(Object.assign({ id: logId2 }, logData2), null, 2), "utf8");
                      sendSSE(pdClientId,  { type: "test-log-new", log: Object.assign({ id: logId2 }, logData2) });
                      if (pdClientId !== "default") sendSSE("default", { type: "test-log-new", log: Object.assign({ id: logId2 }, logData2) });
                    } catch(e) {}
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

  // â"€â"€ API : LLM Router  —  Lead QA IA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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

  // â"€â"€ API : LLM Playground  —  proxy Ollama streaming â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/llm") {
    var llmChunks = [];
    req.on("data", function(c) { llmChunks.push(c); });
    req.on("end", function() {
      var body;
      try { body = JSON.parse(Buffer.concat(llmChunks).toString()); } catch(e) { body = {}; }
      var prompt      = body.prompt      || "";
      var model       = body.model       || CFG.ollama.model;
      var system      = body.system      || "";
      var clientId    = body.clientId    || "llm-playground";
      var agentLabel  = body.agentId     || "llm-playground";

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "prompt vide" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      var messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });

      var payload = JSON.stringify({ model: model, messages: messages, stream: true,
        options: { temperature: 0.3 } });
      var t0 = Date.now();
      var tokenCount = 0;

      sendSSE(clientId, { type: "start", agent: agentLabel,
        cmd: model + "  —  " + prompt.substring(0, 60) });

      var ollamaReq = http.request({
        hostname: CFG.ollama.host, port: CFG.ollama.port,
        path: "/api/chat", method: "POST",
        headers: { "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload) }
      }, function(ollamaRes) {
        ollamaRes.on("data", function(chunk) {
          chunk.toString().split("\n").filter(Boolean).forEach(function(line) {
            try {
              var tok = JSON.parse(line);
              var text = tok.message && tok.message.content ? tok.message.content : "";
              if (text) {
                tokenCount++;
                sendSSE(clientId, { type: "token", agent: agentLabel, token: text });
              }
              if (tok.done) {
                var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                var tps = elapsed > 0 ? (tokenCount / parseFloat(elapsed)).toFixed(1) : "?";
                sendSSE(clientId, { type: "done", agent: agentLabel, code: 0,
                  stats: { elapsed: elapsed, tokens: tokenCount, tps: tps, model: model } });
              }
            } catch(e) {}
          });
        });
        ollamaRes.on("error", function(e) {
          sendSSE(clientId, { type: "err", agent: agentLabel,
            line: "Ollama erreur : " + e.message });
        });
      });
      ollamaReq.on("error", function(e) {
        sendSSE(clientId, { type: "err", agent: agentLabel,
          line: "Ollama injoignable : " + e.message });
      });
      ollamaReq.write(payload);
      ollamaReq.end();
    });
    return;
  }

  // â"€â"€ API : Chat Claude (streaming SSE) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/chat") {
    var chatChunks = [];
    req.on("data", function(c) { chatChunks.push(c); });
    req.on("end", function() {
      var body;
      try { body = JSON.parse(Buffer.concat(chatChunks).toString()); } catch(e) { body = {}; }
      var messages = body.messages || [];
      var modelKey = body.model    || "haiku";
      var clientId = body.clientId || "default";
      var MODEL    = modelKey === "sonnet" ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001";

      if (!messages.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "messages vides" }));
        return;
      }
      if (!_chatAnthropicClient) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "ANTHROPIC_API_KEY non configurÃ©e dans .env" }));
        return;
      }

      // Troncature des messages pour rester sous ~25 000 tokens (≈100 000 chars)
      var MAX_CHARS = 100000;
      var totalChars = messages.reduce(function(sum, m) {
        var c = m.content;
        if (typeof c === 'string') return sum + c.length;
        if (Array.isArray(c)) return sum + c.reduce(function(s, b) { return s + (b.text ? b.text.length : 2000); }, 0);
        return sum;
      }, 0);
      var truncated = false;
      while (messages.length > 1 && totalChars > MAX_CHARS) {
        var removed = messages.shift();
        var rLen = typeof removed.content === 'string' ? removed.content.length : 4000;
        totalChars -= rLen;
        truncated = true;
      }
      if (truncated) {
        sendSSE(clientId, { type: 'chat-token', token: '_(historique tronqué — gardez vos messages courts pour rester sous la limite de tokens)_\n\n' });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: MODEL }));

      // Streaming avec retry sur rate-limit (429)
      var MAX_RETRY_CHAT = 3;
      var chatAttempt = 0;
      function tryChatStream() {
        chatAttempt++;
        var stream = _chatAnthropicClient.messages.stream({
          model:      MODEL,
          max_tokens: 4096,
          system:     CHAT_SYSTEM,
          messages:   messages
        });
        stream.on('text', function(text) {
          sendSSE(clientId, { type: 'chat-token', token: text });
        });
        stream.on('finalMessage', function() {
          sendSSE(clientId, { type: 'chat-done' });
        });
        stream.on('error', function(err) {
          if (err.status === 429 && chatAttempt < MAX_RETRY_CHAT) {
            var wait = [8000, 20000][chatAttempt - 1] || 20000;
            sendSSE(clientId, { type: 'chat-token', token: '\n\n⏳ _Rate limit atteint — nouvelle tentative dans ' + (wait/1000) + 's\u2026_\n\n' });
            setTimeout(tryChatStream, wait);
          } else if (err.status === 429) {
            sendSSE(clientId, { type: 'chat-error', message: 'Rate limit Claude API atteint (429). Patiente 1 minute ou passe en mode Sonnet.' });
          } else {
            sendSSE(clientId, { type: 'chat-error', message: err.message });
          }
        });
      }
      tryChatStream();
    });
    return;
  }

  // â"€â"€ API : ModÃ¨les Ollama disponibles â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "GET" && url === "/api/ollama-models") {
    var modelsReq = http.request({
      hostname: CFG.ollama.host, port: CFG.ollama.port,
      path: "/api/tags", method: "GET"
    }, function(modelsRes) {
      var modChunks = [];
      modelsRes.on("data", function(c) { modChunks.push(c); });
      modelsRes.on("end", function() {
        try {
          var data = JSON.parse(Buffer.concat(modChunks).toString());
          var names = (data.models || []).map(function(m) { return m.name; });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, models: names }));
        } catch(e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "parse error" }));
        }
      });
    });
    modelsReq.on("error", function(e) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Ollama injoignable : " + e.message }));
    });
    modelsReq.setTimeout(5000, function() {
      modelsReq.destroy();
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Ollama timeout" }));
    });
    modelsReq.end();
    return;
  }

  // â"€â"€ API : Analyse de fichier (Claude Vision / extraction HTML / texte) â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/analyze-file") {
    var afChunks = [];
    req.on("data", function(c) { afChunks.push(c); });
    req.on("end", function() {
      try {
        var afBody = JSON.parse(Buffer.concat(afChunks).toString());
        var afData     = afBody.data     || "";  // base64
        var afMime     = afBody.mimeType || "text/plain";
        var afFilename = afBody.filename || "file";
        var afContext  = afBody.context  || "";  // "enriched" | "playwright"
        var afKey      = afBody.key      || "";  // ticket key pour stocker

        // Sauvegarder le fichier localement si une clÃ© est fournie
        if (afKey && afData) {
          var attachDir = path.join(BASE_DIR, "inbox", "enriched", "attachments", afKey);
          fs.mkdirSync(attachDir, { recursive: true });
          var ext = afFilename.split(".").pop() || "bin";
          var timestamp = Date.now();
          var savedName = timestamp + "-" + afFilename.replace(/[^a-z0-9._-]/gi, "_");
          fs.writeFileSync(path.join(attachDir, savedName), Buffer.from(afData, "base64"));
        }

        // Analyser selon le type
        var imageTypes = ["image/png","image/jpeg","image/jpg","image/gif","image/webp"];
        var isImage = imageTypes.some(function(t) { return afMime.includes(t.split("/")[1]); });

        if (isImage) {
          // Claude Vision
          leadQA.analyzeImage(afData, afMime)
            .then(function(analysis) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, type: "image", text: analysis, filename: afFilename }));
            })
            .catch(function(e) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, type: "image", text: "Analyse non disponible : " + e.message, filename: afFilename }));
            });
        } else if (afMime.includes("html")) {
          // Extraction HTML
          var htmlContent = Buffer.from(afData, "base64").toString("utf8");
          var extracted   = leadQA.extractFromHTML(htmlContent);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, type: "html", text: extracted.text, selectors: extracted.selectors, filename: afFilename }));
        } else {
          // Texte brut / markdown / CSV
          var textContent = Buffer.from(afData, "base64").toString("utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, type: "text", text: textContent.substring(0, 4000), filename: afFilename }));
        }
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
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
      var boundary = "----AbyQABoundary" + Date.now();
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

  // â"€â"€ API : US Enrichies  —  stockage + Ã©diteur â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  var ENRICHED_DIR = path.join(BASE_DIR, "inbox", "enriched");
  if (!fs.existsSync(ENRICHED_DIR)) fs.mkdirSync(ENRICHED_DIR, { recursive: true });

  // Lister toutes les US enrichies
  if (method === "GET" && url === "/api/enriched") {
    try {
      var files = fs.readdirSync(ENRICHED_DIR).filter(function(f) { return f.endsWith(".json"); });
      var list  = files.map(function(f) {
        try {
          var d = JSON.parse(fs.readFileSync(path.join(ENRICHED_DIR, f), "utf8"));
          return { key: d.key, summary: d.summary, epic: d.epic, score: d.score,
                   status: d.status, createdAt: d.createdAt, issues: d.issues,
                   type: d.type || "Story",
                   testUrls: Array.isArray(d.testUrls) ? d.testUrls : [] };
        } catch(e) { return null; }
      }).filter(Boolean).sort(function(a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
    return;
  }

  // RÃ©cupÃ©rer une US enrichie (avec le markdown complet)
  if (method === "GET" && url.startsWith("/api/enriched/")) {
    var enrichKey = url.replace("/api/enriched/", "").split("/")[0];
    var enrichFile = path.join(ENRICHED_DIR, enrichKey + ".json");
    if (fs.existsSync(enrichFile)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(fs.readFileSync(enrichFile, "utf8"));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "US introuvable" }));
    }
    return;
  }

  // Sauvegarder les modifications (Ã©diteur markdown)
  if (method === "PUT" && url.startsWith("/api/enriched/")) {
    var putKey  = url.replace("/api/enriched/", "").split("/")[0];
    var putFile = path.join(ENRICHED_DIR, putKey + ".json");
    var putBody = "";
    req.on("data", function(c) { putBody += c; });
    req.on("end", function() {
      try {
        var putData = JSON.parse(putBody);
        if (!fs.existsSync(putFile)) { res.writeHead(404); res.end("Introuvable"); return; }
        var existing = JSON.parse(fs.readFileSync(putFile, "utf8"));
        existing.enrichedMarkdown = putData.markdown || existing.enrichedMarkdown;
        existing.updatedAt = new Date().toISOString();
        fs.writeFileSync(putFile, JSON.stringify(existing, null, 2), "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Approuver â†’ push dans Jira
  if (method === "POST" && url.startsWith("/api/enriched/") && url.endsWith("/approve")) {
    var apKey  = url.replace("/api/enriched/", "").replace("/approve", "");
    var apFile = path.join(ENRICHED_DIR, apKey + ".json");
    var apBody = "";
    req.on("data", function(c) { apBody += c; });
    req.on("end", function() {
      if (!fs.existsSync(apFile)) { res.writeHead(404); res.end("Introuvable"); return; }
      var apData   = JSON.parse(fs.readFileSync(apFile, "utf8"));
      var markdown = apData.enrichedMarkdown || "";
      var https2   = require("https");
      var auth2    = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
      var jiraBody = JSON.stringify({
        fields: {
          description: {
            type: "doc", version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: markdown }] }]
          }
        }
      });
      var jiraReq = https2.request({
        hostname: CFG.jira.host,
        path: "/rest/api/3/issue/" + apKey,
        method: "PUT",
        headers: { "Authorization": "Basic " + auth2, "Content-Type": "application/json",
                   "Content-Length": Buffer.byteLength(jiraBody) }
      }, function(jiraRes) {
        apData.status     = "approved";
        apData.approvedAt = new Date().toISOString();
        fs.writeFileSync(apFile, JSON.stringify(apData, null, 2), "utf8");

        // Attacher automatiquement les fichiers stockÃ©s localement
        var attachDir = path.join(BASE_DIR, "inbox", "enriched", "attachments", apKey);
        var attachedFiles = 0;
        if (fs.existsSync(attachDir)) {
          var afiles = fs.readdirSync(attachDir);
          attachedFiles = afiles.length;
          // Lancer l'attachement en arriÃ¨re-plan (non bloquant)
          if (afiles.length > 0) {
            var https3 = require("https");
            var auth3  = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
            afiles.forEach(function(fname) {
              var fdata = fs.readFileSync(path.join(attachDir, fname));
              var ext   = fname.split(".").pop().toLowerCase();
              var mimeMap2 = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif",
                               webp:"image/webp", html:"text/html", txt:"text/plain", md:"text/plain", pdf:"application/pdf" };
              var fmime = mimeMap2[ext] || "application/octet-stream";
              var bound2 = "----AbyQABnd" + Date.now();
              var hdr  = Buffer.from("--" + bound2 + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fname + "\"\r\nContent-Type: " + fmime + "\r\n\r\n");
              var foot = Buffer.from("\r\n--" + bound2 + "--\r\n");
              var body2 = Buffer.concat([hdr, fdata, foot]);
              var ar = https3.request({
                hostname: CFG.jira.host,
                path: "/rest/api/3/issue/" + apKey + "/attachments",
                method: "POST",
                headers: { "Authorization":"Basic " + auth3, "X-Atlassian-Token":"no-check",
                           "Content-Type":"multipart/form-data; boundary=" + bound2, "Content-Length": body2.length }
              }, function() {});
              ar.on("error", function() {});
              ar.write(body2); ar.end();
            });
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, key: apKey, jiraStatus: jiraRes.statusCode, attachedFiles: attachedFiles }));
      });
      jiraReq.on("error", function(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      jiraReq.write(jiraBody);
      jiraReq.end();
    });
    return;
  }

  // Rejeter â†’ supprimer du stockage
  if (method === "POST" && url.startsWith("/api/enriched/") && url.endsWith("/reject")) {
    var rjKey  = url.replace("/api/enriched/", "").replace("/reject", "");
    var rjFile = path.join(ENRICHED_DIR, rjKey + ".json");
    if (fs.existsSync(rjFile)) {
      var rjData = JSON.parse(fs.readFileSync(rjFile, "utf8"));
      rjData.status    = "rejected";
      rjData.rejectedAt = new Date().toISOString();
      fs.writeFileSync(rjFile, JSON.stringify(rjData, null, 2), "utf8");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // â"€â"€ API : File des tests prÃªts Ã  lancer dans Playwright Direct â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  var TESTS_DIR2 = path.join(BASE_DIR, "inbox", "tests");
  if (!fs.existsSync(TESTS_DIR2)) fs.mkdirSync(TESTS_DIR2, { recursive: true });

  if (method === "GET" && url === "/api/tests-queue") {
    try {
      var tFiles = fs.readdirSync(TESTS_DIR2).filter(function(f) { return f.endsWith(".json"); });
      var tList  = tFiles.map(function(f) {
        try {
          var d = JSON.parse(fs.readFileSync(path.join(TESTS_DIR2, f), "utf8"));
          return { key: d.key, jiraKey: d.jiraKey, sourceKey: d.sourceKey, title: d.title,
                   mode: d.mode, strategy: d.strategy, status: d.status, createdAt: d.createdAt };
        } catch(e2) { return null; }
      }).filter(Boolean).sort(function(a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tList));
    } catch(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
    return;
  }

  if (method === "GET" && url.startsWith("/api/tests-queue/")) {
    var tKey  = url.replace("/api/tests-queue/", "").split("?")[0];
    var tFile = path.join(TESTS_DIR2, tKey + ".json");
    if (fs.existsSync(tFile)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(fs.readFileSync(tFile, "utf8"));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Test introuvable" }));
    }
    return;
  }

  if (method === "DELETE" && url.startsWith("/api/tests-queue/")) {
    var dtKey  = url.replace("/api/tests-queue/", "").split("?")[0];
    var dtFile = path.join(TESTS_DIR2, dtKey + ".json");
    if (fs.existsSync(dtFile)) {
      var dtData = JSON.parse(fs.readFileSync(dtFile, "utf8"));
      dtData.status = "done";
      dtData.doneAt = new Date().toISOString();
      fs.writeFileSync(dtFile, JSON.stringify(dtData, null, 2), "utf8");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // â"€â"€ API : ActivitÃ© Jira (todo list) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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
            catch(e) {}
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

        comment += "_Généré par AbyQA — agent-playwright-direct.js_";

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

  // â"€â"€ API : Analyser un screenshot CSS avec Claude Vision â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  if (method === "POST" && url === "/api/analyze-screenshot") {
    var ssChunks = [];
    req.on("data", function(c) { ssChunks.push(c); });
    req.on("end", function() {
      try {
        var ssBody     = JSON.parse(Buffer.concat(ssChunks).toString());
        var ssFilename = ssBody.filename   || "screenshot.png";
        var ssB64      = ssBody.imageBase64 || "";
        var ssMime     = ssBody.mimeType   || "image/png";
        if (!ssB64) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "imageBase64 manquant" })); return; }

                // Réutilise le client global si dispo (évite overhead + rafales)
        var ssClient = _chatAnthropicClient;
        if (!ssClient) {
          var AnthropicSDK2 = require("@anthropic-ai/sdk");
          var Ctor2 = AnthropicSDK2.Anthropic || AnthropicSDK2.default || AnthropicSDK2;
          ssClient = new Ctor2({ apiKey: process.env.ANTHROPIC_API_KEY });
        }

        ssClient.messages.create({
          model: leadQA.MODEL_FAST,
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: [{
              type: "image",
              source: { type: "base64", media_type: ssMime, data: ssB64 }
            }, {
              type: "text",
              text: "Tu es un expert QA visuel CSS. Analyse ce screenshot de page web.\n" +
                    "Fichier : " + ssFilename + "\n\n" +
                    "Identifie :\n" +
                    "1. âŒ ProblÃ¨mes visuels / cassures CSS (layout, overflow, alignement, chevauchements)\n" +
                    "2. âš ï¸ Points d'attention (couleurs, typographie, espacement)\n" +
                    "3. âœ… Ce qui semble correct\n\n" +
                    "Sois concis, liste chaque point sur une ligne sÃ©parÃ©e."
            }]
          }]
        }).then(function(r) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ analysis: r.content[0].text }));
        }).catch(function(e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
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
        if (!/^RAPPORT-(OK|FAIL)-PW-DIRECT-.*\.html$/.test(arFname) && !/^AUDIT-CSS-.*\.md$/.test(arFname)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fichier non autorisÃ©" })); return;
        }
        if (!/^[A-Z]+-\d+$/.test(arJiraKey)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "ClÃ© Jira invalide (ex : SAFE-1234)" })); return;
        }
        var arPath2 = path.join(REPORTS_DIR, arFname);
        if (!fs.existsSync(arPath2)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Fichier introuvable" })); return;
        }
        var fdata2     = fs.readFileSync(arPath2);
        var arAuth2    = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
        var arHttps    = require("https");
        var arBoundary = "----AbyQABound" + Date.now();
        var CRLF2      = "\r\n";
        var hPart2     = Buffer.from("--" + arBoundary + CRLF2 + 'Content-Disposition: form-data; name="file"; filename="' + arFname + '"' + CRLF2 + "Content-Type: text/html" + CRLF2 + CRLF2);
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
        });
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

  // POST /api/cycle/stop/:id  —  arrÃªter un cycle TNR en cours (2 ou 3)
  if (method === "POST" && url.startsWith("/api/cycle/stop/")) {
    var stopId = url.replace("/api/cycle/stop/", "").trim();
    try {
      if (stopId === "2") {
        if (runningProcs["playwright-direct-tnr-release"]) {
          try { runningProcs["playwright-direct-tnr-release"].kill(); } catch(e) {}
          delete runningProcs["playwright-direct-tnr-release"];
          delete agentLocks["playwright-direct-tnr-release"];
        }
        cycle.stopCycle2();
      } else if (stopId === "3") {
        if (runningProcs["playwright-direct-tnr"]) {
          try { runningProcs["playwright-direct-tnr"].kill(); } catch(e) {}
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

  // POST /api/cycle/ticket/:key/run  —  lancer test Playwright sur un ticket validÃ©
  if (method === "POST" && url.startsWith("/api/cycle/ticket/") && url.endsWith("/run")) {
    var ticketKey = url.replace("/api/cycle/ticket/", "").replace("/run", "");
    try {
      cycle.markTicketRunning(ticketKey);
      var c1Settings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8"));
      var c1Args = [
        "agent-playwright-direct.js",
        "--mode=ui",
        "--source=jira-key",
        "--key=" + ticketKey,
        "--envs=" + (c1Settings.envs || ["sophie"]).join(","),
        "--browsers=" + (c1Settings.browsers || ["chromium"]).join(",")
      ];
      runAgent("playwright-direct-c1-" + ticketKey, "node", c1Args, "default", false, {
        onDone: function(exitCode, logs) {
          var c1Result = { pass: 0, fail: 0, total: 0 };
          var rLine = logs.find(function(l) { return l.startsWith("PLAYWRIGHT_DIRECT_RESULT:"); });
          if (rLine) { try { c1Result = JSON.parse(rLine.replace("PLAYWRIGHT_DIRECT_RESULT:","")); } catch(e){} }
          cycle.markTicketDone(ticketKey, c1Result);
          sendSSE("default", { type: "cycle1-ticket-done", key: ticketKey, result: c1Result, ok: exitCode === 0 });
        }
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, key: ticketKey }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
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
          var boundary = "AbyQABoundary" + Date.now();
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

  // GET /api/github-file?url=  —  rÃ©cupÃ©rer un fichier depuis GitHub (raw)
  if (method === "GET" && url.startsWith("/api/github-file")) {
    var httpsGH = require("https");
    var qsGH    = (url.split("?")[1] || "");
    var rawGH   = decodeURIComponent(qsGH.replace(/^.*url=([^&]*).*$/, "$1")).trim();
    // github.com/.../blob/... â†’ raw.githubusercontent.com
    if (rawGH.includes("github.com") && rawGH.includes("/blob/")) {
      rawGH = rawGH.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/");
    }
    if (!rawGH.startsWith("http")) rawGH = "https://raw.githubusercontent.com/" + rawGH;
    var ghReq = httpsGH.get(rawGH, { headers: { "User-Agent": "AbyQA/2" } }, function(ghRes) {
      var chunks = [];
      ghRes.on("data", function(c) { chunks.push(c); });
      ghRes.on("end", function() {
        var content = Buffer.concat(chunks).toString("utf8");
        var fname   = rawGH.split("/").pop() || "file.txt";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: fname, content: content, url: rawGH }));
      });
    });
    ghReq.on("error", function(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // GET /api/websearch?q=  —  recherche web via DuckDuckGo instant answers
  if (method === "GET" && url.startsWith("/api/websearch")) {
    var httpsWS = require("https");
    var qsWS    = (url.split("?")[1] || "");
    var qWS     = decodeURIComponent(qsWS.replace(/^.*q=([^&]*).*$/, "$1")).trim();
    var wsPath  = "/?q=" + encodeURIComponent(qWS) + "&format=json&no_html=1&skip_disambig=1&t=abyqa";
    var wsReq   = httpsWS.get({ hostname: "api.duckduckgo.com", path: wsPath, headers: { "User-Agent": "AbyQA/2" } }, function(wsRes) {
      var data = "";
      wsRes.on("data", function(c) { data += c; });
      wsRes.on("end", function() {
        try {
          var parsed  = JSON.parse(data);
          var results = [];
          if (parsed.AbstractText) results.push({ title: parsed.Heading || qWS, snippet: parsed.AbstractText, url: parsed.AbstractURL || "" });
          (parsed.RelatedTopics || []).slice(0, 8).forEach(function(t) {
            if (t.Text && t.FirstURL) results.push({ title: t.FirstURL.split("/").pop().replace(/_/g, " "), snippet: t.Text, url: t.FirstURL });
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, query: qWS, results: results }));
        } catch(e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message, results: [] }));
        }
      });
    });
    wsReq.on("error", function(e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message, results: [] }));
    });
    return;
  }

  // â"€â"€ Chat Projects  —  CRUD â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  var CHAT_PROJECTS_DIR = path.join(BASE_DIR, "inbox", "chat-projects");
  if (!fs.existsSync(CHAT_PROJECTS_DIR)) fs.mkdirSync(CHAT_PROJECTS_DIR, { recursive: true });

  if (method === "GET" && url === "/api/chat-projects") {
    var cpFiles = [];
    try { cpFiles = fs.readdirSync(CHAT_PROJECTS_DIR).filter(function(f) { return f.endsWith(".json"); }); } catch(e) {}
    var cpList = cpFiles.map(function(f) {
      var stat = fs.statSync(path.join(CHAT_PROJECTS_DIR, f));
      var dat  = {}; try { dat = JSON.parse(fs.readFileSync(path.join(CHAT_PROJECTS_DIR, f), "utf8")); } catch(e) {}
      return { name: f.replace(".json", ""), updatedAt: stat.mtime, messageCount: (dat.messages || []).length };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, projects: cpList }));
    return;
  }

  if (method === "POST" && url === "/api/chat-projects") {
    var cpPostChunks = [];
    req.on("data", function(c) { cpPostChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cpPostChunks).toString()); } catch(e) {}
      var cpName = (body.name || "").replace(/[^\w\s\-]/g, "").trim();
      if (!cpName) { res.writeHead(400); res.end(JSON.stringify({ error: "nom vide" })); return; }
      fs.writeFileSync(path.join(CHAT_PROJECTS_DIR, cpName + ".json"), JSON.stringify({ name: cpName, messages: [], createdAt: new Date() }, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: cpName }));
    });
    return;
  }

  if (method === "GET" && url.startsWith("/api/chat-projects/")) {
    var cpGetName = decodeURIComponent(url.replace("/api/chat-projects/", "").split("?")[0]);
    var cpGetFile = path.join(CHAT_PROJECTS_DIR, cpGetName + ".json");
    if (!fs.existsSync(cpGetFile)) { res.writeHead(404); res.end(JSON.stringify({ error: "introuvable" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fs.readFileSync(cpGetFile));
    return;
  }

  if (method === "PUT" && url.startsWith("/api/chat-projects/")) {
    var cpPutName = decodeURIComponent(url.replace("/api/chat-projects/", "").split("?")[0]);
    var cpPutChunks = [];
    req.on("data", function(c) { cpPutChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cpPutChunks).toString()); } catch(e) {}
      var cpPutFile = path.join(CHAT_PROJECTS_DIR, cpPutName + ".json");
      var existing  = {}; try { if (fs.existsSync(cpPutFile)) existing = JSON.parse(fs.readFileSync(cpPutFile, "utf8")); } catch(e) {}
      existing.messages   = body.messages || [];
      existing.updatedAt  = new Date();
      fs.writeFileSync(cpPutFile, JSON.stringify(existing, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (method === "DELETE" && url.startsWith("/api/chat-projects/")) {
    var cpDelName = decodeURIComponent(url.replace("/api/chat-projects/", "").split("?")[0]);
    var cpDelFile = path.join(CHAT_PROJECTS_DIR, cpDelName + ".json");
    if (fs.existsSync(cpDelFile)) fs.unlinkSync(cpDelFile);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/claude-code  —  exÃ©cuter claude --print <prompt>
  if (method === "POST" && url === "/api/claude-code") {
    var ccChunks = [];
    req.on("data", function(c) { ccChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(ccChunks).toString()); } catch(e) {}
      var ccPrompt   = body.prompt || "";
      var ccClientId = body.clientId || "default";
      if (!ccPrompt) { res.writeHead(400); res.end(JSON.stringify({ error: "prompt vide" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      var ccProc = spawn("claude", ["--print", ccPrompt], { cwd: BASE_DIR, shell: true, env: Object.assign({}, process.env) });
      ccProc.stdout.on("data", function(d) { sendSSE(ccClientId, { type: "chat-token", token: d.toString() }); });
      ccProc.on("close", function() { sendSSE(ccClientId, { type: "chat-done" }); });
      ccProc.on("error", function(err) { sendSSE(ccClientId, { type: "chat-error", message: "claude CLI non disponible : " + err.message }); });
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BACKLOG QA — stockage structuré des tickets en attente + archivés
  // ══════════════════════════════════════════════════════════════════════════
  var BACKLOG_DIR     = path.join(__dirname, "inbox", "backlog");
  var BACKLOG_PENDING = path.join(BACKLOG_DIR, "pending.json");
  var BACKLOG_DONE    = path.join(BACKLOG_DIR, "done.json");

  function ensureBacklogDir() {
    if (!fs.existsSync(BACKLOG_DIR)) fs.mkdirSync(BACKLOG_DIR, { recursive: true });
    if (!fs.existsSync(BACKLOG_PENDING)) fs.writeFileSync(BACKLOG_PENDING, "[]", "utf8");
    if (!fs.existsSync(BACKLOG_DONE))    fs.writeFileSync(BACKLOG_DONE,    "[]", "utf8");
  }
  function readBacklog(file)      { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) { return []; } }
  function writeBacklog(file, arr){ ensureBacklogDir(); fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8"); }

  if (method === "GET" && url === "/api/backlog/pending") {
    ensureBacklogDir();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readBacklog(BACKLOG_PENDING)));
    return;
  }

  if (method === "GET" && url === "/api/backlog/done") {
    ensureBacklogDir();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readBacklog(BACKLOG_DONE)));
    return;
  }

  if (method === "POST" && url === "/api/backlog/add") {
    var blAddChunks = [];
    req.on("data", function(c) { blAddChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(blAddChunks).toString()); } catch(e) {}
      if (!body.key) { res.writeHead(400); res.end(JSON.stringify({ error: "key requis" })); return; }
      ensureBacklogDir();
      var pending = readBacklog(BACKLOG_PENDING);
      var exists  = pending.find(function(t) { return t.key === body.key; });
      if (!exists) {
        pending.push({
          key:        body.key,
          summary:    body.summary || "",
          type:       body.type    || "Story",
          jiraStatus: body.status  || "",
          assignee:   body.assignee|| "",
          priority:   body.priority|| "Medium",
          phase:      body.phase   || "entrant",
          addedAt:    new Date().toISOString(),
          updatedAt:  new Date().toISOString(),
          notes:      "",
          cascadeSuggestion: null,
          xraySteps: null
        });
        writeBacklog(BACKLOG_PENDING, pending);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, added: !exists, key: body.key }));
    });
    return;
  }

  if (method === "PUT" && url.startsWith("/api/backlog/") && url.endsWith("/phase")) {
    var blPhaseKey = url.replace("/api/backlog/", "").replace("/phase", "");
    var blPhaseChunks = [];
    req.on("data", function(c) { blPhaseChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(blPhaseChunks).toString()); } catch(e) {}
      var pending = readBacklog(BACKLOG_PENDING);
      var idx = pending.findIndex(function(t) { return t.key === blPhaseKey; });
      if (idx < 0) { res.writeHead(404); res.end(JSON.stringify({ error: "introuvable" })); return; }
      pending[idx].phase     = body.phase || pending[idx].phase;
      pending[idx].notes     = body.notes !== undefined ? body.notes : pending[idx].notes;
      pending[idx].updatedAt = new Date().toISOString();
      writeBacklog(BACKLOG_PENDING, pending);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (method === "POST" && url.startsWith("/api/backlog/") && url.endsWith("/archive")) {
    var blArchKey = url.replace("/api/backlog/", "").replace("/archive", "");
    var blArchChunks = [];
    req.on("data", function(c) { blArchChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(blArchChunks).toString()); } catch(e) {}
      var pending = readBacklog(BACKLOG_PENDING);
      var done    = readBacklog(BACKLOG_DONE);
      var idx     = pending.findIndex(function(t) { return t.key === blArchKey; });
      if (idx < 0) { res.writeHead(404); res.end(JSON.stringify({ error: "introuvable" })); return; }
      var ticket  = pending.splice(idx, 1)[0];
      done.unshift({
        key:           ticket.key,
        summary:       ticket.summary,
        type:          ticket.type,
        result:        body.result     || "SKIP",
        doneAt:        new Date().toISOString(),
        reportFile:    body.reportFile || null,
        xrayExecution: body.xrayExecution || null,
        notes:         body.notes || ticket.notes || ""
      });
      writeBacklog(BACKLOG_PENDING, pending);
      writeBacklog(BACKLOG_DONE,    done);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (method === "POST" && url === "/api/backlog/sync-jira") {
    var syncMine = req.url.includes("mine=true");
    // Fetch direct Jira → tickets en phase QA → ajoute dans pending.json
    ensureBacklogDir();
    var https8  = require("https");
    var auth8   = CFG.jira.authHeader();
    var qaStatuses8 = ["To Test", "In Test", "To Test UAT", "In validation", "Reopened"];
    // "mine" = tous mes tickets actifs (tous statuts sauf Done)
    // "all"  = tickets QA de toute l'équipe
    var jql8 = syncMine
      ? "project = " + CFG.jira.project + " AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
      : "project = " + CFG.jira.project + " AND issuetype in (Story, Bug, \"Test Case\", Task) AND status in (" + qaStatuses8.map(function(s) { return '"' + s + '"'; }).join(",") + ") ORDER BY updated DESC";
    var sp8Body = JSON.stringify({ jql: jql8, fields: ["summary","status","issuetype","priority","updated","assignee"], maxResults: 50 });

    var sr8 = https8.request({
      hostname: CFG.jira.host, path: "/rest/api/3/search/jql", method: "POST",
      headers: { "Authorization": auth8, "Accept": "application/json", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(sp8Body) }
    }, function(jr8) {
      var d8 = ""; jr8.on("data", function(c) { d8 += c; });
      jr8.on("end", function() {
        try {
          var parsed8  = JSON.parse(d8);
          var issues8  = parsed8.issues || [];
          var pending8 = readBacklog(BACKLOG_PENDING);
          var added8   = 0;
          issues8.forEach(function(i) {
            var key8    = i.key;
            var status8 = i.fields.status ? i.fields.status.name : "";
            // Détecter automatiquement la phase depuis le statut Jira
            var phaseMap8 = {
              "Backlog":"pre-dev","Prepare":"pre-dev","Approve":"pre-dev","Ready for Dev":"pre-dev",
              "In progress":"dev","Blocked":"blocked",
              "To Test":"test","In Test":"test",
              "To Release":"pre-release",
              "Reopened":"uat","To Test UAT":"uat","In validation":"uat"
            };
            var autoPhase8 = phaseMap8[status8] || "entrant";
            var existing8 = pending8.find(function(t) { return t.key === key8; });
            if (!existing8) {
              pending8.push({
                key:        key8,
                summary:    i.fields.summary || "",
                type:       i.fields.issuetype ? i.fields.issuetype.name : "?",
                jiraStatus: status8,
                assignee:   i.fields.assignee  ? i.fields.assignee.displayName : "",
                priority:   i.fields.priority  ? i.fields.priority.name  : "Medium",
                phase:      autoPhase8,
                mine:       syncMine,
                addedAt:    new Date().toISOString(),
                updatedAt:  new Date().toISOString(),
                notes: "", cascadeSuggestion: null, xraySteps: null
              });
              added8++;
            } else {
              // Mettre à jour le statut et la phase si le ticket existe déjà
              existing8.jiraStatus = status8;
              existing8.phase      = existing8.phase === "entrant" ? autoPhase8 : existing8.phase;
              existing8.mine       = existing8.mine || syncMine;
              existing8.updatedAt  = new Date().toISOString();
            }
          });
          writeBacklog(BACKLOG_PENDING, pending8);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, total: issues8.length, added: added8 }));
        } catch(e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    sr8.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    sr8.setTimeout(10000, function() { sr8.destroy(); res.writeHead(504); res.end("{}"); });
    sr8.write(sp8Body);
    sr8.end();
    return;
  }

  if (method === "DELETE" && url.startsWith("/api/backlog/")) {
    var blDelKey  = url.replace("/api/backlog/", "");
    var pending   = readBacklog(BACKLOG_PENDING);
    var filtered  = pending.filter(function(t) { return t.key !== blDelKey; });
    writeBacklog(BACKLOG_PENDING, filtered);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CASCADE — suggestion IA de tickets enfants pour une Story
  // ══════════════════════════════════════════════════════════════════════════
  if (method === "POST" && url.startsWith("/api/cascade/suggest/")) {
    var cascKey = url.replace("/api/cascade/suggest/", "");
    var cascChunks = [];
    req.on("data", function(c) { cascChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cascChunks).toString()); } catch(e) {}
      // Récupérer le ticket Jira
      var https4 = require("https");
      var auth4  = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
      var jReq = https4.request({
        hostname: CFG.jira.host,
        path: "/rest/api/3/issue/" + cascKey + "?fields=summary,description,issuetype,status,labels,priority",
        method: "GET",
        headers: { "Authorization": "Basic " + auth4, "Accept": "application/json" }
      }, function(jRes) {
        var jData = "";
        jRes.on("data", function(c) { jData += c; });
        jRes.on("end", async function() {
          try {
            var issue  = JSON.parse(jData);
            var f      = issue.fields || {};
            var desc   = f.description
              ? (typeof f.description === "string" ? f.description : JSON.stringify(f.description)).substring(0, 800)
              : "";
            var prompt = "Tu es lead QA. Analyse cette User Story Jira et génère les tickets enfants nécessaires.\n\n" +
              "STORY: " + cascKey + " — " + (f.summary || "") + "\n" +
              "STATUT: " + (f.status ? f.status.name : "") + "\n" +
              "DESCRIPTION: " + desc + "\n\n" +
              "Génère un tableau JSON de tickets enfants. Chaque ticket :\n" +
              '{"type":"Test Case"|"Bug","summary":"[nomenclature exacte]","description":"critères d\'acceptation détaillés","priority":"High"|"Medium"|"Low"}\n\n' +
              "Nomenclature : TEST → \"TEST - [Titre US] - Fonction à tester\" | BUG → \"BUG - [Titre US] - Fonction à corriger\"\n" +
              "Génère 2-4 tickets TEST + 0-2 tickets BUG si des risques sont détectés.\n" +
              "Réponds UNIQUEMENT avec le JSON array.";
            var suggestions = await leadQA.askJSON(prompt);
            // Stocker dans le backlog
            ensureBacklogDir();
            var pending2 = readBacklog(BACKLOG_PENDING);
            var pIdx = pending2.findIndex(function(t) { return t.key === cascKey; });
            if (pIdx >= 0) { pending2[pIdx].cascadeSuggestion = suggestions; pending2[pIdx].updatedAt = new Date().toISOString(); }
            writeBacklog(BACKLOG_PENDING, pending2);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, suggestions: suggestions }));
          } catch(e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
      jReq.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      jReq.end();
    });
    return;
  }

  if (method === "POST" && url === "/api/cascade/create") {
    var cascCreateChunks = [];
    req.on("data", function(c) { cascCreateChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cascCreateChunks).toString()); } catch(e) {}
      var parentKey = body.parentKey || "";
      var tickets   = Array.isArray(body.tickets) ? body.tickets : [];
      var https5    = require("https");
      var auth5     = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
      var created   = [];
      var errors    = [];
      for (var ci = 0; ci < tickets.length; ci++) {
        var tc = tickets[ci];
        var payload = JSON.stringify({
          fields: {
            project:     { key: CFG.jira.project },
            summary:     tc.summary,
            issuetype:   { name: tc.type || "Test Case" },
            description: tc.description || "",
            priority:    { name: tc.priority || "Medium" },
            labels:      ["aby-qa-v3", "cascade-auto"]
          }
        });
        try {
          var createResult = await new Promise(function(resolve, reject) {
            var cr = https5.request({
              hostname: CFG.jira.host, path: "/rest/api/3/issue",
              method: "POST",
              headers: { "Authorization": "Basic " + auth5, "Content-Type": "application/json",
                         "Accept": "application/json", "Content-Length": Buffer.byteLength(payload) }
            }, function(cRes) {
              var cData = ""; cRes.on("data", function(d) { cData += d; });
              cRes.on("end", function() { resolve(JSON.parse(cData)); });
            });
            cr.on("error", reject);
            cr.write(payload); cr.end();
          });
          if (createResult.key) {
            created.push({ key: createResult.key, summary: tc.summary, type: tc.type });
            // Ajouter au backlog
            var pending3 = readBacklog(BACKLOG_PENDING);
            if (!pending3.find(function(t) { return t.key === createResult.key; })) {
              pending3.push({ key: createResult.key, summary: tc.summary, type: tc.type,
                jiraStatus: "BACKLOG", phase: "entrant", addedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(), notes: "Créé en cascade depuis " + parentKey,
                cascadeSuggestion: null, xraySteps: null });
              writeBacklog(BACKLOG_PENDING, pending3);
            }
            // Lier au parent
            var linkPayload = JSON.stringify({ type: { name: "Test" }, inwardIssue: { key: createResult.key }, outwardIssue: { key: parentKey } });
            var lr = https5.request({ hostname: CFG.jira.host, path: "/rest/api/3/issueLink", method: "POST",
              headers: { "Authorization": "Basic " + auth5, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(linkPayload) }
            }, function() {}); lr.on("error", function(){}); lr.write(linkPayload); lr.end();
          } else { errors.push({ summary: tc.summary, error: JSON.stringify(createResult).substring(0, 100) }); }
        } catch(e) { errors.push({ summary: tc.summary, error: e.message }); }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: created, errors: errors }));
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // XRAY — suggestion de steps IA + push vers Xray
  // ══════════════════════════════════════════════════════════════════════════
  if (method === "POST" && url.startsWith("/api/xray/suggest-steps/")) {
    var xrayKey = url.replace("/api/xray/suggest-steps/", "");
    var xsChunks = [];
    req.on("data", function(c) { xsChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(xsChunks).toString()); } catch(e) {}
      var https6 = require("https");
      var auth6  = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
      var xjReq  = https6.request({
        hostname: CFG.jira.host,
        path: "/rest/api/3/issue/" + xrayKey + "?fields=summary,description,issuetype,labels",
        method: "GET",
        headers: { "Authorization": "Basic " + auth6, "Accept": "application/json" }
      }, function(xjRes) {
        var xjData = "";
        xjRes.on("data", function(c) { xjData += c; });
        xjRes.on("end", async function() {
          try {
            var issue = JSON.parse(xjData);
            var f     = issue.fields || {};
            var desc  = f.description
              ? (typeof f.description === "string" ? f.description : JSON.stringify(f.description)).substring(0, 600)
              : "";
            var prompt = "Tu es lead QA Xray. Génère les steps de test Xray pour ce ticket de test.\n\n" +
              "TEST: " + xrayKey + " — " + (f.summary || "") + "\n" +
              "DESCRIPTION / AC: " + desc + "\n\n" +
              "Génère 3-6 steps sous forme JSON array :\n" +
              '[{"action":"Action à réaliser (Étant donné/Lorsque)","data":"URL, identifiants, données de test","result":"Résultat attendu (Alors)"}]\n\n' +
              "Sois précis, utilisable directement par un testeur. Réponds UNIQUEMENT avec le JSON array.";
            var steps = await leadQA.askJSON(prompt);
            // Stocker dans le backlog
            ensureBacklogDir();
            var pending4 = readBacklog(BACKLOG_PENDING);
            var pIdx2 = pending4.findIndex(function(t) { return t.key === xrayKey; });
            if (pIdx2 >= 0) { pending4[pIdx2].xraySteps = steps; pending4[pIdx2].updatedAt = new Date().toISOString(); }
            writeBacklog(BACKLOG_PENDING, pending4);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, steps: steps }));
          } catch(e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
      xjReq.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      xjReq.end();
    });
    return;
  }

  if (method === "POST" && url.startsWith("/api/xray/push-steps/")) {
    var xpKey = url.replace("/api/xray/push-steps/", "");
    var xpChunks = [];
    req.on("data", function(c) { xpChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(xpChunks).toString()); } catch(e) {}
      var steps = Array.isArray(body.steps) ? body.steps : [];
      var https7 = require("https");
      var auth7  = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
      var stepsPayload = JSON.stringify({
        steps: steps.map(function(s) { return { action: s.action || "", data: s.data || "", result: s.result || "" }; })
      });
      var xpReq = https7.request({
        hostname: CFG.jira.host,
        path: "/rest/raven/1.0/api/test/" + xpKey + "/steps",
        method: "PUT",
        headers: { "Authorization": "Basic " + auth7, "Content-Type": "application/json",
                   "Accept": "application/json", "Content-Length": Buffer.byteLength(stepsPayload) }
      }, function(xpRes) {
        var xpData = ""; xpRes.on("data", function(c) { xpData += c; });
        xpRes.on("end", function() {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: xpRes.statusCode < 300, status: xpRes.statusCode, raw: xpData.substring(0, 200) }));
        });
      });
      xpReq.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      xpReq.write(stepsPayload); xpReq.end();
    });
    return;
  }

  if (method === "POST" && url === "/api/xray/update-result") {
    var xrChunks = [];
    req.on("data", function(c) { xrChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(xrChunks).toString()); } catch(e) {}
      // Archiver dans le backlog
      var pending5 = readBacklog(BACKLOG_PENDING);
      var done2    = readBacklog(BACKLOG_DONE);
      var idx5     = pending5.findIndex(function(t) { return t.key === body.key; });
      if (idx5 >= 0) {
        var t5 = pending5.splice(idx5, 1)[0];
        done2.unshift({ key: t5.key, summary: t5.summary, type: t5.type,
          result: body.result || "SKIP", doneAt: new Date().toISOString(),
          reportFile: body.reportFile || null, xrayExecution: body.xrayExecution || null, notes: "" });
        writeBacklog(BACKLOG_PENDING, pending5);
        writeBacklog(BACKLOG_DONE, done2);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
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
    console.log("  [POLLER] Erreur dÃ©marrage : " + e.message);
  }

  // â"€â"€ DÃ©marrage du cron TNR (Cycle 3) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  function getFreshSettings() {
    try { return JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); }
    catch(e) { return {}; }
  }
  try {
    cycle.startCron(sendSSE, runAgent, getFreshSettings);
    if (startupSettings.tnr && startupSettings.tnr.enabled) {
      console.log("  â° TNR Cron  : actif  —  dÃ©clenchement Ã  " + (startupSettings.tnr.hour || "22:00"));
    } else {
      console.log("  â° TNR Cron  : dÃ©sactivÃ© (activer dans ParamÃ¨tres QA)");
    }
  } catch(e) {
    console.log("  [CYCLE] Erreur dÃ©marrage cron : " + e.message);
  }
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


