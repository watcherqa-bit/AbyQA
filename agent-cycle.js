// agent-cycle.js — Orchestrateur des 3 cycles QA
// Cycle 1 : Ticket QA      (polling → validation humaine → Playwright → Xray)
// Cycle 2 : TNR Release    (par version Jira — déclenchement manuel)
// Cycle 3 : TNR Complet    (nightly automatique à l'heure configurée)
//
"use strict";

const fs   = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "cycle-state.json");

// ── ÉTAT PAR DÉFAUT ───────────────────────────────────────────────────────────
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
    lastError: null,        // dernières lignes d'erreur (string)
    release:  null          // version Jira en cours (ex: "v1.25.0")
  },
  cycle3: {
    label:    "TNR Complet",
    status:   "idle",
    lastRun:  null,
    lastResult: null,
    lastError: null,        // dernières lignes d'erreur (string)
    nextRun:  null          // prochain déclenchement calculé
  }
};

// ── LECTURE / ÉCRITURE ÉTAT ───────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      // Merge avec defaults pour les nouvelles clés
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
  catch(e) { console.log("[CYCLE] Erreur sauvegarde état : " + e.message); }
}

// ── CRON TNR (Cycle 3) ────────────────────────────────────────────────────────
var _cronTimer    = null;
var _lastTNRDate  = null;   // date YYYY-MM-DD du dernier TNR déclenché (anti-double)
var _sendSSE      = null;
var _runAgent     = null;   // fonction runAgent(id, cmd, args, clientId) de agent-server.js
var _getSettings  = null;   // callback pour lire settings.json frais

function startCron(sendSSEFn, runAgentFn, getSettingsFn) {
  _sendSSE     = sendSSEFn;
  _runAgent    = runAgentFn;
  _getSettings = getSettingsFn;

  if (_cronTimer) clearInterval(_cronTimer);
  _cronTimer = setInterval(_cronTick, 60 * 1000); // toutes les minutes
  _cronTick(); // vérification immédiate
  console.log("[CYCLE] Cron TNR démarré — vérification toutes les minutes");
}

function stopCron() {
  if (_cronTimer) { clearInterval(_cronTimer); _cronTimer = null; }
  console.log("[CYCLE] Cron TNR arrêté");
}

