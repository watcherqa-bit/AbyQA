// agent-poller.js — Polling Jira automatique
// Surveille les tickets QA mis à jour et notifie le dashboard via SSE
// Usage : require("./agent-poller").start(settings, sendSSEFn)
//
"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");
const CFG   = require("./config");

// ── ÉTAT INTERNE ──────────────────────────────────────────────────────────────
var _timer      = null;      // setInterval handle
var _sendSSE    = null;      // fonction sendSSE(clientId, data) du serveur
var _settings   = null;      // settings.json courant
var _status     = {
  running:   false,
  lastCheck: null,           // ISO string de la dernière vérification
  lastCount: 0,              // nb tickets trouvés au dernier poll
  nextCheck: null,           // ISO string de la prochaine vérification
  error:     null
};

// Cache des tickets déjà vus : { "SAF-123": "2024-01-01T00:00:00.000Z" }
var SEEN_FILE = path.join(__dirname, "inbox", "polling", ".seen.json");

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    }
  } catch(e) {}
  return {};
}

function saveSeen(seen) {
  try {
    var dir = path.dirname(SEEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2), "utf8");
  } catch(e) {}
}

// ── STATUTS QA à surveiller (synchronisés avec le WORKFLOW du dashboard) ───────
var QA_STATUSES = [
  "To Test", "In Test", "To Test UAT", "In validation", "Reopened"
];

// ── APPEL JIRA — tickets récemment modifiés ───────────────────────────────────
function fetchJiraUpdates(intervalMin, callback) {
  // Marge : intervalMin + 20% pour ne pas manquer de tickets au bord
  var sinceMin = Math.ceil(intervalMin * 1.2);
  var jql = "project = " + CFG.jira.project +
    " AND issuetype in (Story, Bug, \"Test Case\", Task)" +
    " AND updated >= \"-" + sinceMin + "m\"" +
    " ORDER BY updated DESC";

  var searchPath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
    "&fields=summary,status,issuetype,priority,updated,assignee,labels&maxResults=50";

  var auth = CFG.jira.authHeader();
  var req  = https.request({
    hostname: CFG.jira.host,
    path:     searchPath,
    method:   "GET",
    headers: { "Authorization": auth, "Accept": "application/json" }
  }, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try {
        var parsed = JSON.parse(data);
        var tickets = (parsed.issues || []).map(function(i) {
          return {
            key:      i.key,
            summary:  i.fields.summary,
            type:     i.fields.issuetype ? i.fields.issuetype.name : "?",
            status:   i.fields.status    ? i.fields.status.name    : "?",
            priority: i.fields.priority  ? i.fields.priority.name  : "Medium",
            assignee: i.fields.assignee  ? i.fields.assignee.displayName : null,
            labels:   i.fields.labels    || [],
            updated:  i.fields.updated
          };
        });
        callback(null, tickets);
      } catch(e) {
        callback(e, []);
      }
    });
  });

  req.on("error", function(e) { callback(e, []); });
  req.setTimeout(10000, function() { req.destroy(); callback(new Error("Timeout Jira"), []); });
  req.end();
}

// ── APPEL JIRA — tickets actuellement en phase QA ─────────────────────────────
function fetchJiraQAReady(callback) {
  var statusList = QA_STATUSES.map(function(s) { return '"' + s + '"'; }).join(", ");
  var jql = "project = " + CFG.jira.project +
    " AND issuetype in (Story, Bug, \"Test Case\", Task)" +
    " AND status in (" + statusList + ")" +
    " ORDER BY updated DESC";

  var searchPath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) +
    "&fields=summary,status,issuetype,priority,updated,assignee,labels&maxResults=30";

  var auth = CFG.jira.authHeader();
  var req  = https.request({
    hostname: CFG.jira.host,
    path:     searchPath,
    method:   "GET",
    headers: { "Authorization": auth, "Accept": "application/json" }
  }, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try {
        var parsed  = JSON.parse(data);
        var tickets = (parsed.issues || []).map(function(i) {
          return {
            key:      i.key,
            summary:  i.fields.summary,
            type:     i.fields.issuetype ? i.fields.issuetype.name : "?",
            status:   i.fields.status    ? i.fields.status.name    : "?",
            priority: i.fields.priority  ? i.fields.priority.name  : "Medium",
            assignee: i.fields.assignee  ? i.fields.assignee.displayName : null,
            labels:   i.fields.labels    || [],
            updated:  i.fields.updated
          };
        });
        callback(null, tickets);
      } catch(e) {
        callback(e, []);
      }
    });
  });
  req.on("error", function(e) { callback(e, []); });
  req.setTimeout(10000, function() { req.destroy(); callback(new Error("Timeout Jira QA"), []); });
  req.end();
}

