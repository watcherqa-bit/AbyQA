// agent-playwright-mcp.js — Agent Autopilot IA (Vision + Playwright)
// Pilote un navigateur en temps réel via Claude Vision API
// Usage :
//   node agent-playwright-mcp.js --env=sophie --objective="Tester le switch de langue" --max-steps=15
//   node agent-playwright-mcp.js --env=sophie --key=SAFWBST-2695 --objective="Vérifier le formulaire contact" --model=quality

"use strict";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

const fs     = require("fs");
const path   = require("path");
const { chromium } = require("playwright");
const Anthropic    = require("@anthropic-ai/sdk");
const CFG          = require("./config");
const scenarioExec = require("./scenario-executor");
const reporterUtils = require("./reporter-utils");
CFG.paths.init();

const REPORTS_DIR     = CFG.paths.reports;
const SCREENSHOTS_DIR = CFG.paths.screenshots;
const BASE_DIR        = __dirname;

// ── PARSE ARGUMENTS (centralisé dans lib/cli-args.js) ────────────────────────
var parseArgs = require("./lib/cli-args").parseArgs;

var ARGS         = parseArgs();
var ENV_NAME     = ARGS.env || "sophie";
var KEY          = ARGS.key || null;
var OBJECTIVE    = ARGS.objective || "Explorer et tester la page";
var MODEL_CHOICE = ARGS.model || "fast";
var NO_JIRA_PUSH = !!ARGS["no-jira-push"];
var URLS_RAW     = ARGS.urls || null;

// Charger les settings autopilot
var SETTINGS = {};
try { SETTINGS = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); } catch(e) { /* non bloquant */ }
var AP_SETTINGS = SETTINGS.autopilot || {};

var MAX_STEPS    = parseInt(ARGS["max-steps"]) || AP_SETTINGS.maxSteps || 30;
var COST_LIMIT   = AP_SETTINGS.costLimitUSD || 0.50;

// ── MODÈLES CLAUDE ──────────────────────────────────────────────────────────
var MODEL_FAST    = "claude-haiku-4-5-20251001";
var MODEL_QUALITY = "claude-sonnet-4-6";
var MODEL         = MODEL_CHOICE === "quality" ? MODEL_QUALITY : MODEL_FAST;

// Coûts par million de tokens (USD)
var COSTS = {};
COSTS[MODEL_FAST]    = { input: 0.80, output: 4.00 };
COSTS[MODEL_QUALITY] = { input: 3.00, output: 15.00 };

var client = new Anthropic({ apiKey: CFG.anthropic.apiKey });

// ── STORAGESTATE (centralisé dans lib/session-check.js) ──────────────────────
var checkStorageStateAge = require("./lib/session-check").checkStorageStateAge;

// ── PROGRESS ─────────────────────────────────────────────────────────────────
function emitProgress(step, message, pct, extra) {
  var data = { step: step, message: message, pct: pct };
  if (extra) Object.assign(data, extra);
  console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify(data));
}

// ── PROMPT SYSTÈME ───────────────────────────────────────────────────────────
function buildSystemPrompt(objective, ticketContext, maxSteps) {
  return "Tu es un testeur QA expert qui pilote un navigateur web en temps réel.\n" +
    "Tu reçois une capture d'écran de la page actuelle et tu dois décider la prochaine action.\n\n" +
    "OBJECTIF DU TEST : " + objective + "\n\n" +
    (ticketContext ? "CONTEXTE TICKET :\n" + ticketContext.substring(0, 500) + "\n\n" : "") +
    "ACTIONS DISPONIBLES (réponds avec le JSON correspondant) :\n" +
    "- navigate : { \"action\": \"navigate\", \"url\": \"https://...\" }\n" +
    "- click : { \"action\": \"click\", \"selector\": \"CSS selector ou texte visible entre guillemets\" }\n" +
    "- fill : { \"action\": \"fill\", \"selector\": \"CSS selector\", \"value\": \"texte\" }\n" +
    "- select : { \"action\": \"select\", \"selector\": \"CSS selector\", \"value\": \"option\" }\n" +
    "- hover : { \"action\": \"hover\", \"selector\": \"CSS selector\" }\n" +
    "- press : { \"action\": \"press\", \"key\": \"Enter|Tab|Escape|ArrowDown|...\" }\n" +
    "- scroll : { \"action\": \"scroll\", \"direction\": \"down|up\", \"amount\": 300 }\n" +
    "- wait : { \"action\": \"wait\", \"ms\": 2000 }\n" +
    "- back : { \"action\": \"back\" }\n" +
    "- assert : { \"action\": \"assert\", \"type\": \"text|url|element|title\", \"expected\": \"valeur attendue\" }\n" +
    "- done : { \"action\": \"done\", \"status\": \"PASS|FAIL\", \"summary\": \"résumé\" }\n\n" +
    "RÈGLES :\n" +
    "1. Réponds UNIQUEMENT en JSON valide. Pas de markdown, pas de texte avant/après.\n" +
    "2. Chaque réponse DOIT contenir : \"thought\" (ton raisonnement) et \"action\" (le type).\n" +
    "3. Pour les sélecteurs, préfère dans cet ordre : text=\\\"Texte visible\\\" > [aria-label=\\\"...\\\"] > [data-testid=\\\"...\\\"] > sélecteur CSS.\n" +
    "4. Si un élément n'est pas visible, scroll d'abord.\n" +
    "5. Si tu détectes une anomalie visuelle ou fonctionnelle, ajoute \"issue\": \"description\".\n" +
    "6. Une fois l'objectif vérifié, termine avec action \"done\" + status PASS ou FAIL.\n" +
    "7. Si tu es bloqué après 3 tentatives sur le même élément, termine avec FAIL.\n" +
    "8. Tu as maximum " + maxSteps + " étapes. Planifie efficacement.\n" +
    "9. Ne clique JAMAIS sur des liens de politique de cookies ou popups hors-sujet sauf si c'est l'objectif.\n\n" +
    "FORMAT :\n" +
    "{ \"thought\": \"...\", \"action\": \"click\", \"selector\": \"...\", \"issue\": null }";
}

