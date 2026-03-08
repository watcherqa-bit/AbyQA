// agent-cycle.js — Orchestrateur des 3 cycles QA
// Cycle 1 : Ticket QA      (polling -> validation humaine -> Playwright -> rapport)
// Cycle 2 : TNR Release    (par version Jira — teste les tickets de la release)
// Cycle 3 : TNR Complet    (nightly automatique — pages critiques)
//
"use strict";

const fs   = require("fs");
const path = require("path");
const https = require("https");
const CFG  = require("./config");

const STATE_FILE   = path.join(__dirname, "cycle-state.json");
const HISTORY_FILE = path.join(__dirname, "inbox", "cycle-history.json");

// ── ETAT PAR DEFAUT ─────────────────────────────────────────────────────────
var DEFAULT_STATE = {
  cycle1: {
    label:    "Ticket QA",
    status:   "idle",       // idle | running | done | error
    lastRun:  null,
    lastResult: null,       // { pass, fail, total }
    pendingTickets: []      // tickets en attente de validation
  },
  cycle2: {
    label:    "TNR Release",
    status:   "idle",
    lastRun:  null,
    lastResult: null,
    lastError: null,
    release:  null,         // version Jira en cours (ex: "v1.25.0")
    tickets:  [],           // tickets de la release
    progress: { done: 0, total: 0 }
  },
  cycle3: {
    label:    "TNR Complet",
    status:   "idle",
    lastRun:  null,
    lastResult: null,
    lastError: null,
    nextRun:  null          // prochain declenchement calcule
  }
};

// ── LECTURE / ECRITURE ETAT ─────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return {
        cycle1: Object.assign({}, DEFAULT_STATE.cycle1, raw.cycle1 || {}),
        cycle2: Object.assign({}, DEFAULT_STATE.cycle2, raw.cycle2 || {}),
        cycle3: Object.assign({}, DEFAULT_STATE.cycle3, raw.cycle3 || {})
      };
    }
  } catch(e) {}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); }
  catch(e) { console.log("[CYCLE] Erreur sauvegarde etat : " + e.message); }
}

// ── HISTORIQUE ──────────────────────────────────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch(e) {}
  return [];
}

function saveHistory(history) {
  var dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Garder max 200 entrees
  if (history.length > 200) history = history.slice(-200);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8"); } catch(e) {}
}

function addHistoryEntry(cycleId, entry) {
  var history = loadHistory();
  history.push({
    cycle:     cycleId,
    date:      new Date().toISOString(),
    pass:      entry.pass || 0,
    fail:      entry.fail || 0,
    total:     entry.total || 0,
    release:   entry.release || null,
    key:       entry.key || null,
    reportFile: entry.reportFile || null,
    duration:  entry.duration || null
  });
  saveHistory(history);
}

// ── NETTOYAGE CYCLE 1 ───────────────────────────────────────────────────────
// Supprimer les tickets "done" de plus de 7 jours
function cleanupPendingTickets() {
  var state = loadState();
  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var before = state.cycle1.pendingTickets.length;
  state.cycle1.pendingTickets = state.cycle1.pendingTickets.filter(function(t) {
    if (t.c1status !== "done") return true;
    var doneTime = t.doneAt ? new Date(t.doneAt).getTime() : 0;
    return doneTime > cutoff;
  });
  if (state.cycle1.pendingTickets.length !== before) {
    saveState(state);
    console.log("[CYCLE] Cleanup : " + (before - state.cycle1.pendingTickets.length) + " tickets done retires");
  }
}

// ── JIRA HELPER ─────────────────────────────────────────────────────────────
function jiraGet(apiPath) {
  return new Promise(function(resolve, reject) {
    var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var req = https.request({
      hostname: CFG.jira.host,
      path: apiPath,
      method: "GET",
      headers: { "Authorization": "Basic " + auth, "Accept": "application/json" }
    }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, function() { req.destroy(); reject(new Error("Timeout Jira")); });
    req.end();
  });
}

