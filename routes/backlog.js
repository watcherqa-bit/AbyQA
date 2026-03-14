// routes/backlog.js — Routes Backlog QA + Cascade IA + Xray Steps
"use strict";

var fs   = require("fs");
var path = require("path");

module.exports = function handle(method, url, req, res, ctx) {
  var CFG      = ctx.CFG;
  var BASE_DIR = ctx.BASE_DIR;
  var leadQA   = ctx.leadQA;

  // ── Helpers backlog ───────────────────────────────────────────────────────
  var BACKLOG_DIR     = path.join(BASE_DIR, "inbox", "backlog");
  var BACKLOG_PENDING = path.join(BACKLOG_DIR, "pending.json");
  var BACKLOG_DONE    = path.join(BACKLOG_DIR, "done.json");

  function ensureBacklogDir() {
    if (!fs.existsSync(BACKLOG_DIR)) fs.mkdirSync(BACKLOG_DIR, { recursive: true });
    if (!fs.existsSync(BACKLOG_PENDING)) fs.writeFileSync(BACKLOG_PENDING, "[]", "utf8");
    if (!fs.existsSync(BACKLOG_DONE))    fs.writeFileSync(BACKLOG_DONE,    "[]", "utf8");
  }
  function readBacklog(file)      { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) { return []; } }
  function writeBacklog(file, arr){ ensureBacklogDir(); fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8"); }

  // ══════════════════════════════════════════════════════════════════════════
  // BACKLOG QA
  // ══════════════════════════════════════════════════════════════════════════

  if (method === "GET" && url === "/api/backlog/pending") {
    ensureBacklogDir();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readBacklog(BACKLOG_PENDING)));
    return true;
  }

  if (method === "GET" && url === "/api/backlog/done") {
    ensureBacklogDir();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readBacklog(BACKLOG_DONE)));
    return true;
  }

  if (method === "POST" && url === "/api/backlog/add") {
    var blAddChunks = [];
    req.on("data", function(c) { blAddChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(blAddChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
    return true;
  }

  if (method === "PUT" && url.startsWith("/api/backlog/") && url.endsWith("/phase")) {
    var blPhaseKey = url.replace("/api/backlog/", "").replace("/phase", "");
    var blPhaseChunks = [];
    req.on("data", function(c) { blPhaseChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(blPhaseChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
    return true;
  }

  if (method === "POST" && url.startsWith("/api/backlog/") && url.endsWith("/archive")) {
    var blArchKey = url.replace("/api/backlog/", "").replace("/archive", "");
    var blArchChunks = [];
    req.on("data", function(c) { blArchChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(blArchChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
    return true;
  }

  if (method === "POST" && url === "/api/backlog/sync-jira") {
    var syncMine = req.url.includes("mine=true");
    ensureBacklogDir();
    var https8  = require("https");
    var auth8   = CFG.jira.authHeader();
    var qaStatuses8 = ["To Test", "In Test", "To Test UAT", "In validation", "Reopened"];
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
    return true;
  }

  if (method === "DELETE" && url.startsWith("/api/backlog/")) {
    var blDelKey  = url.replace("/api/backlog/", "");
    var pending   = readBacklog(BACKLOG_PENDING);
    var filtered  = pending.filter(function(t) { return t.key !== blDelKey; });
    writeBacklog(BACKLOG_PENDING, filtered);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CASCADE — suggestion IA de tickets enfants pour une Story
  // ══════════════════════════════════════════════════════════════════════════

  if (method === "POST" && url.startsWith("/api/cascade/suggest/")) {
    var cascKey = url.replace("/api/cascade/suggest/", "");
    var cascChunks = [];
    req.on("data", function(c) { cascChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cascChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
    return true;
  }

  if (method === "POST" && url === "/api/cascade/create") {
    var cascCreateChunks = [];
    req.on("data", function(c) { cascCreateChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cascCreateChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
            labels:      ["qa-auto", "cascade-auto"]
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
            var pending3 = readBacklog(BACKLOG_PENDING);
            if (!pending3.find(function(t) { return t.key === createResult.key; })) {
              pending3.push({ key: createResult.key, summary: tc.summary, type: tc.type,
                jiraStatus: "BACKLOG", phase: "entrant", addedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(), notes: "Créé en cascade depuis " + parentKey,
                cascadeSuggestion: null, xraySteps: null });
              writeBacklog(BACKLOG_PENDING, pending3);
            }
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
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // XRAY — suggestion de steps IA + push vers Xray
  // ══════════════════════════════════════════════════════════════════════════

  if (method === "POST" && url.startsWith("/api/xray/suggest-steps/")) {
    var xrayKey = url.replace("/api/xray/suggest-steps/", "");
    var xsChunks = [];
    req.on("data", function(c) { xsChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(xsChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
            var steps = await leadQA.buildXraySteps({
              key: xrayKey,
              summary: f.summary || "",
              description: desc
            });
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
    return true;
  }

  if (method === "POST" && url.startsWith("/api/xray/push-steps/")) {
    var xpKey = url.replace("/api/xray/push-steps/", "");
    var xpChunks = [];
    req.on("data", function(c) { xpChunks.push(c); });
    req.on("end", async function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(xpChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
    return true;
  }

  if (method === "POST" && url === "/api/xray/update-result") {
    var xrChunks = [];
    req.on("data", function(c) { xrChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(xrChunks).toString()); } catch(e) { console.error("[BACKLOG] Erreur parse body :", e.message); }
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
    return true;
  }

  // ── XRAY CSV IMPORT ───────────────────────────────────────────────────────
  if (method === "POST" && url.match(/^\/api\/xray\/import-csv\/[A-Z]+-\d+$/)) {
    var xrayImportKey = url.split("/").pop();
    var xrayBody = "";
    req.on("data", function(c) { xrayBody += c; });
    req.on("end", function() {
      var csvData = "";
      try {
        var parsed = JSON.parse(xrayBody);
        csvData = parsed.csv || "";
      } catch(e) {
        csvData = xrayBody;
      }

      if (!csvData) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "CSV vide" }));
        return;
      }

      ctx.importXrayCSV(xrayImportKey, csvData).then(function(result) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }).catch(function(err) {
        var fallbackDir = path.join(BASE_DIR, "inbox", "xray-pending");
        if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
        fs.writeFileSync(path.join(fallbackDir, xrayImportKey + "-cas-test.csv"), "\uFEFF" + csvData, "utf8");

        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message, savedLocally: true, path: "inbox/xray-pending/" + xrayImportKey + "-cas-test.csv" }));
      });
    });
    return true;
  }

  // ── XRAY PENDING CSVs ─────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/xray/pending") {
    var pendingDir = path.join(BASE_DIR, "inbox", "xray-pending");
    var pendingList = [];
    try {
      if (fs.existsSync(pendingDir)) {
        pendingList = fs.readdirSync(pendingDir)
          .filter(function(f) { return f.endsWith(".csv"); })
          .map(function(f) {
            var key = f.replace("-cas-test.csv", "");
            return { key: key, file: f, path: "inbox/xray-pending/" + f };
          });
      }
    } catch(e) { console.error("[BACKLOG] Erreur lecture xray-pending :", e.message); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(pendingList));
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BRIEFING IA — Vue d'ensemble (hybride : règles locales + 1 appel Haiku)
  // ══════════════════════════════════════════════════════════════════════════

  if (method === "GET" && url === "/api/briefing") {
    var BACKLOG_P = path.join(BASE_DIR, "inbox", "backlog", "pending.json");
    var ENRICHED_DIR = path.join(BASE_DIR, "inbox", "enriched");
    var TRACKER_PATH = path.join(BASE_DIR, "reports", "release-tracker.json");
    var CYCLE_STATE  = path.join(BASE_DIR, "cycle-state.json");
    var AUTH_DIR     = path.join(BASE_DIR, "auth");

    // ── Collecte de données (0 token) ──
    var alerts = [];
    var context = {};

    try {
      // 1. Backlog
      var pending = [];
      try { pending = JSON.parse(fs.readFileSync(BACKLOG_P, "utf8")); } catch(e) {}
      var stories = pending.filter(function(t) { return t.type === "Story" || t.type === "User Story"; });
      var highPrio = pending.filter(function(t) {
        return (t.priority === "High" || t.priority === "Highest" || t.priority === "Critical");
      });
      var uncovered = stories.filter(function(t) { return !t.hasTest && !t.testKey; });
      context.totalTickets = pending.length;
      context.totalStories = stories.length;
      context.uncoveredUS = uncovered.length;

      if (uncovered.length > 0) {
        var uncovKeys = uncovered.slice(0, 5).map(function(t) { return t.key; }).join(", ");
        alerts.push({
          type: "coverage",
          severity: uncovered.length > 3 ? "high" : "medium",
          data: uncovered.length + " US sans couverture test" + (uncovered.length <= 5 ? " (" + uncovKeys + ")" : "")
        });
      }

      if (highPrio.length > 0) {
        var hpNoTest = highPrio.filter(function(t) { return !t.hasTest && !t.testKey; });
        if (hpNoTest.length > 0) {
          alerts.push({
            type: "priority",
            severity: "high",
            data: hpNoTest.length + " tickets haute priorité sans test : " + hpNoTest.slice(0, 3).map(function(t) { return t.key; }).join(", ")
          });
        }
      }

      // 2. Release tracker
      var tracker = {};
      try { tracker = JSON.parse(fs.readFileSync(TRACKER_PATH, "utf8")); } catch(e) {}
      var releases = Object.keys(tracker);
      if (releases.length > 0) {
        var latestRel = releases[releases.length - 1];
        var rd = tracker[latestRel];
        var pass = rd.totalPass || 0;
        var fail = rd.totalFail || 0;
        var tested = pass + fail;
        var pct = tested > 0 ? Math.round(pass / tested * 100) : 0;
        context.release = latestRel;
        context.passPct = pct;
        context.pass = pass;
        context.fail = fail;

        if (fail > 0) {
          var failTickets = (rd.tickets || []).filter(function(t) { return t.status === "FAIL"; });
          var failKeys = failTickets.slice(0, 4).map(function(t) { return t.key || t.ticketKey; }).filter(Boolean).join(", ");
          alerts.push({
            type: "release",
            severity: pct < 50 ? "high" : pct < 80 ? "medium" : "low",
            data: "Release " + latestRel + " à " + pct + "% de réussite — " + fail + " FAIL" + (failKeys ? " (" + failKeys + ")" : "")
          });
        }
      }

      // 3. Cycles QA
      var cycleState = {};
      try { cycleState = JSON.parse(fs.readFileSync(CYCLE_STATE, "utf8")); } catch(e) {}
      var now = Date.now();

      ["cycle1", "cycle2", "cycle3"].forEach(function(cKey) {
        var c = cycleState[cKey];
        if (!c || !c.lastRun) return;
        var lastRunMs = new Date(c.lastRun).getTime();
        var daysSince = Math.floor((now - lastRunMs) / (24 * 60 * 60 * 1000));
        if (daysSince >= 3) {
          alerts.push({
            type: "cycle",
            severity: daysSince >= 7 ? "high" : "medium",
            data: cKey.replace("cycle", "Cycle ") + " non lancé depuis " + daysSince + " jours"
          });
        }
        if (c.status === "error") {
          alerts.push({
            type: "cycle-error",
            severity: "high",
            data: cKey.replace("cycle", "Cycle ") + " en erreur : " + (c.lastError || "erreur inconnue").substring(0, 80)
          });
        }
      });

      // 4. Sessions Playwright
      ["sophie", "paulo", "prod"].forEach(function(env) {
        var authFile = path.join(AUTH_DIR, env + ".json");
        if (!fs.existsSync(authFile)) {
          alerts.push({ type: "session", severity: env === "prod" ? "medium" : "low", data: "Session " + env + " absente (auth/" + env + ".json)" });
        } else {
          try {
            var stat = fs.statSync(authFile);
            var ageDays = Math.floor((now - stat.mtimeMs) / (24 * 60 * 60 * 1000));
            if (ageDays >= 7) {
              alerts.push({ type: "session", severity: "medium", data: "Session " + env + " expirée (" + ageDays + " jours)" });
            }
          } catch(e) {}
        }
      });

      // 5. Enrichissements en attente
      var enrichedCount = 0;
      try {
        if (fs.existsSync(ENRICHED_DIR)) {
          var eFiles = fs.readdirSync(ENRICHED_DIR).filter(function(f) { return f.endsWith(".json"); });
          enrichedCount = eFiles.length;
          if (enrichedCount > 0) {
            var withStrategy = 0;
            eFiles.slice(0, 20).forEach(function(f) {
              try {
                var ed = JSON.parse(fs.readFileSync(path.join(ENRICHED_DIR, f), "utf8"));
                if (ed.strategy) withStrategy++;
              } catch(e) {}
            });
            if (enrichedCount >= 5) {
              alerts.push({
                type: "enriched",
                severity: enrichedCount >= 10 ? "medium" : "low",
                data: enrichedCount + " tickets enrichis en attente de validation" + (withStrategy > 0 ? " (dont " + withStrategy + " avec stratégie IA)" : "")
              });
            }
          }
        }
      } catch(e) {}
      context.enrichedPending = enrichedCount;

    } catch(e) {
      console.error("[BRIEFING] Erreur collecte données :", e.message);
    }

    // ── Synthèse IA (1 seul appel Haiku, ~200 tokens output) ──
    if (alerts.length === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        bullets: ["Aucune alerte — tous les indicateurs sont au vert."],
        alerts: [],
        context: context,
        source: "local",
        cached: false
      }));
      return true;
    }

    // Si pas de client IA disponible → retour brut
    if (!leadQA || !leadQA.ask) {
      var rawBullets = alerts.map(function(a) {
        var icon = a.severity === "high" ? "!!" : a.severity === "medium" ? "!" : "";
        return icon + " " + a.data;
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ bullets: rawBullets, alerts: alerts, context: context, source: "local", cached: false }));
      return true;
    }

    // Appel Haiku léger avec cache briefing (30min TTL)
    var briefingPrompt =
      "Tu es un QA Lead. Voici les alertes détectées automatiquement sur le projet :\n\n" +
      alerts.map(function(a, i) { return (i+1) + ". [" + a.severity.toUpperCase() + "] " + a.data; }).join("\n") +
      "\n\nContexte : " + JSON.stringify(context) +
      "\n\nSynthétise en 3 à 5 bullets concis et actionnables en français. " +
      "Chaque bullet commence par un emoji pertinent. " +
      "Mets en avant les risques et les actions prioritaires. " +
      "Format : un array JSON de strings. Exemple : [\"bullet1\",\"bullet2\"]";

    leadQA.ask(briefingPrompt, leadQA.MODEL_FAST, "Tu es un assistant QA Senior. Réponds uniquement avec un array JSON de strings.", { cache: "briefing", maxTokens: 300 })
      .then(function(iaText) {
        var bullets;
        // Détecter si l'IA a retourné une erreur (Ollama RAM, etc.)
        if (iaText && iaText.indexOf('"error"') !== -1 && iaText.indexOf('memory') !== -1) {
          throw new Error("LLM indisponible");
        }
        try {
          iaText = iaText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
          bullets = JSON.parse(iaText);
          if (!Array.isArray(bullets)) throw new Error("not array");
        } catch(e) {
          // Fallback : découper par lignes si c'est du texte lisible
          if (iaText && iaText.length > 10 && iaText.indexOf('"error"') === -1) {
            bullets = iaText.split("\n").filter(function(l) { return l.trim().length > 0; }).slice(0, 5);
          } else {
            throw new Error("Réponse IA invalide");
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ bullets: bullets, alerts: alerts, context: context, source: "ia", cached: false }));
      })
      .catch(function(e) {
        console.error("[BRIEFING] Erreur IA :", e.message, "— fallback alertes brutes");
        var sevEmoji = { high: "🔴", medium: "🟠", low: "🔵" };
        var rawBullets = alerts.map(function(a) { return (sevEmoji[a.severity] || "•") + " " + a.data; });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ bullets: rawBullets, alerts: alerts, context: context, source: "fallback", cached: false }));
      });
    return true;
  }

  // ── GET /api/ia-cache/stats — Statistiques cache IA ──
  if (method === "GET" && url === "/api/ia-cache/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(leadQA.getCacheStats ? leadQA.getCacheStats() : {}));
    return true;
  }

  return false;
};