// ── CAPTURE SCREENSHOT ───────────────────────────────────────────────────────
async function captureAndEncode(page, stepNum) {
  var filename = "autopilot-" + ENV_NAME + "-step" + stepNum + "-" + Date.now() + ".png";
  var filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, type: "png" });
  var buf = fs.readFileSync(filepath);
  return { path: filepath, filename: filename, base64: buf.toString("base64"), sizeBytes: buf.length };
}

// ── APPEL CLAUDE VISION ──────────────────────────────────────────────────────
async function callVision(systemPrompt, messages, model) {
  var retries = 0;
  var maxRetries = 3;
  var delays = [5000, 15000, 30000];

  while (retries < maxRetries) {
    try {
      var response = await client.messages.create({
        model: model,
        max_tokens: 512,
        system: systemPrompt,
        messages: messages
      });
      return {
        text: response.content[0].text,
        usage: response.usage || { input_tokens: 0, output_tokens: 0 }
      };
    } catch(e) {
      if (e.status === 429 && retries < maxRetries - 1) {
        retries++;
        console.log("  [VISION] Rate limit 429, retry " + retries + "/" + maxRetries + " dans " + (delays[retries - 1] / 1000) + "s...");
        await new Promise(function(r) { setTimeout(r, delays[retries - 1]); });
      } else {
        throw e;
      }
    }
  }
}

// ── PARSER LA RÉPONSE CLAUDE ─────────────────────────────────────────────────
function parseAction(text) {
  // Nettoyer la réponse (enlever markdown si présent)
  var cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  try {
    var parsed = JSON.parse(cleaned);
    return { ok: true, data: parsed };
  } catch(e) {
    return { ok: false, data: null, raw: text, error: e.message };
  }
}

// ── EXÉCUTER UNE ACTION PLAYWRIGHT ───────────────────────────────────────────
async function executeAction(page, action) {
  var result = { action: action.action, selector: action.selector || null, pass: true, error: null, detail: "" };
  var timeout = 5000;

  try {
    switch (action.action) {
      case "navigate":
        var resp = await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 10000 });
        var httpCode = resp ? resp.status() : 0;
        result.detail = "Navigué vers " + action.url + " (HTTP " + httpCode + ")";
        // Vérif Cloudflare
        var cfCheck = await scenarioExec.detectCloudflare(page, httpCode);
        if (cfCheck.blocked) {
          result.pass = false;
          result.blocked = true;
          result.error = cfCheck.reason;
          result.detail = "CLOUDFLARE BLOQUÉ — " + cfCheck.reason;
        }
        break;

      case "click":
        await page.locator(action.selector).click({ timeout: timeout });
        result.detail = "Cliqué sur " + action.selector;
        await page.waitForTimeout(500);
        break;

      case "fill":
        await page.locator(action.selector).fill(action.value || "", { timeout: timeout });
        result.detail = "Rempli " + action.selector + " avec \"" + (action.value || "") + "\"";
        break;

      case "select":
        await page.locator(action.selector).selectOption(action.value || "", { timeout: timeout });
        result.detail = "Sélectionné \"" + (action.value || "") + "\" dans " + action.selector;
        break;

      case "hover":
        await page.locator(action.selector).hover({ timeout: timeout });
        result.detail = "Survolé " + action.selector;
        break;

      case "press":
        await page.keyboard.press(action.key || "Enter");
        result.detail = "Appuyé sur " + (action.key || "Enter");
        await page.waitForTimeout(300);
        break;

      case "scroll":
        var delta = (action.direction === "up" ? -1 : 1) * (action.amount || 300);
        await page.mouse.wheel(0, delta);
        result.detail = "Scrollé " + (action.direction || "down") + " de " + Math.abs(delta) + "px";
        await page.waitForTimeout(500);
        break;

      case "wait":
        var ms = Math.min(action.ms || 1000, 5000);
        await page.waitForTimeout(ms);
        result.detail = "Attendu " + ms + "ms";
        break;

      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });
        result.detail = "Retour page précédente";
        break;

      case "assert":
        result = await executeAssert(page, action, result);
        break;

      case "done":
        result.detail = "Terminé — " + (action.status || "PASS") + " : " + (action.summary || "");
        result.done = true;
        result.status = action.status || "PASS";
        result.summary = action.summary || "";
        break;

      default:
        result.pass = false;
        result.error = "Action inconnue: " + action.action;
    }
  } catch(e) {
    result.pass = false;
    result.error = e.message.substring(0, 200);
    result.detail = "ERREUR " + action.action + " — " + result.error;
  }

  return result;
}