// ── FETCH TICKETS D'UNE RELEASE ─────────────────────────────────────────────
async function fetchReleaseTickets(release) {
  var jql = "project = " + CFG.jira.project +
    " AND fixVersion = \"" + release + "\"" +
    " AND issuetype in (Story, Bug)" +
    " ORDER BY priority DESC, updated DESC";
  var searchPath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
    "&fields=summary,status,issuetype,priority,labels,description&maxResults=50";

  var result = await jiraGet(searchPath);
  return (result.issues || []).map(function(i) {
    return {
      key:      i.key,
      summary:  i.fields.summary,
      type:     i.fields.issuetype ? i.fields.issuetype.name : "?",
      status:   i.fields.status ? i.fields.status.name : "?",
      priority: i.fields.priority ? i.fields.priority.name : "Medium",
      labels:   i.fields.labels || []
    };
  });
}

// ── CRON TNR (Cycle 3) ──────────────────────────────────────────────────────
var _cronTimer    = null;
var _lastTNRDate  = null;   // date YYYY-MM-DD du dernier TNR declenche (anti-double)
var _sendSSE      = null;
var _runAgent     = null;
var _getSettings  = null;
var _leadQA       = null;   // reference vers agent-lead-qa pour l'analyse FAIL

function startCron(sendSSEFn, runAgentFn, getSettingsFn, leadQARef) {
  _sendSSE     = sendSSEFn;
  _runAgent    = runAgentFn;
  _getSettings = getSettingsFn;
  _leadQA      = leadQARef || null;

  if (_cronTimer) clearInterval(_cronTimer);
  _cronTimer = setInterval(_cronTick, 60 * 1000);
  _cronTick();

  // Cleanup au demarrage
  cleanupPendingTickets();

  console.log("[CYCLE] Cron TNR demarre — verification toutes les minutes");
}

function stopCron() {
  if (_cronTimer) { clearInterval(_cronTimer); _cronTimer = null; }
  console.log("[CYCLE] Cron TNR arrete");
}

function _cronTick() {
  var settings = _getSettings ? _getSettings() : null;
  if (!settings || !settings.tnr || !settings.tnr.enabled) return;

  var now   = new Date();
  var hhmm  = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0");
  var today = now.toISOString().slice(0, 10);

  if (hhmm === settings.tnr.hour && _lastTNRDate !== today) {
    _lastTNRDate = today;
    console.log("[CYCLE] Declenchement TNR Complet — " + hhmm);
    triggerTNRComplet(settings, "default");
  }

  // Mettre a jour nextRun dans l'etat
  var state = loadState();
  if (settings.tnr.hour) {
    var parts  = settings.tnr.hour.split(":");
    var next   = new Date();
    next.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    state.cycle3.nextRun = next.toISOString();
    saveState(state);
  }
}

// ── EXTRACTION ERREURS ──────────────────────────────────────────────────────
function _extractErrors(logs) {
  if (!logs || !logs.length) return null;
  var lines = logs.filter(function(l) {
    return /error|fail|FAIL|ERR|exception|timeout|Cannot|undefined is not/i.test(l);
  });
  var tail = logs.slice(-5);
  var combined = lines.concat(tail).filter(function(l, i, arr) { return arr.indexOf(l) === i; });
  return combined.slice(-20).join("\n") || null;
}

// ── PARSE PLAYWRIGHT RESULT ─────────────────────────────────────────────────
function _parseResult(logs) {
  var result = { pass: 0, fail: 0, total: 0, reportPath: null };
  if (!logs) return result;
  var rLine = logs.find(function(l) { return l.startsWith("PLAYWRIGHT_DIRECT_RESULT:"); });
  if (rLine) {
    try {
      var r = JSON.parse(rLine.replace("PLAYWRIGHT_DIRECT_RESULT:", ""));
      result.pass = r.pass || 0;
      result.fail = r.fail || 0;
      result.total = r.total || 0;
      result.reportPath = r.reportPath || null;
    } catch(e) {}
  }
  return result;
}

