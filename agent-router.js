// agent-router.js — Router rule-based pour agents QA
// Decide quel(s) agent(s) lancer selon la demande utilisateur.
"use strict";

const AVAILABLE_AGENTS = ["playwright", "css-audit", "jira-reader", "xray-full", "matrix"];

// ── ROUTING PAR REGLES ──────────────────────────────────────────────────────
function ruleBasedRoute(demand, context, env) {
  var d    = (demand + " " + (context || "")).toLowerCase();
  var agents   = [];
  var coverage = [];
  var risk     = "LOW";
  var warnings = [];

  if (/ui|responsive|mobile|affichage|visuel|css|police|barlow|layout|maquette/.test(d)) {
    agents.push("css-audit");
    coverage.push("ui");
  }
  if (/api|rest|endpoint|json|xml|service|back/.test(d)) {
    agents.push("playwright");
    coverage.push("api");
  }
  if (/login|auth|connexion|mot de passe|password|sso/.test(d)) {
    if (!agents.includes("playwright")) agents.push("playwright");
    agents.push("xray-full");
    coverage.push("smoke");
    risk = "MEDIUM";
  }
  if (/regression|sprint|release|recette|ensemble/.test(d)) {
    if (!agents.includes("playwright")) agents.push("playwright");
    if (!agents.includes("xray-full"))  agents.push("xray-full");
    agents.push("matrix");
    coverage.push("regression");
    risk = "MEDIUM";
  }
  if (/critique|bloquant|urgent|prod|production/.test(d)) {
    if (!agents.includes("xray-full")) agents.push("xray-full");
    risk = "HIGH";
  }
  if (/ticket|jira|us|user story|lecture|analyse/.test(d)) {
    if (!agents.includes("jira-reader")) agents.push("jira-reader");
    coverage.push("smoke");
  }

  if (agents.length === 0) {
    return {
      decision: "MANUEL", risk: "LOW",
      selectedAgents: [], coverage: [],
      reason: ["Aucune regle ne correspond"],
      warnings: ["Decision manuelle requise"]
    };
  }

  agents   = agents.filter(function(v, i, a) { return a.indexOf(v) === i; });
  coverage = coverage.filter(function(v, i, a) { return a.indexOf(v) === i; });

  return {
    decision:       agents.length > 1 ? "MIXTE" : "AUTO",
    risk:           risk,
    selectedAgents: agents,
    coverage:       coverage,
    reason:         ["Decision par regles metier"],
    warnings:       warnings
  };
}

async function route(demand, context, env, mode) {
  if (mode === "MANUAL") {
    return {
      decision: "MANUEL", risk: "LOW",
      selectedAgents: [], coverage: [],
      reason: ["Mode MANUAL"], warnings: []
    };
  }

  var result = ruleBasedRoute(demand, context || "", env || "sophie");

  if (mode === "ASSISTED") {
    result.warnings = (result.warnings || []).concat(["Mode ASSISTED — validation humaine requise"]);
  }

  return result;
}

module.exports = {
  route: route,
  AVAILABLE_AGENTS: AVAILABLE_AGENTS,
  ruleBasedFallback: ruleBasedRoute
};
