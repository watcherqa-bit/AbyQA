// agent-router.js - LLM Router autonome — ABY QA V2
// Appelle Ollama local pour décider quel agent exécuter.
// Fallback rule-based automatique si Ollama indisponible ou réponse invalide.
// NE PAS MODIFIER les agents existants — ce fichier est autonome.

"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const OLLAMA_HOST    = "127.0.0.1";
const OLLAMA_PORT    = 11434;
const OLLAMA_MODEL   = "mistral"; // ou llama3, gemma — dépend de ce qui est installé
const OLLAMA_TIMEOUT = 10000;     // 10s max

const AVAILABLE_AGENTS = ["playwright", "css-audit", "jira-reader", "xray-full", "matrix"];

const ROUTER_LOG = path.join(__dirname, "reports", "router-log.jsonl");

// ── LOGGING ───────────────────────────────────────────────────────────────────
function logDecision(inputHash, decision, selectedAgents, risk, errors) {
  var entry = {
    timestamp:      new Date().toISOString(),
    inputHash:      inputHash,
    decision:       decision,
    selectedAgents: selectedAgents,
    risk:           risk,
    errors:         errors || []
  };
  try {
    fs.mkdirSync(path.dirname(ROUTER_LOG), { recursive: true });
    fs.appendFileSync(ROUTER_LOG, JSON.stringify(entry) + "\n", "utf8");
  } catch(e) {
    console.error("[ROUTER] Erreur log :", e.message);
  }
}

// ── HASH INPUT ────────────────────────────────────────────────────────────────
function hashInput(demand, context, env) {
  return crypto.createHash("md5").update(demand + "|" + context + "|" + env).digest("hex").substring(0, 8);
}

// ── VALIDATION SORTIE LLM ─────────────────────────────────────────────────────
function validateLLMOutput(raw) {
  var errors = [];

  // Nettoyer les blocs markdown si présents
  var cleaned = raw.replace(/```json|```/g, "").trim();
  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch(e) {
    errors.push("JSON invalide : " + e.message);
    return { valid: false, errors: errors };
  }

  // Valider les champs obligatoires
  var validDecisions = ["AUTO", "MANUEL", "MIXTE"];
  var validRisks     = ["LOW", "MEDIUM", "HIGH"];
  var validCoverage  = ["smoke", "regression", "api", "ui", "accessibility", "performance"];

  if (!validDecisions.includes(parsed.decision))  errors.push("decision invalide : " + parsed.decision);
  if (!validRisks.includes(parsed.risk))           errors.push("risk invalide : " + parsed.risk);
  if (!Array.isArray(parsed.selectedAgents))       errors.push("selectedAgents doit être un tableau");
  if (!Array.isArray(parsed.coverage))             errors.push("coverage doit être un tableau");
  if (!Array.isArray(parsed.reason))               errors.push("reason doit être un tableau");
  if (!Array.isArray(parsed.warnings))             errors.push("warnings doit être un tableau");

  if (errors.length > 0) return { valid: false, errors: errors };

  // Filtrer les agents non disponibles
  var invalidAgents = parsed.selectedAgents.filter(function(a) {
    return !AVAILABLE_AGENTS.includes(a);
  });
  if (invalidAgents.length > 0) {
    errors.push("Agents inconnus filtrés : " + invalidAgents.join(", "));
    parsed.selectedAgents = parsed.selectedAgents.filter(function(a) {
      return AVAILABLE_AGENTS.includes(a);
    });
    parsed.warnings = (parsed.warnings || []).concat(["Agents ignorés (non disponibles) : " + invalidAgents.join(", ")]);
  }

  // Si aucun agent valide → fallback MANUAL
  if (parsed.selectedAgents.length === 0) {
    errors.push("Aucun agent valide → fallback MANUAL");
    return { valid: false, errors: errors };
  }

  return { valid: true, data: parsed, errors: errors };
}