// ── ANALYSE FAIL (commune aux 3 cycles) ─────────────────────────────────────
function _analyzeAndNotify(cycleType, key, result, logs, settings, reportPath) {
  if (!_leadQA || !_sendSSE) return;
  var failLogs = (logs || []).slice(-150).join("\n");
  var reportContent = "";
  if (reportPath) {
    var rpPath = path.join(__dirname, "reports", reportPath);
    try { reportContent = fs.readFileSync(rpPath, "utf8"); } catch(e) {}
  }

  _leadQA.analyzePlaywrightFail(failLogs, {
    ticketKey: key || cycleType,
    mode: cycleType === "cycle1" ? "ui" : "tnr",
    env: (settings && settings.envs) ? settings.envs.join(",") : "sophie",
    pass: result.pass, fail: result.fail, total: result.total
  }).then(function(diag) {
    _sendSSE("default", {
      type: "cycle1-fail-analysis",
      key: key || cycleType,
      result: result,
      reportFile: reportPath || null,
      reportContent: reportContent.substring(0, 5000),
      diagnostic: diag
    });
  }).catch(function(e) {
    console.log("[CYCLE] Erreur analyse FAIL : " + e.message);
  });
}

// ── CYCLE 3 : TNR COMPLET ───────────────────────────────────────────────────
function triggerTNRComplet(settings, clientId) {
  var state = loadState();
  if (state.cycle3.status === "running") {
    console.log("[CYCLE] TNR Complet deja en cours — ignore");
    return;
  }

  var envs     = (settings.tnr && settings.tnr.envs)     || settings.envs    || ["sophie", "prod"];
  var browsers = (settings.tnr && settings.tnr.browsers)  || settings.browsers || ["chromium"];
  var devices  = (settings.tnr && settings.tnr.devices)   || settings.devices  || [{name:"desktop-hd",w:1920,h:1080}];

  state.cycle3.status  = "running";
  state.cycle3.lastRun = new Date().toISOString();
  state.cycle3.lastError = null;
  saveState(state);

  if (_sendSSE) {
    _sendSSE("default", { type: "cycle3-start", envs: envs, browsers: browsers,
      at: new Date().toLocaleTimeString("fr-FR", {hour:"2-digit", minute:"2-digit"}) });
  }

  if (!_runAgent) {
    console.log("[CYCLE] runAgent non disponible — TNR simule");
    _onTNRDone(0, [], settings);
    return;
  }

  var devFile = path.join(__dirname, "uploads", ".tnr-devices-tmp.json");
  try { fs.writeFileSync(devFile, JSON.stringify(devices), "utf8"); } catch(e) {}

  var startTime = Date.now();
  _runAgent("playwright-direct-tnr", "node", [
    "agent-playwright-direct.js",
    "--mode=tnr",
    "--envs=" + envs.join(","),
    "--browsers=" + browsers.join(","),
    "--devices-file=" + devFile
  ], clientId, false, {
    onDone: function(exitCode, logs) {
      _onTNRDone(exitCode, logs, settings, startTime);
    }
  });
}

function _onTNRDone(exitCode, logs, settings, startTime) {
  var state  = loadState();
  var result = _parseResult(logs);
  var allPass = result.fail === 0 && result.total > 0;
  var duration = startTime ? Math.round((Date.now() - startTime) / 1000) : null;

  state.cycle3.status     = allPass ? "done" : "error";
  state.cycle3.lastResult = result;
  state.cycle3.lastError  = !allPass ? _extractErrors(logs) : null;
  saveState(state);

  // Historique
  addHistoryEntry("cycle3", { pass: result.pass, fail: result.fail, total: result.total,
    reportFile: result.reportPath, duration: duration });

  // Comparer avec le run precedent
  var history = loadHistory().filter(function(h) { return h.cycle === "cycle3"; });
  var prev = history.length >= 2 ? history[history.length - 2] : null;
  var regression = prev && prev.fail < result.fail;

  if (_sendSSE) {
    _sendSSE("default", {
      type: "cycle3-done", ok: allPass, result: result,
      reportFile: result.reportPath,
      duration: duration,
      regression: regression,
      prevResult: prev ? { pass: prev.pass, fail: prev.fail, total: prev.total } : null
    });
  }

  // Analyse FAIL si echec
  if (!allPass) {
    _analyzeAndNotify("cycle3", "TNR-Complet", result, logs, settings, result.reportPath);
  }
}

