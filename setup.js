// setup.js - Script de reconfiguration automatique Aby QA V2
// Reecrit tous les agents pour lire les variables depuis .env via config.js
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
console.log("  SETUP ABY QA V2 - Reconfiguration .env");
console.log("==================================================\n");

// ── 1. VERIFIER QUE config.js EXISTE ─────────────────────────────────────────
if (!fs.existsSync(path.join(DIR, "config.js"))) {
  console.error("[ERR] config.js introuvable — telecharge-le depuis Claude");
  process.exit(1);
}
if (!fs.existsSync(path.join(DIR, ".env"))) {
  console.error("[ERR] .env introuvable — telecharge-le depuis Claude et remplis-le");
  process.exit(1);
}
console.log("[OK] config.js et .env trouves\n");

// ── 2. AGENT-CSS-AUDIT.JS ─────────────────────────────────────────────────────
patch("agent-css-audit.js", [
  {
    old: `const SCREENSHOTS_DIR = path.join(__dirname, "css-audit-screenshots");`,
    new: `const SCREENSHOTS_DIR = CFG.paths.screenshots;`
  },
  {
    old: `  sophie: { url: "https://sophie.safran-group.com", name: "sophie" },\n  paulo:  { url: "https://paulo.safran-group.com",  name: "paulo"  },\n  prod:   { url: "https://www.safran-group.com",    name: "prod"   }`,
    new: `  sophie: { url: CFG.envs.sophie, name: "sophie" },\n  paulo:  { url: CFG.envs.paulo,  name: "paulo"  },\n  prod:   { url: CFG.envs.prod,   name: "prod"   }`
  }
]);

// ── 3. AGENT-DRUPAL.JS ────────────────────────────────────────────────────────
patch("agent-drupal.js", [
  {
    old: `const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");\nconst REPORTS_DIR     = path.join(__dirname, "reports");\nconst OLLAMA_MODEL    = "llama3";`,
    new: `const CFG             = require("./config");\nCFG.paths.init();\nconst SCREENSHOTS_DIR = CFG.paths.screenshots;\nconst REPORTS_DIR     = CFG.paths.reports;\nconst OLLAMA_MODEL    = CFG.ollama.model;`
  },
  {
    old: `    url:      "https://sophie.safran-group.com",\n`,
    new: `    url:      CFG.envs.sophie,\n`
  },
  {
    old: `    password: "TON_PASSWORD_SOPHIE"`,
    new: `    password: CFG.drupal.pass`
  },
  {
    old: `    url:      "https://paulo.safran-group.com",\n`,
    new: `    url:      CFG.envs.paulo,\n`
  },
  {
    old: `    password: "TON_PASSWORD_PAULO"`,
    new: `    password: CFG.drupal.pass`
  },
  {
    old: `      hostname: "127.0.0.1", port: 11434,`,
    new: `      hostname: CFG.ollama.host, port: CFG.ollama.port,`
  }
]);

// ── 4. AGENT-DRUPAL-AUDIT.JS ──────────────────────────────────────────────────
patch("agent-drupal-audit.js", [
  {
    old: `const SCREENSHOTS_DIR = path.join(__dirname, "audit-screenshots");\nconst REPORTS_DIR     = path.join(__dirname, "reports");`,
    new: `const CFG             = require("./config");\nCFG.paths.init();\nconst SCREENSHOTS_DIR = CFG.paths.screenshots;\nconst REPORTS_DIR     = CFG.paths.reports;`
  },
  {
    old: `    url:      "https://sophie.safran-group.com",\n`,
    new: `    url:      CFG.envs.sophie,\n`
  },
  {
    old: `    password: "TON_PASSWORD_SOPHIE"`,
    new: `    password: CFG.drupal.pass`
  },
  {
    old: `    url:      "https://paulo.safran-group.com",\n`,
    new: `    url:      CFG.envs.paulo,\n`
  },
  {
    old: `    password: "TON_PASSWORD_PAULO"`,
    new: `    password: CFG.drupal.pass`
  }
]);