// ── FALLBACK RULE-BASED ───────────────────────────────────────────────────────
function ruleBasedFallback(demand, context, env) {
  var d    = (demand + " " + context).toLowerCase();
  var agents   = [];
  var coverage = [];
  var risk     = "LOW";
  var warnings = ["LLM indisponible — décision par règles métier"];

  // Règles de sélection d'agents
  if (/ui|responsive|mobile|affichage|visuel|css|police|barlow|layout|maquette/.test(d)) {
    agents.push("css-audit");
    coverage.push("ui");
  }
  if (/api|rest|endpoint|requête|json|xml|service|back/.test(d)) {
    agents.push("playwright");
    coverage.push("api");
  }
  if (/login|auth|connexion|mot de passe|password|sso|accès/.test(d)) {
    if (!agents.includes("playwright")) agents.push("playwright");
    agents.push("xray-full");
    coverage.push("smoke");
    risk = "MEDIUM";
  }
  if (/regression|régressio|sprint|release|recette|ensemble/.test(d)) {
    if (!agents.includes("playwright")) agents.push("playwright");
    if (!agents.includes("xray-full"))  agents.push("xray-full");
    agents.push("matrix");
    coverage.push("regression");
    risk = "MEDIUM";
  }
  if (/critique|bloquant|urgent|prod|production|client|sévérité/.test(d)) {
    if (!agents.includes("xray-full")) agents.push("xray-full");
    risk = "HIGH";
  }
  if (/ticket|jira|us|user story|read|lecture|analyse/.test(d)) {
    if (!agents.includes("jira-reader")) agents.push("jira-reader");
    coverage.push("smoke");
  }

  // Défaut si aucune règle ne matche
  if (agents.length === 0) {
    agents   = [];
    coverage = [];
    warnings.push("Aucune règle matchée — décision MANUAL requise");
    return {
      decision:       "MANUEL",
      risk:           "LOW",
      selectedAgents: [],
      coverage:       [],
      reason:         ["Aucune règle ne correspond à la demande"],
      warnings:       warnings
    };
  }

  // Dédupliquer
  agents   = agents.filter(function(v, i, a) { return a.indexOf(v) === i; });
  coverage = coverage.filter(function(v, i, a) { return a.indexOf(v) === i; });

  return {
    decision:       agents.length > 1 ? "MIXTE" : "AUTO",
    risk:           risk,
    selectedAgents: agents,
    coverage:       coverage,
    reason:         ["Décision par règles métier (LLM indisponible)"],
    warnings:       warnings
  };
}

// ── APPEL OLLAMA ──────────────────────────────────────────────────────────────
function callOllama(demand, context, env) {
  return new Promise(function(resolve, reject) {
    var prompt = [
      "Tu es un Lead QA IA pour une équipe Safran utilisant Jira Cloud et Xray Cloud.",
      "Agents disponibles : " + AVAILABLE_AGENTS.join(", "),
      "",
      "Demande : " + demand,
      "Contexte : " + context,
      "Environnement cible : " + env,
      "",
      "Réponds UNIQUEMENT avec un JSON valide, sans texte avant ou après, sans balises markdown :",
      "{",
      '  "decision": "AUTO|MANUEL|MIXTE",',
      '  "risk": "LOW|MEDIUM|HIGH",',
      '  "selectedAgents": ["agent1", "agent2"],',
      '  "coverage": ["smoke", "regression", "api", "ui"],',
      '  "reason": ["raison 1", "raison 2"],',
      '  "warnings": ["avertissement éventuel"]',
      "}"
    ].join("\n");

    var body = JSON.stringify({
      model:  OLLAMA_MODEL,
      prompt: prompt,
      stream: false
    });

    var options = {
      hostname: OLLAMA_HOST,
      port:     OLLAMA_PORT,
      path:     "/api/generate",
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    var timer = setTimeout(function() {
      req.destroy();
      reject(new Error("Timeout Ollama (" + OLLAMA_TIMEOUT + "ms)"));
    }, OLLAMA_TIMEOUT);

    var req = http.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        clearTimeout(timer);
        try {
          var parsed = JSON.parse(data);
          resolve(parsed.response || "");
        } catch(e) {
          reject(new Error("Réponse Ollama invalide : " + e.message));
        }
      });
    });

    req.on("error", function(e) {
      clearTimeout(timer);
      reject(new Error("Ollama inaccessible : " + e.message));
    });

    req.write(body);
    req.end();
  });
}

// ── ROUTER PRINCIPAL ──────────────────────────────────────────────────────────
async function route(demand, context, env, mode) {
  var inputHash = hashInput(demand, context, env);
  var errors    = [];
  var result    = null;
  var source    = "llm";

  // Mode MANUAL → pas de routing
  if (mode === "MANUAL") {
    result = {
      decision:       "MANUEL",
      risk:           "LOW",
      selectedAgents: [],
      coverage:       [],
      reason:         ["Mode MANUAL — l'utilisateur choisit les agents"],
      warnings:       []
    };
    logDecision(inputHash, "MANUEL", [], "LOW", []);
    return result;
  }

  // Tentative LLM
  try {
    var llmRaw    = await callOllama(demand, context, env);
    var validated = validateLLMOutput(llmRaw);
    if (validated.valid) {
      result = validated.data;
      errors = validated.errors; // warnings de validation non-bloquants
    } else {
      errors = validated.errors;
      throw new Error("Validation LLM échouée : " + errors.join(", "));
    }
  } catch(e) {
    errors.push("LLM KO : " + e.message);
    console.log("[ROUTER] Fallback rule-based (" + e.message.substring(0, 60) + ")");
    result = ruleBasedFallback(demand, context, env);
    source = "fallback";
  }

  // Si mode ASSISTED → décision toujours MIXTE ou MANUEL (humain valide)
  if (mode === "ASSISTED") {
    result.warnings = (result.warnings || []).concat(["Mode ASSISTED — validation humaine requise avant exécution"]);
  }

  result._source    = source;
  result._inputHash = inputHash;
  result._mode      = mode;

  logDecision(inputHash, result.decision, result.selectedAgents, result.risk, errors);
  return result;
}

module.exports = {
  route:          route,
  AVAILABLE_AGENTS: AVAILABLE_AGENTS,
  ruleBasedFallback: ruleBasedFallback
};