// ── CYCLE 2 : TNR RELEASE ───────────────────────────────────────────────────
function triggerTNRRelease(release, settings, clientId, runAgentFn, sendSSEFn) {
  var state = loadState();
  if (state.cycle2.status === "running") {
    console.log("[CYCLE] TNR Release deja en cours — ignore");
    return false;
  }

  var runFn  = runAgentFn  || _runAgent;
  var sseFn  = sendSSEFn   || _sendSSE;
  var envs   = settings.envs    || ["sophie"];
  var browsers = settings.browsers || ["chromium"];

  state.cycle2.status   = "running";
  state.cycle2.lastRun  = new Date().toISOString();
  state.cycle2.release  = release;
  state.cycle2.lastError = null;
  state.cycle2.tickets  = [];
  state.cycle2.progress = { done: 0, total: 0 };
  saveState(state);

  if (sseFn) sseFn("default", { type: "cycle2-start", release: release, envs: envs });

  if (!runFn) {
    state.cycle2.status = "done";
    saveState(state);
    return true;
  }

  // Etape 1 : fetch les tickets de la release depuis Jira
  var startTime = Date.now();
  fetchReleaseTickets(release).then(function(tickets) {
    if (tickets.length === 0) {
      console.log("[CYCLE] Aucun ticket trouve pour la release " + release);
      state = loadState();
      state.cycle2.status = "done";
      state.cycle2.lastResult = { pass: 0, fail: 0, total: 0 };
      saveState(state);
      if (sseFn) sseFn("default", { type: "cycle2-done", ok: true, release: release, result: { pass: 0, fail: 0, total: 0 }, empty: true });
      return;
    }

    console.log("[CYCLE] Release " + release + " : " + tickets.length + " tickets a tester");

    state = loadState();
    state.cycle2.tickets = tickets.map(function(t) { return { key: t.key, summary: t.summary, status: "pending" }; });
    state.cycle2.progress = { done: 0, total: tickets.length };
    saveState(state);

    if (sseFn) sseFn("default", { type: "cycle2-progress", release: release, tickets: tickets.length, done: 0 });

    // Etape 2 : lancer les tests un par un
    var idx = 0;
    var totalResult = { pass: 0, fail: 0, total: 0 };

    function runNextTicket() {
      // Verifier si arrete entre-temps
      var s = loadState();
      if (s.cycle2.status !== "running") {
        console.log("[CYCLE] TNR Release arrete — abandon");
        return;
      }

      if (idx >= tickets.length) {
        // Tous les tickets testes
        var duration = Math.round((Date.now() - startTime) / 1000);
        var allPass = totalResult.fail === 0 && totalResult.total > 0;

        s.cycle2.status     = allPass ? "done" : "error";
        s.cycle2.lastResult = totalResult;
        s.cycle2.lastError  = !allPass ? (totalResult.fail + " test(s) en echec sur " + totalResult.total) : null;
        s.cycle2.progress   = { done: tickets.length, total: tickets.length };
        saveState(s);

        addHistoryEntry("cycle2", { pass: totalResult.pass, fail: totalResult.fail, total: totalResult.total,
          release: release, duration: duration });

        if (sseFn) sseFn("default", {
          type: "cycle2-done", ok: allPass, release: release, result: totalResult, duration: duration
        });

        // Analyse FAIL si echecs
        if (!allPass) {
          _analyzeAndNotify("cycle2", "Release-" + release, totalResult, [], settings, null);
        }
        return;
      }

      var ticket = tickets[idx];
      console.log("[CYCLE] Release " + release + " — test " + (idx + 1) + "/" + tickets.length + " : " + ticket.key);

      // Mettre a jour le statut du ticket
      s = loadState();
      if (s.cycle2.tickets[idx]) s.cycle2.tickets[idx].status = "running";
      saveState(s);

      var c2Args = [
        "agent-playwright-direct.js",
        "--mode=ui",
        "--source=jira-key",
        "--key=" + ticket.key,
        "--envs=" + envs.join(","),
        "--browsers=" + browsers.join(",")
      ];

      runFn("playwright-direct-c2-" + ticket.key, "node", c2Args, clientId, false, {
        onDone: function(exitCode, logs) {
          var r = _parseResult(logs);
          totalResult.pass += r.pass;
          totalResult.fail += r.fail;
          totalResult.total += r.total;

          // Mettre a jour l'etat du ticket
          var s2 = loadState();
          if (s2.cycle2.tickets[idx]) {
            s2.cycle2.tickets[idx].status = r.fail > 0 ? "fail" : "pass";
            s2.cycle2.tickets[idx].result = r;
          }
          s2.cycle2.progress = { done: idx + 1, total: tickets.length };
          saveState(s2);

          // SSE progress
          if (sseFn) sseFn("default", {
            type: "cycle2-progress",
            release: release,
            done: idx + 1,
            tickets: tickets.length,
            currentKey: ticket.key,
            currentResult: r.fail > 0 ? "FAIL" : "PASS"
          });

          // Analyse FAIL par ticket
          if (r.fail > 0) {
            _analyzeAndNotify("cycle2", ticket.key, r, logs, settings, r.reportPath);
          }

          idx++;
          // Petite pause entre les tickets (2s)
          setTimeout(runNextTicket, 2000);
        }
      });
    }

    runNextTicket();
  }).catch(function(e) {
    console.log("[CYCLE] Erreur fetch release tickets : " + e.message);
    state = loadState();
    state.cycle2.status = "error";
    state.cycle2.lastError = "Erreur Jira : " + e.message;
    saveState(state);
    if (sseFn) sseFn("default", { type: "cycle2-done", ok: false, release: release, error: e.message });
  });

  return true;
}

