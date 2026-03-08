// setup.js - Script de reconfiguration automatique
// Reecrit les agents pour lire les variables depuis .env via config.js
// Usage : node setup.js

"use strict";
const fs   = require("fs");
const path = require("path");

const DIR = __dirname;
var ok = 0, skip = 0, errors = [];

function patch(filename, replacements) {
  var fpath = path.join(DIR, filename);
  if (!fs.existsSync(fpath)) {
    errors.push("INTROUVABLE : " + filename);
    return;
  }
  var content = fs.readFileSync(fpath, "utf8");
  var changed = false;
  replacements.forEach(function(r) {
    if (content.includes(r.old)) {
      content = content.split(r.old).join(r.new);
      changed = true;
    }
  });
  if (changed) {
    fs.writeFileSync(fpath, content, "utf8");
    console.log("  [OK] " + filename);
    ok++;
  } else {
    console.log("  [--] " + filename + " (deja a jour)");
    skip++;
  }
}

console.log("==================================================");
console.log("  SETUP - Reconfiguration .env");
console.log("==================================================\n");

if (!fs.existsSync(path.join(DIR, "config.js"))) {
  console.error("[ERR] config.js introuvable");
  process.exit(1);
}
if (!fs.existsSync(path.join(DIR, ".env"))) {
  console.error("[ERR] .env introuvable — cree-le et remplis les variables");
  process.exit(1);
}
console.log("[OK] config.js et .env trouves\n");

// ── AGENT-CSS-AUDIT.JS ─────────────────────────────────────────────────────
patch("agent-css-audit.js", [
  {
    old: `const SCREENSHOTS_DIR = path.join(__dirname, "css-audit-screenshots");`,
    new: `const SCREENSHOTS_DIR = CFG.paths.screenshots;`
  }
]);

// ── AGENT-DRUPAL.JS ────────────────────────────────────────────────────────
patch("agent-drupal.js", [
  {
    old: `const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");\nconst REPORTS_DIR     = path.join(__dirname, "reports");`,
    new: `const CFG             = require("./config");\nCFG.paths.init();\nconst SCREENSHOTS_DIR = CFG.paths.screenshots;\nconst REPORTS_DIR     = CFG.paths.reports;`
  }
]);

// ── AGENT-DRUPAL-AUDIT.JS ──────────────────────────────────────────────────
patch("agent-drupal-audit.js", [
  {
    old: `const SCREENSHOTS_DIR = path.join(__dirname, "audit-screenshots");\nconst REPORTS_DIR     = path.join(__dirname, "reports");`,
    new: `const CFG             = require("./config");\nCFG.paths.init();\nconst SCREENSHOTS_DIR = CFG.paths.screenshots;\nconst REPORTS_DIR     = CFG.paths.reports;`
  }
]);

// ── AGENT-JIRA-READER.JS ───────────────────────────────────────────────────
patch("agent-jira-reader.js", [
  {
    old: `const OLLAMA_MODEL    = "llama3";`,
    new: `const OLLAMA_MODEL    = CFG.ollama.model;`
  }
]);

// ── AGENT-XRAY-FULL.JS ────────────────────────────────────────────────────
patch("agent-xray-full.js", [
  {
    old: `const REPORTS_DIR     = path.join(__dirname, "reports");\nconst SCREENSHOTS_DIR = path.join(__dirname, "screenshots");`,
    new: `const REPORTS_DIR     = CFG.paths.reports;\nconst SCREENSHOTS_DIR = CFG.paths.screenshots;`
  }
]);

// ── AGENT-MATRIX.JS ────────────────────────────────────────────────────────
patch("agent-matrix.js", [
  {
    old: `const REPORTS_DIR = path.join(__dirname, "reports");`,
    new: `const REPORTS_DIR = CFG.paths.reports;`
  }
]);

// ── BILAN ────────────────────────────────────────────────────────────────────
console.log("\n==================================================");
console.log("  BILAN");
console.log("==================================================");
console.log("  Fichiers mis a jour : " + ok);
console.log("  Deja a jour         : " + skip);
if (errors.length > 0) {
  console.log("  Erreurs             : " + errors.length);
  errors.forEach(function(e) { console.log("    - " + e); });
}
console.log("\n  PROCHAINE ETAPE :");
console.log("  1. Ouvre .env et remplis JIRA_TOKEN, DRUPAL_USER, DRUPAL_PASS");
console.log("  2. Lance : node agent-server.js");
console.log("==================================================\n");
