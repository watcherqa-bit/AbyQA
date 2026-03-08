// routes/chat.js — Routes Chat IA, LLM, Ollama, Code, GitHub, WebSearch
"use strict";

var http = require("http");
var fs   = require("fs");
var path = require("path");
var { spawn } = require("child_process");

module.exports = function handle(method, url, req, res, ctx) {
  var CFG     = ctx.CFG;
  var sendSSE = ctx.sendSSE;
  var leadQA  = ctx.leadQA;
  var BASE_DIR = ctx.BASE_DIR;
  var _chatAnthropicClient = ctx._chatAnthropicClient;
  var CHAT_SYSTEM          = ctx.CHAT_SYSTEM;

  // ── API : LLM Ollama (streaming SSE) ──────────────────────────────────────
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
            } catch(e) { console.error("[CHAT] Erreur parse Ollama token :", e.message); }
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
    return true;
  }

  // ── API : Chat IA (streaming SSE) ──────────────────────────────────────────
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
        res.end(JSON.stringify({ ok: false, error: "ANTHROPIC_API_KEY non configurée dans .env" }));
        return;
      }

      // Troncature des messages pour rester sous ~25 000 tokens
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
            sendSSE(clientId, { type: 'chat-token', token: '\n\n\u23f3 _Rate limit atteint — nouvelle tentative dans ' + (wait/1000) + 's\u2026_\n\n' });
            setTimeout(tryChatStream, wait);
          } else if (err.status === 429) {
            sendSSE(clientId, { type: 'chat-error', message: 'Rate limit LLM API atteint (429). Patiente 1 minute ou passe en mode Sonnet.' });
          } else {
            sendSSE(clientId, { type: 'chat-error', message: err.message });
          }
        });
      }
      tryChatStream();
    });
    return true;
  }

  // ── API : Modèles Ollama disponibles ──────────────────────────────────────
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
    return true;
  }

  // ── API : Analyse de fichier (Vision IA / HTML / texte) ───────────────────
  if (method === "POST" && url === "/api/analyze-file") {
    var afChunks = [];
    req.on("data", function(c) { afChunks.push(c); });
    req.on("end", function() {
      try {
        var afBody = JSON.parse(Buffer.concat(afChunks).toString());
        var afData     = afBody.data     || "";
        var afMime     = afBody.mimeType || "text/plain";
        var afFilename = afBody.filename || "file";
        var afKey      = afBody.key      || "";

        if (afKey && afData) {
          var attachDir = path.join(BASE_DIR, "inbox", "enriched", "attachments", afKey);
          fs.mkdirSync(attachDir, { recursive: true });
          var ext = afFilename.split(".").pop() || "bin";
          var timestamp = Date.now();
          var savedName = timestamp + "-" + afFilename.replace(/[^a-z0-9._-]/gi, "_");
          fs.writeFileSync(path.join(attachDir, savedName), Buffer.from(afData, "base64"));
        }

        var imageTypes = ["image/png","image/jpeg","image/jpg","image/gif","image/webp"];
        var isImage = imageTypes.some(function(t) { return afMime.includes(t.split("/")[1]); });

        if (isImage) {
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
          var htmlContent = Buffer.from(afData, "base64").toString("utf8");
          var extracted   = leadQA.extractFromHTML(htmlContent);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, type: "html", text: extracted.text, selectors: extracted.selectors, filename: afFilename }));
        } else {
          var textContent = Buffer.from(afData, "base64").toString("utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, type: "text", text: textContent.substring(0, 4000), filename: afFilename }));
        }
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return true;
  }

  // ── API : Analyser un screenshot CSS avec Vision IA ───────────────────────
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
                    "1. Problèmes visuels / cassures CSS (layout, overflow, alignement, chevauchements)\n" +
                    "2. Points d'attention (couleurs, typographie, espacement)\n" +
                    "3. Ce qui semble correct\n\n" +
                    "Sois concis, liste chaque point sur une ligne séparée."
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
    return true;
  }

  // ── API : Analyse IA des logs Playwright ──────────────────────────────────
  if (method === "POST" && url === "/api/analyze-logs") {
    var alChunks = [];
    req.on("data", function(c) { alChunks.push(c); });
    req.on("end", function() {
      try {
        var body = JSON.parse(Buffer.concat(alChunks).toString());
        var logs = body.logs || "";
        if (!logs.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Pas de logs à analyser" }));
          return;
        }
        leadQA.analyzePlaywrightFail(logs, {}).then(function(diag) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(diag || { diagnosis: "Aucun diagnostic disponible" }));
        }).catch(function(err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || "Erreur analyse" }));
        });
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "JSON invalide" }));
      }
    });
    return true;
  }

  // ── API : Log event (diagnostic, correction, etc.) ────────────────────────
  if (method === "POST" && url === "/api/log-event") {
    var leChunks = [];
    req.on("data", function(c) { leChunks.push(c); });
    req.on("end", function() {
      try {
        var logEvt = JSON.parse(Buffer.concat(leChunks).toString());
        var logsDir = path.join(BASE_DIR, "inbox", "logs");
        if (!fs.existsSync(logsDir)) { try { fs.mkdirSync(logsDir, { recursive: true }); } catch(e) { console.error("[CHAT] Erreur creation logsDir :", e.message); } }
        var logFile = path.join(logsDir, "diag-actions.jsonl");
        fs.appendFileSync(logFile, JSON.stringify(logEvt) + "\n", "utf8");
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return true;
  }

  // ── API : CLI IA (spawn claude --print) ─────────────────────────────────
  if (method === "POST" && url === "/api/claude-code") {
    var ccChunks = [];
    req.on("data", function(c) { ccChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(ccChunks).toString()); } catch(e) { console.error("[CHAT] Erreur parse body claude-code :", e.message); }
      var ccPrompt   = body.prompt || "";
      var ccClientId = body.clientId || "default";
      if (!ccPrompt) { res.writeHead(400); res.end(JSON.stringify({ error: "prompt vide" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      var ccProc = spawn("claude", ["--print", ccPrompt], { cwd: BASE_DIR, shell: true, env: Object.assign({}, process.env) });
      var ccHasOutput = false;
      var ccStderr = "";
      ccProc.stdout.on("data", function(d) { ccHasOutput = true; sendSSE(ccClientId, { type: "chat-token", token: d.toString() }); });
      ccProc.stderr.on("data", function(d) { ccStderr += d.toString(); });
      ccProc.on("close", function(code) {
        if (!ccHasOutput && ccStderr) {
          sendSSE(ccClientId, { type: "chat-token", token: "Erreur l'outil CLI:\n" + ccStderr });
        }
        sendSSE(ccClientId, { type: "chat-done" });
      });
      ccProc.on("error", function(err) { sendSSE(ccClientId, { type: "chat-error", message: "claude CLI non disponible : " + err.message }); });
    });
    return true;
  }

  // ── API : GitHub file import ──────────────────────────────────────────────
  if (method === "GET" && url.startsWith("/api/github-file")) {
    var httpsGH = require("https");
    var qsGH    = (url.split("?")[1] || "");
    var rawGH   = decodeURIComponent(qsGH.replace(/^.*url=([^&]*).*$/, "$1")).trim();
    if (rawGH.includes("github.com") && rawGH.includes("/blob/")) {
      rawGH = rawGH.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/");
    }
    if (!rawGH.startsWith("http")) rawGH = "https://raw.githubusercontent.com/" + rawGH;
    var ghReq = httpsGH.get(rawGH, { headers: { "User-Agent": "QA-Agent/2" } }, function(ghRes) {
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
    return true;
  }

  // ── API : Web search (DuckDuckGo instant answers) ─────────────────────────
  if (method === "GET" && url.startsWith("/api/websearch")) {
    var httpsWS = require("https");
    var qsWS    = (url.split("?")[1] || "");
    var qWS     = decodeURIComponent(qsWS.replace(/^.*q=([^&]*).*$/, "$1")).trim();
    var wsPath  = "/?q=" + encodeURIComponent(qWS) + "&format=json&no_html=1&skip_disambig=1&t=abyqa";
    var wsReq   = httpsWS.get({ hostname: "api.duckduckgo.com", path: wsPath, headers: { "User-Agent": "QA-Agent/2" } }, function(wsRes) {
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
    return true;
  }

  // ── Chat Projects — CRUD ─────────────────────────────────────────────────
  var CHAT_PROJECTS_DIR = path.join(BASE_DIR, "inbox", "chat-projects");
  if (!fs.existsSync(CHAT_PROJECTS_DIR)) fs.mkdirSync(CHAT_PROJECTS_DIR, { recursive: true });

  if (method === "GET" && url === "/api/chat-projects") {
    var cpFiles = [];
    try { cpFiles = fs.readdirSync(CHAT_PROJECTS_DIR).filter(function(f) { return f.endsWith(".json"); }); } catch(e) { console.error("[CHAT] Erreur lecture chat-projects :", e.message); }
    var cpList = cpFiles.map(function(f) {
      var stat = fs.statSync(path.join(CHAT_PROJECTS_DIR, f));
      var dat  = {}; try { dat = JSON.parse(fs.readFileSync(path.join(CHAT_PROJECTS_DIR, f), "utf8")); } catch(e) { console.error("[CHAT] Erreur parse projet :", e.message); }
      return { name: f.replace(".json", ""), updatedAt: stat.mtime, messageCount: (dat.messages || []).length };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, projects: cpList }));
    return true;
  }

  if (method === "POST" && url === "/api/chat-projects") {
    var cpPostChunks = [];
    req.on("data", function(c) { cpPostChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cpPostChunks).toString()); } catch(e) { console.error("[CHAT] Erreur parse body :", e.message); }
      var cpName = (body.name || "").replace(/[^\w\s\-]/g, "").trim();
      if (!cpName) { res.writeHead(400); res.end(JSON.stringify({ error: "nom vide" })); return; }
      fs.writeFileSync(path.join(CHAT_PROJECTS_DIR, cpName + ".json"), JSON.stringify({ name: cpName, messages: [], createdAt: new Date() }, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: cpName }));
    });
    return true;
  }

  if (method === "GET" && url.startsWith("/api/chat-projects/")) {
    var cpGetName = decodeURIComponent(url.replace("/api/chat-projects/", "").split("?")[0]);
    var cpGetFile = path.join(CHAT_PROJECTS_DIR, cpGetName + ".json");
    if (!fs.existsSync(cpGetFile)) { res.writeHead(404); res.end(JSON.stringify({ error: "introuvable" })); return true; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fs.readFileSync(cpGetFile));
    return true;
  }

  if (method === "PUT" && url.startsWith("/api/chat-projects/")) {
    var cpPutName = decodeURIComponent(url.replace("/api/chat-projects/", "").split("?")[0]);
    var cpPutChunks = [];
    req.on("data", function(c) { cpPutChunks.push(c); });
    req.on("end", function() {
      var body = {}; try { body = JSON.parse(Buffer.concat(cpPutChunks).toString()); } catch(e) { console.error("[CHAT] Erreur parse body PUT :", e.message); }
      var cpPutFile = path.join(CHAT_PROJECTS_DIR, cpPutName + ".json");
      var existing  = {}; try { if (fs.existsSync(cpPutFile)) existing = JSON.parse(fs.readFileSync(cpPutFile, "utf8")); } catch(e) { console.error("[CHAT] Erreur lecture projet existant :", e.message); }
      existing.messages   = body.messages || [];
      existing.updatedAt  = new Date();
      fs.writeFileSync(cpPutFile, JSON.stringify(existing, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return true;
  }

  if (method === "DELETE" && url.startsWith("/api/chat-projects/")) {
    var cpDelName = decodeURIComponent(url.replace("/api/chat-projects/", "").split("?")[0]);
    var cpDelFile = path.join(CHAT_PROJECTS_DIR, cpDelName + ".json");
    if (fs.existsSync(cpDelFile)) fs.unlinkSync(cpDelFile);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
};