function _cronTick() {
  var settings = _getSettings ? _getSettings() : null;
  if (!settings || !settings.tnr || !settings.tnr.enabled) return;

  var now   = new Date();
  var hhmm  = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0");
  var today = now.toISOString().slice(0, 10);

  if (hhmm === settings.tnr.hour && _lastTNRDate !== today) {
    _lastTNRDate = today;
    console.log("[CYCLE] ⏰ Déclenchement TNR Complet — " + hhmm);
    triggerTNRComplet(settings, "default");
  }

  // Mettre à jour nextRun dans l'état
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

// ── CYCLE 3 : TNR COMPLET ─────────────────────────────────────────────────────
function triggerTNRComplet(settings, clientId) {
  var state = loadState();
  if (state.cycle3.status === "running") {
    console.log("[CYCLE] TNR Complet déjà en cours — ignoré");
    return;
  }

  var envs     = (settings.tnr && settings.tnr.envs)     || settings.envs    || ["sophie", "prod"];
  var browsers = (settings.tnr && settings.tnr.browsers)  || settings.browsers || ["chromium"];
  var devices  = (settings.tnr && settings.tnr.devices)   || settings.devices  || [{name:"desktop-hd",w:1920,h:1080}];

  state.cycle3.status  = "running";
  state.cycle3.lastRun = new Date().toISOString();
  saveState(state);

  if (_sendSSE) {
    _sendSSE("default", {
      type:    "cycle3-start",
      envs:    envs,
      browsers: browsers,
      at:      new Date().toLocaleTimeString("fr-FR", {hour:"2-digit", minute:"2-digit"})
    });
  }

  if (!_runAgent) {
    console.log("[CYCLE] runAgent non disponible — TNR simulé");
    _onTNRDone(0, [], settings);
    return;
  }

  // Écrire devices dans fichier temporaire
  var BASE_DIR  = __dirname;
  var devFile   = path.join(BASE_DIR, "uploads", ".tnr-devices-tmp.json");
  try { fs.writeFileSync(devFile, JSON.stringify(devices), "utf8"); } catch(e) {}

  var tnrArgs = [
    "agent-playwright-direct.js",
    "--mode=tnr",
    "--envs=" + envs.join(","),
    "--browsers=" + browsers.join(","),
    "--devices-file=" + devFile
  ];

  _runAgent("playwright-direct-tnr", "node", tnrArgs, clientId, false, {
    onDone: function(exitCode, logs) {
      _onTNRDone(exitCode, logs, settings);
    }
  });
}

function _extractErrors(logs) {
  if (!logs || !logs.length) return null;
  var lines = logs.filter(function(l) {
    return /error|fail|FAIL|ERR|exception|timeout|Cannot|undefined|null/i.test(l);
  });
  // Garder les 15 dernières lignes d'erreur + les 5 dernières lignes du log
  var tail = logs.slice(-5);
  var combined = lines.concat(tail).filter(function(l, i, arr) { return arr.indexOf(l) === i; });
  return combined.slice(-20).join("\n") || null;
}

function _onTNRDone(exitCode, logs, settings) {
  var state = loadState();

  // Extraire le résultat si disponible
  var result = { pass: 0, fail: 0, total: 0 };
  if (logs) {
    var rLine = logs.find(function(l) { return l.startsWith("PLAYWRIGHT_DIRECT_RESULT:"); });
    if (rLine) {
      try {
        var r = JSON.parse(rLine.replace("PLAYWRIGHT_DIRECT_RESULT:", ""));
        result = { pass: r.pass || 0, fail: r.fail || 0, total: r.total || 0 };
      } catch(e) {}
    }
  }

  state.cycle3.status     = exitCode === 0 ? "done" : "error";
  state.cycle3.lastResult = result;
  state.cycle3.lastError  = exitCode !== 0 ? _extractErrors(logs) : null;
  saveState(state);

  if (_sendSSE) {
    _sendSSE("default", {
      type:   "cycle3-done",
      ok:     exitCode === 0,
      result: result
    });
  }
}

// ── CYCLE 2 : TNR RELEASE ─────────────────────────────────────────────────────
function triggerTNRRelease(release, settings, clientId, runAgentFn, sendSSEFn) {
  var state = loadState();
  if (state.cycle2.status === "running") {
    console.log("[CYCLE] TNR Release déjà en cours — ignoré");
    return false;
  }

  var runFn  = runAgentFn  || _runAgent;
  var sseFn  = sendSSEFn   || _sendSSE;
  var envs   = settings.envs    || ["sophie", "prod"];
  var browsers = settings.browsers || ["chromium"];

  state.cycle2.status  = "running";
  state.cycle2.lastRun = new Date().toISOString();
  state.cycle2.release = release;
  saveState(state);

  if (sseFn) sseFn("default", { type: "cycle2-start", release: release, envs: envs });

  if (!runFn) {
    state.cycle2.status = "done";
    saveState(state);
    return true;
  }

  var BASE_DIR = __dirname;
  var devFile  = path.join(BASE_DIR, "uploads", ".tnr-release-devices-tmp.json");
  try { fs.writeFileSync(devFile, JSON.stringify(settings.devices || [{name:"desktop-hd",w:1920,h:1080}]), "utf8"); } catch(e) {}

  runFn("playwright-direct-tnr-release", "node", [
    "agent-playwright-direct.js",
    "--mode=tnr",
    "--envs=" + envs.join(","),
    "--browsers=" + browsers.join(","),
    "--devices-file=" + devFile
  ], clientId, false, {
    onDone: function(exitCode, logs) {
      var s2 = loadState();
      if (s2.cycle2.status === "running") {
        s2.cycle2.status    = exitCode === 0 ? "done" : "error";
        s2.cycle2.lastError = exitCode !== 0 ? _extractErrors(logs) : null;
        saveState(s2);
      }
      if (sseFn) sseFn("default", { type: "cycle2-done", ok: exitCode === 0, release: release });
    }
  });
  return true;
}

// ── CYCLE 1 : TICKET QA ───────────────────────────────────────────────────────
function addTicketToValidation(ticket) {
  var state = loadState();
  // Éviter les doublons
  var exists = state.cycle1.pendingTickets.some(function(t) { return t.key === ticket.key; });
  if (!exists) {
    ticket.addedAt = new Date().toISOString();
    ticket.c1status = "pending"; // pending | running | done
    state.cycle1.pendingTickets.push(ticket);
    saveState(state);
  }
}

function markTicketDone(key, result) {
  var state = loadState();
  state.cycle1.pendingTickets = state.cycle1.pendingTickets.map(function(t) {
    if (t.key === key) {
      t.c1status   = "done";
      t.result     = result;
      t.doneAt     = new Date().toISOString();
    }
    return t;
  });
  saveState(state);
}

function markTicketRunning(key) {
  var state = loadState();
  state.cycle1.pendingTickets = state.cycle1.pendingTickets.map(function(t) {
    if (t.key === key) t.c1status = "running";
    return t;
  });
  saveState(state);
}

// ── ARRÊT MANUEL DES CYCLES ───────────────────────────────────────────────────
function stopCycle2() {
  var state = loadState();
  state.cycle2.status    = "idle";
  state.cycle2.lastError = null;
  saveState(state);
  if (_sendSSE) _sendSSE("default", { type: "cycle2-stopped" });
  console.log("[CYCLE] TNR Release — arrêté manuellement");
}

function stopCycle3() {
  var state = loadState();
  state.cycle3.status    = "idle";
  state.cycle3.lastError = null;
  saveState(state);
  if (_sendSSE) _sendSSE("default", { type: "cycle3-stopped" });
  console.log("[CYCLE] TNR Complet — arrêté manuellement");
}

// ── API PUBLIQUE ──────────────────────────────────────────────────────────────
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
  // État
  getState: loadState,
  saveState
};