// ── CYCLE DE POLL ─────────────────────────────────────────────────────────────
function runPoll() {
  var intervalMin = (_settings && _settings.polling && _settings.polling.intervalMin) || 5;
  _status.lastCheck = new Date().toISOString();
  _status.error     = null;

  fetchJiraUpdates(intervalMin, function(err, tickets) {
    if (err) {
      _status.error     = err.message;
      _status.lastCount = 0;
      console.log("[POLLER] Erreur Jira : " + err.message);
      return;
    }

    var seen     = loadSeen();
    var newItems = [];

    tickets.forEach(function(t) {
      var prevUpdated = seen[t.key];
      // Considérer comme nouveau si jamais vu OU si updated a changé depuis la dernière fois
      if (!prevUpdated || prevUpdated !== t.updated) {
        newItems.push(t);
        seen[t.key] = t.updated;
      }
    });

    saveSeen(seen);
    _status.lastCount = newItems.length;

    var now = new Date();
    var timeLabel = now.getHours().toString().padStart(2, "0") + ":" +
                    now.getMinutes().toString().padStart(2, "0");

    if (newItems.length > 0) {
      console.log("[POLLER] " + newItems.length + " ticket(s) mis à jour : " +
        newItems.map(function(t) { return t.key; }).join(", "));

      // Notifier le dashboard via SSE
      if (_sendSSE) {
        _sendSSE("default", {
          type:    "poll-ticket",
          tickets: newItems,
          count:   newItems.length,
          at:      timeLabel
        });
      }
    } else {
      console.log("[POLLER] Aucun nouveau ticket à " + _status.lastCheck.slice(0, 16).replace("T", " "));
    }

    // Second pass : snapshot des tickets actuellement en phase QA
    fetchJiraQAReady(function(qaErr, qaTickets) {
      if (qaErr) {
        console.log("[POLLER] Erreur fetch QA-ready : " + qaErr.message);
        return;
      }
      if (_sendSSE) {
        _sendSSE("default", {
          type:    "poll-qa-ready",
          tickets: qaTickets,
          count:   qaTickets.length,
          at:      timeLabel
        });
      }
      if (qaTickets.length > 0) {
        console.log("[POLLER] " + qaTickets.length + " ticket(s) en phase QA : " +
          qaTickets.slice(0, 5).map(function(t) { return t.key + " [" + t.status + "]"; }).join(", "));
      }
    });
  });
}

// ── CALCUL DE LA PROCHAINE VÉRIFICATION ──────────────────────────────────────
function updateNextCheck() {
  if (!_settings || !_settings.polling || !_settings.polling.intervalMin) return;
  var ms = _settings.polling.intervalMin * 60 * 1000;
  _status.nextCheck = new Date(Date.now() + ms).toISOString();
}

// ── API PUBLIQUE ──────────────────────────────────────────────────────────────
function start(settings, sendSSEFn) {
  stop(); // stopper d'abord si déjà actif

  _settings = settings;
  _sendSSE  = sendSSEFn;

  if (!settings || !settings.polling || !settings.polling.enabled) {
    console.log("[POLLER] Polling désactivé dans settings.json");
    _status.running = false;
    return;
  }

  var intervalMin = settings.polling.intervalMin || 5;
  var intervalMs  = intervalMin * 60 * 1000;

  console.log("[POLLER] Démarrage — intervalle : " + intervalMin + " min");

  // Premier poll immédiat (après 3s pour laisser le serveur démarrer)
  var warmup = setTimeout(function() { runPoll(); updateNextCheck(); }, 3000);

  // Puis boucle régulière
  _timer = setInterval(function() {
    runPoll();
    updateNextCheck();
  }, intervalMs);

  _status.running   = true;
  _status.error     = null;
  updateNextCheck();
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _status.running   = false;
  _status.nextCheck = null;
  console.log("[POLLER] Arrêté");
}

function restart(settings, sendSSEFn) {
  stop();
  start(settings, sendSSEFn);
}

function getStatus() {
  return {
    running:   _status.running,
    lastCheck: _status.lastCheck,
    lastCount: _status.lastCount,
    nextCheck: _status.nextCheck,
    error:     _status.error,
    intervalMin: (_settings && _settings.polling && _settings.polling.intervalMin) || 5
  };
}

module.exports = { start, stop, restart, getStatus };