// ── ASSERTIONS ───────────────────────────────────────────────────────────────
async function executeAssert(page, action, result) {
  try {
    var type = action.type || "text";
    var expected = action.expected || "";

    switch (type) {
      case "url":
        var currentUrl = page.url();
        if (currentUrl.indexOf(expected) !== -1) {
          result.detail = "URL contient \"" + expected + "\" (" + currentUrl + ")";
        } else {
          result.pass = false;
          result.error = "URL ne contient pas \"" + expected + "\" (actuel: " + currentUrl + ")";
          result.detail = result.error;
        }
        break;

      case "text":
        var bodyText = await page.locator("body").innerText({ timeout: 3000 });
        if (bodyText.indexOf(expected) !== -1) {
          result.detail = "Page contient le texte \"" + expected + "\"";
        } else {
          result.pass = false;
          result.error = "Texte \"" + expected + "\" introuvable sur la page";
          result.detail = result.error;
        }
        break;

      case "element":
        var count = await page.locator(expected).count();
        if (count > 0) {
          result.detail = "Élément \"" + expected + "\" présent (" + count + " trouvé" + (count > 1 ? "s" : "") + ")";
        } else {
          result.pass = false;
          result.error = "Élément \"" + expected + "\" introuvable";
          result.detail = result.error;
        }
        break;

      case "title":
        var title = await page.title();
        if (title.indexOf(expected) !== -1) {
          result.detail = "Titre contient \"" + expected + "\" (" + title + ")";
        } else {
          result.pass = false;
          result.error = "Titre ne contient pas \"" + expected + "\" (actuel: " + title + ")";
          result.detail = result.error;
        }
        break;

      default:
        result.detail = "Type d'assertion inconnu: " + type;
    }
  } catch(e) {
    result.pass = false;
    result.error = "Assertion échouée: " + e.message.substring(0, 150);
    result.detail = result.error;
  }
  return result;
}

// ── DÉTECTION BOUCLE ─────────────────────────────────────────────────────────
function detectStuckLoop(history) {
  if (history.length < 3) return false;
  var last3 = history.slice(-3);
  var same = last3.every(function(h) {
    return h.action === last3[0].action && h.selector === last3[0].selector;
  });
  return same;
}

// ── TRACKER TOKENS ───────────────────────────────────────────────────────────
function updateTokenTracker(tracker, usage, model) {
  var costs = COSTS[model] || COSTS[MODEL_FAST];
  tracker.inputTokens  += (usage.input_tokens || 0);
  tracker.outputTokens += (usage.output_tokens || 0);
  tracker.calls++;
  tracker.costUSD = (tracker.inputTokens * costs.input + tracker.outputTokens * costs.output) / 1000000;
}

