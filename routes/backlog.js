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
    return true;
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
    return true;
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
      var body = {}; try { body = JSON.parse(Buffer.concat(cascChunks).toString()); } catch(e) {}
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
    return true;
  }

  if (method === "POST" && url === "/api/xray/update-result") {
    var xrChunks = [];
    req.on("data", function(c) { xrChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(xrChunks).toString()); } catch(e) {}
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
    } catch(e) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(pendingList));
    return true;
  }

  return false;
};