// ── 5. AGENT-PLAYWRIGHT.JS ────────────────────────────────────────────────────
patch("agent-playwright.js", [
  {
    old: `const SERVER_PORT     = 3210;\n\nconst JIRA_HOST    = "eurelis.atlassian.net";\nconst JIRA_EMAIL   = "TON_EMAIL@eurelis.com";\nconst JIRA_TOKEN   = "TON_TOKEN_API_ICI";`,
    new: `const SERVER_PORT  = CFG.server.port;\nconst JIRA_HOST    = CFG.jira.host;\nconst JIRA_EMAIL   = CFG.jira.email;\nconst JIRA_TOKEN   = CFG.jira.token;`
  },
  {
    old: `  sophie: { url: "https://sophie.safran-group.com/", login: "TON_LOGIN_SOPHIE", password: "TON_PASSWORD_SOPHIE", auth: true },\n  paulo:  { url: "https://paulo.safran-group.com/",  auth: false },\n  prod:   { url: "https://www.safran-group.com/",    auth: false }`,
    new: `  sophie: { url: CFG.envs.sophie + "/", login: CFG.drupal.user, password: CFG.drupal.pass, auth: true },\n  paulo:  { url: CFG.envs.paulo  + "/", auth: false },\n  prod:   { url: CFG.envs.prod   + "/", auth: false }`
  }
]);

// ── 6. AGENT-REPORTER.JS ──────────────────────────────────────────────────────
patch("agent-reporter.js", [
  {
    old: `const OLLAMA_MODEL  = "llama3";\nconst JIRA_HOST     = "eurelis.atlassian.net";\nconst JIRA_EMAIL    = "TON_EMAIL@eurelis.com";\nconst JIRA_TOKEN    = "TON_TOKEN_API_ICI";`,
    new: `const CFG           = require("./config");\nCFG.paths.init();\nconst OLLAMA_MODEL  = CFG.ollama.model;\nconst JIRA_HOST     = CFG.jira.host;\nconst JIRA_EMAIL    = CFG.jira.email;\nconst JIRA_TOKEN    = CFG.jira.token;`
  },
  {
    old: `const REPORTS_DIR   = path.join(__dirname, "reports");`,
    new: `const REPORTS_DIR   = CFG.paths.reports;`
  },
  {
    old: `      port: 11434,`,
    new: `      port: CFG.ollama.port,`
  }
]);

// ── 7. AGENT-WATCHER.JS ───────────────────────────────────────────────────────
patch("agent-watcher.js", [
  {
    old: `const JIRA_HOST    = "eurelis.atlassian.net";\nconst JIRA_EMAIL   = "TON_EMAIL@eurelis.com";\nconst JIRA_TOKEN   = "TON_TOKEN_API_ICI";`,
    new: `const CFG          = require("./config");\nCFG.paths.init();\nconst JIRA_HOST    = CFG.jira.host;\nconst JIRA_EMAIL   = CFG.jira.email;\nconst JIRA_TOKEN   = CFG.jira.token;`
  }
]);

// ── 8. AGENT-ORCHESTRATEUR.JS ─────────────────────────────────────────────────
patch("agent-orchestrateur.js", [
  {
    old: `const OLLAMA_MODEL = "llama3";`,
    new: `const CFG          = require("./config");\nCFG.paths.init();\nconst OLLAMA_MODEL = CFG.ollama.model;`
  },
  {
    old: `      port: 11434,`,
    new: `      port: CFG.ollama.port,`
  }
]);

// ── 9. AGENT-JIRA-READER.JS ───────────────────────────────────────────────────
patch("agent-jira-reader.js", [
  {
    old: `const OLLAMA_MODEL    = "llama3";`,
    new: `const OLLAMA_MODEL    = CFG.ollama.model;`
  },
  {
    old: `      hostname: "127.0.0.1", port: 11434,`,
    new: `      hostname: CFG.ollama.host, port: CFG.ollama.port,`
  },
  {
    old: `  sophie: CFG.envs.sophie`,
    new: `  sophie: CFG.envs.sophie`  // deja patche
  }
]);

// ── 10. AGENT-XRAY-FULL.JS ────────────────────────────────────────────────────
patch("agent-xray-full.js", [
  {
    old: `const REPORTS_DIR     = path.join(__dirname, "reports");\nconst SCREENSHOTS_DIR = path.join(__dirname, "screenshots");`,
    new: `const REPORTS_DIR     = CFG.paths.reports;\nconst SCREENSHOTS_DIR = CFG.paths.screenshots;`
  }
]);

// ── 11. AGENT-MATRIX.JS ───────────────────────────────────────────────────────
patch("agent-matrix.js", [
  {
    old: `const REPORTS_DIR = path.join(__dirname, "reports");`,
    new: `const REPORTS_DIR = CFG.paths.reports;`
  }
]);

// ── BILAN ─────────────────────────────────────────────────────────────────────
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