// ── BOUCLE AUTOPILOT ─────────────────────────────────────────────────────────
async function autopilotLoop(page, objective, opts) {
  opts = opts || {};
  var maxSteps      = opts.maxSteps || MAX_STEPS;
  var model         = opts.model || MODEL;
  var ticketContext  = opts.ticketContext || "";
  var systemPrompt  = buildSystemPrompt(objective, ticketContext, maxSteps);

  var conversationHistory = []; // Messages Claude (multi-turn)
  var stepResults         = []; // Résultats pour le rapport
  var tokenTracker        = { inputTokens: 0, outputTokens: 0, calls: 0, costUSD: 0 };
  var actionHistory       = []; // Pour détection boucle
  var finalStatus         = "INCONCLUSIVE";
  var finalSummary        = "Limite de pas atteinte";

  for (var stepNum = 1; stepNum <= maxSteps; stepNum++) {
    var pct = Math.round((stepNum / maxSteps) * 90) + 5;
    emitProgress("autopilot-step-" + stepNum, "Étape " + stepNum + "/" + maxSteps, pct);

    // 1. Capturer screenshot
    var shot;
    try {
      shot = await captureAndEncode(page, stepNum);
    } catch(e) {
      console.log("  [AUTOPILOT] Erreur capture étape " + stepNum + " : " + e.message);
      break;
    }

    // 2. Construire le message utilisateur avec image
    var currentUrl = "about:blank";
    try { currentUrl = page.url(); } catch(e) { /* non bloquant */ }

    var userContent = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: shot.base64 } },
      { type: "text", text: "Étape " + stepNum + "/" + maxSteps + ". URL : " + currentUrl }
    ];

    // Ajouter le contexte de l'action précédente
    if (stepResults.length > 0) {
      var prev = stepResults[stepResults.length - 1];
      userContent[1].text += "\nAction précédente : " + prev.action + " → " + (prev.pass ? "OK" : "ERREUR: " + (prev.error || ""));
    }

    conversationHistory.push({ role: "user", content: userContent });

    // 3. Appeler Claude Vision
    var response;
    try {
      response = await callVision(systemPrompt, conversationHistory, model);
    } catch(e) {
      console.log("  [AUTOPILOT] Erreur API étape " + stepNum + " : " + e.message);
      finalStatus = "FAIL";
      finalSummary = "Erreur API Claude: " + e.message.substring(0, 100);
      break;
    }

    updateTokenTracker(tokenTracker, response.usage, model);

    // 4. Parser la réponse
    var parsed = parseAction(response.text);

    if (!parsed.ok) {
      // Retry une fois avec demande de JSON valide
      conversationHistory.push({ role: "assistant", content: response.text });
      conversationHistory.push({ role: "user", content: "Ta réponse n'était pas du JSON valide. Réponds uniquement avec un objet JSON. Erreur: " + parsed.error });

      try {
        response = await callVision(systemPrompt, conversationHistory, model);
        updateTokenTracker(tokenTracker, response.usage, model);
        parsed = parseAction(response.text);
      } catch(e) {
        console.log("  [AUTOPILOT] Erreur retry JSON étape " + stepNum + " : " + e.message);
      }

      if (!parsed.ok) {
        console.log("  [AUTOPILOT] JSON invalide 2x à l'étape " + stepNum + " — abandon");
        finalStatus = "FAIL";
        finalSummary = "Réponse IA invalide (pas de JSON)";
        break;
      }
    }

    var actionData = parsed.data;
    conversationHistory.push({ role: "assistant", content: JSON.stringify(actionData) });

    var thought = actionData.thought || "";
    var issue   = actionData.issue || null;

    console.log("  [AUTOPILOT] Étape " + stepNum + " — " + thought.substring(0, 80));
    emitProgress("autopilot-step-" + stepNum, "Étape " + stepNum + "/" + maxSteps + " — " + (actionData.action || "?") + " " + (actionData.selector || actionData.url || "").substring(0, 40), pct);

    // 5. Exécuter l'action
    var actionResult = await executeAction(page, actionData);
    actionResult.thought = thought;
    actionResult.issue = issue;
    actionResult.screenshot = shot.filename;
    actionResult.stepNum = stepNum;
    actionResult.url = currentUrl;

    stepResults.push(actionResult);
    actionHistory.push({ action: actionData.action, selector: actionData.selector || null });

    // 6. Vérifications de sortie

    // Action "done" → fin
    if (actionResult.done) {
      finalStatus = actionResult.status || "PASS";
      finalSummary = actionResult.summary || "Test terminé";
      console.log("  [AUTOPILOT] Terminé étape " + stepNum + " — " + finalStatus + " : " + finalSummary);
      break;
    }

    // Cloudflare bloqué → fin
    if (actionResult.blocked) {
      finalStatus = "BLOCKED";
      finalSummary = "Cloudflare bloqué — session expirée";
      console.log("  [AUTOPILOT] BLOQUÉ par Cloudflare étape " + stepNum);
      console.log("BUS_EVENT:" + JSON.stringify({ event: "session:expired", env: ENV_NAME, agent: "autopilot" }));
      break;
    }

    // Boucle détectée → fin
    if (detectStuckLoop(actionHistory)) {
      finalStatus = "FAIL";
      finalSummary = "Boucle détectée — 3x même action sur " + (actionData.selector || "?");
      console.log("  [AUTOPILOT] Boucle détectée étape " + stepNum + " — arrêt");
      break;
    }

    // Limite de coût → fin
    if (tokenTracker.costUSD >= COST_LIMIT) {
      finalStatus = "FAIL";
      finalSummary = "Limite de coût atteinte ($" + tokenTracker.costUSD.toFixed(2) + " >= $" + COST_LIMIT + ")";
      console.log("  [AUTOPILOT] Limite de coût atteinte — arrêt");
      break;
    }

    // Alerte coût à 50%
    if (tokenTracker.costUSD >= COST_LIMIT * 0.5 && tokenTracker.calls === stepNum) {
      emitProgress("autopilot-cost-warning", "Coût à " + Math.round((tokenTracker.costUSD / COST_LIMIT) * 100) + "% de la limite", pct, { costUSD: tokenTracker.costUSD });
    }

    // Petit délai entre les étapes pour laisser la page se stabiliser
    await page.waitForTimeout(500);

    // Optimisation mémoire : remplacer les vieux screenshots base64 dans l'historique par du texte
    // On garde seulement les 2 derniers messages avec images
    if (conversationHistory.length > 6) {
      for (var i = 0; i < conversationHistory.length - 4; i++) {
        var msg = conversationHistory[i];
        if (msg.role === "user" && Array.isArray(msg.content)) {
          // Remplacer image par texte résumé
          var textParts = msg.content.filter(function(c) { return c.type === "text"; });
          var textOnly = textParts.map(function(c) { return c.text; }).join(" ");
          conversationHistory[i] = { role: "user", content: "[Screenshot étape précédente] " + textOnly };
        }
      }
    }
  }

  return {
    steps: stepResults,
    tokenTracker: tokenTracker,
    totalSteps: stepResults.length,
    maxSteps: maxSteps,
    finalStatus: finalStatus,
    finalSummary: finalSummary
  };
}

