// routes/enriched.js — Routes Tickets Enrichis + File Tests
"use strict";

var fs   = require("fs");
var path = require("path");

module.exports = function handle(method, url, req, res, ctx) {
  var CFG              = ctx.CFG;
  var BASE_DIR         = ctx.BASE_DIR;
  var attachFileToJira = ctx.attachFileToJira;

  var ENRICHED_DIR = path.join(BASE_DIR, "inbox", "enriched");
  if (!fs.existsSync(ENRICHED_DIR)) fs.mkdirSync(ENRICHED_DIR, { recursive: true });

  // ── Liste des tickets enrichis ────────────────────────────────────────────
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
    return true;
  }

  // ── Détail d'un ticket enrichi ────────────────────────────────────────────
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
    return true;
  }

  // ── Sauvegarder les modifications (éditeur markdown) ──────────────────────
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
    return true;
  }

  // ── Approuver → push dans Jira ───────────────────────────────────────────
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

        // Attacher automatiquement les fichiers stockés localement
        var attachDir = path.join(BASE_DIR, "inbox", "enriched", "attachments", apKey);
        var attachedFiles = 0;
        if (fs.existsSync(attachDir)) {
          var afiles = fs.readdirSync(attachDir);
          attachedFiles = afiles.length;
          if (afiles.length > 0) {
            afiles.forEach(function(fname) {
              attachFileToJira(apKey, path.join(attachDir, fname));
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
    return true;
  }

  // ── Rejeter → marquer rejected ───────────────────────────────────────────
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
    return true;
  }

  // ── File des tests prêts à lancer dans Playwright Direct ─────────────────
  var TESTS_DIR = path.join(BASE_DIR, "inbox", "tests");
  if (!fs.existsSync(TESTS_DIR)) fs.mkdirSync(TESTS_DIR, { recursive: true });

  if (method === "GET" && url === "/api/tests-queue") {
    try {
      var tFiles = fs.readdirSync(TESTS_DIR).filter(function(f) { return f.endsWith(".json"); });
      var tList  = tFiles.map(function(f) {
        try {
          var d = JSON.parse(fs.readFileSync(path.join(TESTS_DIR, f), "utf8"));
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
    return true;
  }

  if (method === "GET" && url.startsWith("/api/tests-queue/")) {
    var tKey  = url.replace("/api/tests-queue/", "").split("?")[0];
    var tFile = path.join(TESTS_DIR, tKey + ".json");
    if (fs.existsSync(tFile)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(fs.readFileSync(tFile, "utf8"));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Test introuvable" }));
    }
    return true;
  }

  if (method === "DELETE" && url.startsWith("/api/tests-queue/")) {
    var dtKey  = url.replace("/api/tests-queue/", "").split("?")[0];
    var dtFile = path.join(TESTS_DIR, dtKey + ".json");
    if (fs.existsSync(dtFile)) {
      var dtData = JSON.parse(fs.readFileSync(dtFile, "utf8"));
      dtData.status = "done";
      dtData.doneAt = new Date().toISOString();
      fs.writeFileSync(dtFile, JSON.stringify(dtData, null, 2), "utf8");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
};
