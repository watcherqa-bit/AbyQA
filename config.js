// config.js - Module de configuration central
// Lit le fichier .env et expose toutes les variables
// Usage : const CFG = require("./config");

"use strict";

const fs   = require("fs");
const path = require("path");

// ── PARSER .env ───────────────────────────────────────────────────────────────
function loadEnv() {
  var envPath = path.join(__dirname, ".env");

  // Sur Render/cloud : pas de .env, les vars sont dans process.env directement
  if (!fs.existsSync(envPath)) {
    console.log("[CONFIG] Pas de fichier .env — lecture depuis process.env (mode cloud)");
    return process.env;
  }

  var lines = fs.readFileSync(envPath, "utf8").split("\n");
  var env   = {};

  lines.forEach(function(line) {
    line = line.trim();
    if (!line || line.startsWith("#")) return;
    var idx = line.indexOf("=");
    if (idx === -1) return;
    var key = line.substring(0, idx).trim();
    var val = line.substring(idx + 1).trim();
    env[key] = val;
  });

  return env;
}

var E = loadEnv();

// ── HELPER : valeur obligatoire ───────────────────────────────────────────────
function required(key) {
  var val = E[key];
  if (!val || val === "TON_TOKEN_API_ICI" || val === "TON_LOGIN_DRUPAL" || val === "TON_MOT_DE_PASSE_DRUPAL") {
    console.error("[CONFIG] Variable non configuree : " + key);
    console.error("[CONFIG] Edite le fichier .env et renseigne " + key);
    process.exit(1);
  }
  return val;
}

function get(key, fallback) {
  return E[key] || fallback || "";
}

// ── EXPORT CONFIG ─────────────────────────────────────────────────────────────
module.exports = {

  // Jira
  jira: {
    host:    get("JIRA_HOST",    "eurelis.atlassian.net"),
    email:   get("JIRA_EMAIL",   ""),
    token:   get("JIRA_TOKEN",   ""),
    project: get("JIRA_PROJECT", "SAFWBST"),
    // Retourne les headers d'auth pour les requetes HTTPS
    authHeader: function() {
      return "Basic " + Buffer.from(get("JIRA_EMAIL") + ":" + get("JIRA_TOKEN")).toString("base64");
    }
  },

  // Drupal BO
  drupal: {
    user: get("DRUPAL_USER", ""),
    pass: get("DRUPAL_PASS", "")
  },

  // HTTP Basic auth par environnement de staging
  // Variables .env : SOPHIE_HTTP_USER / SOPHIE_HTTP_PASS / PAULO_HTTP_USER / PAULO_HTTP_PASS
  httpAuth: {
    sophie: {
      user: get("SOPHIE_HTTP_USER", get("DRUPAL_USER", "")),
      pass: get("SOPHIE_HTTP_PASS", get("DRUPAL_PASS", ""))
    },
    paulo: {
      user: get("PAULO_HTTP_USER",  get("DRUPAL_USER", "")),
      pass: get("PAULO_HTTP_PASS",  get("DRUPAL_PASS", ""))
    }
    // prod n'a pas d'HTTP Basic (IP restriction ou accès ouvert)
  },

  // Environnements
  envs: {
    sophie: get("ENV_SOPHIE", "https://sophie.safran-group.com"),
    paulo:  get("ENV_PAULO",  "https://paulo.safran-group.com"),
    prod:   get("ENV_PROD",   "https://www.safran-group.com"),
    // Retourne l'URL d'un env par son nom
    get: function(name) {
      return module.exports.envs[name] || module.exports.envs.sophie;
    },
    // Adapte une URL vers un autre env
    adapt: function(url, targetEnv) {
      var target = module.exports.envs.get(targetEnv);
      if (!url) return target;
      return url.replace(/https?:\/\/[a-z]+\.safran-group\.com/, target)
                .replace(/https?:\/\/www\.safran-group\.com/,    target);
    }
  },

  // Serveur
  server: {
    port: parseInt(process.env.PORT || get("SERVER_PORT", "3210"))
  },

  // Anthropic Claude API
  anthropic: {
    apiKey: get("ANTHROPIC_API_KEY", "")
  },

  // Ollama (fallback local)
  ollama: {
    host:  get("OLLAMA_HOST",  "127.0.0.1"),
    port:  parseInt(get("OLLAMA_PORT", "11434")),
    model: get("OLLAMA_MODEL", "llama3")
  },

  // Xray
  xray: {
    fixVersion: get("XRAY_FIX_VERSION", "v1.25.0")
  },

  // Chemins
  paths: {
    reports:     path.join(__dirname, get("REPORTS_DIR",     "reports")),
    screenshots: path.join(__dirname, get("SCREENSHOTS_DIR", "screenshots")),
    uploads:     path.join(__dirname, get("UPLOADS_DIR",     "uploads")),
    assets:      path.join(__dirname, get("ASSETS_DIR",      "assets")),
    // Cree les dossiers si absents
    init: function() {
      var dirs = [
        module.exports.paths.reports,
        module.exports.paths.screenshots,
        module.exports.paths.uploads,
        module.exports.paths.assets
      ];
      dirs.forEach(function(d) {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      });
    }
  },

  // Validation : verifie que les variables critiques sont renseignees
  validate: function(keys) {
    keys.forEach(function(k) { required(k); });
  }
};