// ── CYCLE 1 : TICKET QA ─────────────────────────────────────────────────────
function addTicketToValidation(ticket) {
  var state = loadState();
  var exists = state.cycle1.pendingTickets.some(function(t) { return t.key === ticket.key; });
  if (!exists) {
    ticket.addedAt = new Date().toISOString();
    ticket.c1status = "pending";
    state.cycle1.pendingTickets.push(ticket);
    saveState(state);
  }
}

function markTicketDone(key, result) {
  var state = loadState();
  state.cycle1.pendingTickets = state.cycle1.pendingTickets.map(function(t) {
    if (t.key === key) {
      t.c1status = "done";
      t.result   = result;
      t.doneAt   = new Date().toISOString();
    }
    return t;
  });
  // Mettre a jour lastRun et lastResult du cycle
  state.cycle1.lastRun    = new Date().toISOString();
  state.cycle1.lastResult = result;
  state.cycle1.status     = (result.fail === 0 && result.total > 0) ? "done" : "error";
  saveState(state);

  // Historique
  addHistoryEntry("cycle1", { pass: result.pass || 0, fail: result.fail || 0, total: result.total || 0,
    key: key, reportFile: result.reportPath || null });
}

function markTicketRunning(key) {
  var state = loadState();
  state.cycle1.status = "running";
  state.cycle1.pendingTickets = state.cycle1.pendingTickets.map(function(t) {
    if (t.key === key) t.c1status = "running";
    return t;
  });
  saveState(state);
}

// ── ARRET MANUEL DES CYCLES ─────────────────────────────────────────────────
function stopCycle2() {
  var state = loadState();
  state.cycle2.status    = "idle";
  state.cycle2.lastError = null;
  saveState(state);
  if (_sendSSE) _sendSSE("default", { type: "cycle2-stopped" });
  console.log("[CYCLE] TNR Release — arrete manuellement");
}

function stopCycle3() {
  var state = loadState();
  state.cycle3.status    = "idle";
  state.cycle3.lastError = null;
  saveState(state);
  if (_sendSSE) _sendSSE("default", { type: "cycle3-stopped" });
  console.log("[CYCLE] TNR Complet — arrete manuellement");
}

// ── API PUBLIQUE ────────────────────────────────────────────────────────────
module.exports = {
  // Cron
  startCron,
  stopCron,
  // Cycles
  triggerTNRComplet,
  triggerTNRRelease,
  stopCycle2,
  stopCycle3,
  // Cycle 1
  addTicketToValidation,
  markTicketRunning,
  markTicketDone,
  // Etat & historique
  getState: loadState,
  getHistory: loadHistory,
  saveState,
  cleanupPendingTickets
};