// ── RAPPORT HTML ─────────────────────────────────────────────────────────────
function buildReport(loopResult, opts) {
  opts = opts || {};
  var results = loopResult.steps;
  var tracker = loopResult.tokenTracker;
  var status  = loopResult.finalStatus;
  var summary = loopResult.finalSummary;
  var date    = new Date().toLocaleDateString("fr-FR");
  var time    = new Date().toLocaleTimeString("fr-FR");

  var passCount = results.filter(function(r) { return r.pass && !r.done; }).length;
  var failCount = results.filter(function(r) { return !r.pass; }).length;
  var totalSteps = results.filter(function(r) { return !r.done; }).length;
  var pctColor = status === "PASS" ? "#00e87a" : status === "BLOCKED" ? "#ff9500" : "#ff3b5c";
  var statusIcon = status === "PASS" ? "&#10004;" : status === "BLOCKED" ? "&#9888;" : "&#10008;";

  // Lignes du tableau
  var rows = results.map(function(r) {
    var actionCol = "<strong>" + (r.action || "?") + "</strong>";
    if (r.selector) actionCol += " <span style='color:#8892a4;font-size:10px'>" + (r.selector || "").substring(0, 50) + "</span>";
    if (r.done) actionCol = "<strong style='color:" + pctColor + "'>DONE — " + (r.status || "") + "</strong>";

    var shotHtml = r.screenshot
      ? reporterUtils.buildScreenshotHtml(r.screenshot, null, SCREENSHOTS_DIR, { maxWidth: "100px", clickToZoom: false })
      : "<span style='color:#4a5568'>—</span>";

    var issueHtml = r.issue
      ? "<div style='margin-top:4px;padding:4px 8px;background:rgba(255,149,0,.1);border-radius:4px;font-size:10px;color:#ff9500'>" + r.issue + "</div>"
      : "";

    return "<tr style='border-bottom:1px solid #1e2536'>" +
      "<td style='padding:8px 12px;font-family:monospace;font-size:12px;color:#60a5fa;text-align:center;vertical-align:top'>" + (r.stepNum || "—") + "</td>" +
      "<td style='padding:8px 12px;font-size:11px;color:#c9d1d9;vertical-align:top;max-width:250px;word-wrap:break-word'>" + (r.thought || "—").substring(0, 150) + issueHtml + "</td>" +
      "<td style='padding:8px 12px;font-size:11px;color:#e2e8f0;vertical-align:top'>" + actionCol + "<div style='margin-top:2px;font-size:10px;color:#8892a4'>" + (r.detail || "").substring(0, 80) + "</div></td>" +
      "<td style='padding:8px 12px;text-align:center;font-family:monospace;font-weight:700;color:" + (r.pass ? "#00e87a" : "#ff3b5c") + ";vertical-align:top'>" + (r.pass ? "OK" : "FAIL") + "</td>" +
      "<td style='padding:4px 8px;text-align:center;vertical-align:top'>" + shotHtml + "</td>" +
      "</tr>";
  }).join("");

  // Sections issues détectées
  var issuesFound = results.filter(function(r) { return r.issue; });
  var issuesSection = "";
  if (issuesFound.length > 0) {
    issuesSection = "<div style='margin-top:24px;padding:16px 20px;background:rgba(255,149,0,.08);border:1px solid rgba(255,149,0,.25);border-radius:10px'>" +
      "<h2 style='font-size:13px;color:#ff9500;margin:0 0 12px'>Anomalies détectées par l'IA (" + issuesFound.length + ")</h2>" +
      issuesFound.map(function(r) {
        return "<div style='margin-bottom:8px;padding:10px;background:#111520;border-radius:6px;border-left:3px solid #ff9500'>" +
          "<div style='font-size:12px;color:#ff9500;font-weight:700'>Étape " + r.stepNum + " — " + (r.action || "") + "</div>" +
          "<div style='font-size:11px;color:#c9d1d9;margin-top:4px'>" + r.issue + "</div>" +
          "</div>";
      }).join("") +
      "</div>";
  }

  var html = "<!DOCTYPE html><html lang='fr'><head><meta charset='utf-8'><title>Rapport Autopilot — " + (KEY || "direct") + "</title>" +
    "<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}" +
    "table{width:100%;border-collapse:collapse}th{background:#161b22;color:#8892a4;font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:10px 12px;text-align:left}" +
    "a{color:#00d4ff;text-decoration:none}img{border-radius:4px;cursor:pointer;transition:transform .2s}img:hover{transform:scale(1.5)}</style></head>" +
    "<body>" +
    "<div style='max-width:1200px;margin:0 auto'>" +

    // Header
    "<div style='display:flex;align-items:center;gap:16px;margin-bottom:24px'>" +
    "<div style='font-size:28px;font-weight:800;color:" + pctColor + "'>" + statusIcon + " AUTOPILOT</div>" +
    "<div>" +
    "<div style='font-size:14px;color:#e2e8f0;font-weight:600'>" + OBJECTIVE.substring(0, 80) + "</div>" +
    "<div style='font-size:11px;color:#8892a4'>" + (KEY ? KEY + " | " : "") + ENV_NAME + " | " + date + " " + time + " | Modèle: " + (MODEL_CHOICE === "quality" ? "Sonnet" : "Haiku") + "</div>" +
    "</div></div>" +

    // Stats cards
    "<div style='display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap'>" +
    "<div style='padding:12px 20px;background:#161b22;border-radius:8px;border-left:3px solid #60a5fa'><div style='font-size:10px;color:#8892a4;text-transform:uppercase'>Étapes</div><div style='font-size:22px;font-weight:700;color:#60a5fa'>" + loopResult.totalSteps + "/" + loopResult.maxSteps + "</div></div>" +
    "<div style='padding:12px 20px;background:#161b22;border-radius:8px;border-left:3px solid #00e87a'><div style='font-size:10px;color:#8892a4;text-transform:uppercase'>OK</div><div style='font-size:22px;font-weight:700;color:#00e87a'>" + passCount + "</div></div>" +
    "<div style='padding:12px 20px;background:#161b22;border-radius:8px;border-left:3px solid #ff3b5c'><div style='font-size:10px;color:#8892a4;text-transform:uppercase'>Erreurs</div><div style='font-size:22px;font-weight:700;color:#ff3b5c'>" + failCount + "</div></div>" +
    "<div style='padding:12px 20px;background:#161b22;border-radius:8px;border-left:3px solid " + pctColor + "'><div style='font-size:10px;color:#8892a4;text-transform:uppercase'>Statut</div><div style='font-size:22px;font-weight:700;color:" + pctColor + "'>" + status + "</div></div>" +
    "<div style='padding:12px 20px;background:#161b22;border-radius:8px;border-left:3px solid #a78bfa'><div style='font-size:10px;color:#8892a4;text-transform:uppercase'>Tokens</div><div style='font-size:14px;font-weight:700;color:#a78bfa'>" + tracker.inputTokens + "+" + tracker.outputTokens + "</div><div style='font-size:11px;color:#8892a4'>$" + tracker.costUSD.toFixed(3) + "</div></div>" +
    "</div>" +

    // Résumé
    "<div style='padding:12px 16px;background:#161b22;border-radius:8px;margin-bottom:24px;border-left:3px solid " + pctColor + "'>" +
    "<div style='font-size:12px;color:" + pctColor + ";font-weight:700'>Conclusion</div>" +
    "<div style='font-size:12px;color:#c9d1d9;margin-top:4px'>" + summary + "</div>" +
    "</div>" +

    // Tableau des étapes
    "<table>" +
    "<thead><tr><th>#</th><th>Pensée IA</th><th>Action</th><th>Résultat</th><th>Screenshot</th></tr></thead>" +
    "<tbody>" + rows + "</tbody></table>" +

    issuesSection +

    // Footer
    "<div style='margin-top:32px;padding-top:16px;border-top:1px solid #1e2536;font-size:10px;color:#4a5568;text-align:center'>" +
    "AbyQA Autopilot — " + tracker.calls + " appels API | " + tracker.inputTokens + " tokens in + " + tracker.outputTokens + " tokens out | $" + tracker.costUSD.toFixed(3) +
    "</div></div></body></html>";

  var statusPrefix = status === "PASS" ? "OK" : (status === "BLOCKED" ? "BLOCKED" : "FAIL");
  var filename = "RAPPORT-" + statusPrefix + "-AUTOPILOT-" + Date.now() + (KEY ? "-" + KEY : "") + ".html";
  var reportPath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(reportPath, html, "utf8");
  console.log("  [AUTOPILOT] Rapport généré : " + filename);

  return { reportPath: reportPath, filename: filename };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          AbyQA — Agent Autopilot IA (Vision)               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("  Env       : " + ENV_NAME);
  console.log("  Objectif  : " + OBJECTIVE);
  console.log("  Ticket    : " + (KEY || "—"));
  console.log("  Max steps : " + MAX_STEPS);
  console.log("  Modèle    : " + (MODEL_CHOICE === "quality" ? "Sonnet (qualité)" : "Haiku (rapide)"));
  console.log("  Coût max  : $" + COST_LIMIT);
  console.log("");

  emitProgress("autopilot-start", "Démarrage autopilot — " + OBJECTIVE.substring(0, 50), 2);

  // 1. Vérifier la session auth (non-bloquant pour prod / URLs publiques)
  var sessionCheck = checkStorageStateAge(ENV_NAME);
  var authAvailable = sessionCheck.ok;
  if (!sessionCheck.ok) {
    // Prod et URLs publiques peuvent fonctionner sans auth
    if (ENV_NAME === "prod" || (URLS_RAW && URLS_RAW.startsWith("http"))) {
      console.log("  [SESSION] Pas de session auth — mode public (prod / URL directe)");
    } else {
      console.log("  [SESSION] " + sessionCheck.message);
      emitProgress("session-warning", sessionCheck.message, 3, { sessionExpired: true });
      // Sur Render/cloud, on continue en mode dégradé au lieu de bloquer
      console.log("  [SESSION] Tentative sans auth (peut échouer si Cloudflare)...");
    }
  }

  // 2. Charger le contexte ticket si --key
  var ticketContext = "";
  if (KEY) {
    var enrichedPath = path.join(BASE_DIR, "inbox", "enriched", KEY + ".json");
    if (fs.existsSync(enrichedPath)) {
      try {
        var ticket = JSON.parse(fs.readFileSync(enrichedPath, "utf8"));
        ticketContext = (ticket.summary || "") + "\n" + (ticket.description || "");
        console.log("  [TICKET] Contexte chargé depuis " + KEY + ".json");
      } catch(e) {
        console.log("  [TICKET] Erreur lecture enriched : " + e.message);
      }
    } else {
      console.log("  [TICKET] Fichier enrichi non trouvé : " + enrichedPath);
    }
  }

  // 3. Déterminer l'URL de départ
  var ENV_URL = CFG.envs[ENV_NAME] || CFG.envs.sophie;
  var startUrl = ENV_URL + "/fr";
  if (URLS_RAW) {
    startUrl = URLS_RAW.split(",")[0].trim();
    if (!startUrl.startsWith("http")) startUrl = ENV_URL + startUrl;
  }

  // 4. Lancer le navigateur
  var browser = null;
  var page = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-infobars"]
    });

    var ctxOpts = {
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      }
    };

    // Basic Auth pour envs staging (si credentials dispo)
    if ((ENV_NAME === "sophie" || ENV_NAME === "paulo") && CFG.drupal && CFG.drupal.user) {
      ctxOpts.httpCredentials = { username: CFG.drupal.user, password: CFG.drupal.pass };
    }

    // StorageState (Cloudflare) — seulement si le fichier existe et est valide
    if (authAvailable) {
      var authFile = path.join(BASE_DIR, "auth", ENV_NAME + ".json");
      if (fs.existsSync(authFile)) {
        ctxOpts.storageState = authFile;
        console.log("  [AUTH] Session chargée : " + ENV_NAME);
      }
    } else {
      console.log("  [AUTH] Pas de session — mode sans auth");
    }

    var context = await browser.newContext(ctxOpts);
    await context.addInitScript(function() {
      Object.defineProperty(navigator, "webdriver", { get: function() { return undefined; } });
    });
    page = await context.newPage();

    // 5. Naviguer vers l'URL de départ
    console.log("  [NAV] " + startUrl);
    emitProgress("autopilot-navigate", "Navigation vers " + startUrl, 5);

    var resp = await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    var httpCode = resp ? resp.status() : 0;

    // Vérifier Cloudflare sur la page d'atterrissage
    var cfCheck = await scenarioExec.detectCloudflare(page, httpCode);
    if (cfCheck.blocked) {
      console.log("  [CLOUDFLARE] Page bloquée dès l'atterrissage — " + cfCheck.reason);
      emitProgress("session-blocked", "Cloudflare bloqué dès l'atterrissage", 100, { sessionBlocked: true });
      console.log("BUS_EVENT:" + JSON.stringify({ event: "test:completed", key: KEY, mode: "autopilot", env: ENV_NAME, status: "BLOCKED", pass: 0, fail: 0, blocked: 1, total: 0, reportPath: null }));
      await browser.close();
      process.exit(1);
      return;
    }

    // 6. Lancer la boucle autopilot
    console.log("  [AUTOPILOT] Boucle démarrée (max " + MAX_STEPS + " étapes, modèle " + MODEL + ")");
    var loopResult = await autopilotLoop(page, OBJECTIVE, {
      maxSteps: MAX_STEPS,
      model: MODEL,
      ticketContext: ticketContext
    });

    // 7. Générer le rapport
    var report = buildReport(loopResult, { key: KEY, env: ENV_NAME });

    // 8. Émettre les résultats
    var passCount = loopResult.steps.filter(function(r) { return r.pass && !r.done; }).length;
    var failCount = loopResult.steps.filter(function(r) { return !r.pass; }).length;
    var totalSteps = loopResult.steps.filter(function(r) { return !r.done; }).length;

    console.log("PLAYWRIGHT_DIRECT_RESULT:" + JSON.stringify({
      pass: passCount,
      fail: failCount,
      total: totalSteps,
      pct: totalSteps > 0 ? Math.round((passCount / totalSteps) * 100) : 0,
      mode: "autopilot",
      env: ENV_NAME,
      reportPath: report.filename,
      ticketKey: KEY,
      tokenCost: {
        input: loopResult.tokenTracker.inputTokens,
        output: loopResult.tokenTracker.outputTokens,
        calls: loopResult.tokenTracker.calls,
        costUSD: loopResult.tokenTracker.costUSD
      }
    }));

    console.log("BUS_EVENT:" + JSON.stringify({
      event: "test:completed",
      key: KEY,
      mode: "autopilot",
      env: ENV_NAME,
      status: loopResult.finalStatus,
      pass: passCount,
      fail: failCount,
      blocked: loopResult.finalStatus === "BLOCKED" ? 1 : 0,
      total: totalSteps,
      reportPath: report.filename
    }));

    emitProgress("autopilot-done", "Autopilot terminé — " + loopResult.finalStatus, 100);

    console.log("");
    console.log("  ══════════════════════════════════════════════════");
    console.log("  Résultat  : " + loopResult.finalStatus);
    console.log("  Étapes    : " + loopResult.totalSteps + "/" + loopResult.maxSteps);
    console.log("  OK/Erreurs: " + passCount + "/" + failCount);
    console.log("  Tokens    : " + loopResult.tokenTracker.inputTokens + " in + " + loopResult.tokenTracker.outputTokens + " out");
    console.log("  Coût      : $" + loopResult.tokenTracker.costUSD.toFixed(3));
    console.log("  Rapport   : " + report.filename);
    console.log("  ══════════════════════════════════════════════════");

  } catch(e) {
    console.error("  [AUTOPILOT] Erreur fatale : " + e.message);
    console.log("BUS_EVENT:" + JSON.stringify({ event: "test:completed", key: KEY, mode: "autopilot", env: ENV_NAME, status: "FAIL", pass: 0, fail: 1, blocked: 0, total: 1, reportPath: null }));
    process.exit(1);
  } finally {
    if (browser) {
      try { await browser.close(); } catch(e) { /* non bloquant */ }
    }
  }

  process.exit(0);
}

// ── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = { autopilotLoop, buildReport };

if (require.main === module) {
  main();
}
