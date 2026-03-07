// agent-inspector.js — Inspecteur DOM Playwright pour AbyQA
// Navigue sur un environnement, capture DOM + screenshot, met en cache 1h
// Usage : node agent-inspector.js --env=sophie --url=/fr [--force=true]
"use strict";

// Forcer le chemin des navigateurs Playwright (Render/cloud Linux uniquement)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

const { chromium } = require("playwright");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const cfg    = require("./config.js");

function arg(name) {
  var flag  = "--" + name + "=";
  var found = process.argv.find(function(a) { return a.startsWith(flag); });
  return found ? found.slice(flag.length) : null;
}

var ENV_NAME = arg("env")   || "sophie";
var URL_PATH = arg("url")   || "/fr";
var FORCE    = arg("force") === "true";

var CACHE_DIR = path.join(__dirname, "inbox", "inspector-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

var SHOTS_DIR = cfg.paths && cfg.paths.screenshots ? cfg.paths.screenshots : path.join(__dirname, "screenshots");
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

function resolveBaseUrl(envName) {
  var envs = cfg.envs || {};
  if (envName === "sophie")        return envs.sophie || process.env.ENV_SOPHIE || "";
  if (envName === "paulo")         return envs.paulo  || process.env.ENV_PAULO  || "";
  if (envName === "prod")          return envs.prod   || process.env.ENV_PROD   || "";
  // drupal-* : retourne seulement le domaine (chemin géré via URL_PATH)
  if (envName === "drupal-sophie") return envs.sophie || process.env.ENV_SOPHIE || "";
  if (envName === "drupal-paulo")  return envs.paulo  || process.env.ENV_PAULO  || "";
  return envs.sophie || "";
}

// Pour drupal-*, le chemin par défaut est la page de login Drupal
if ((ENV_NAME === "drupal-sophie" || ENV_NAME === "drupal-paulo") && URL_PATH === "/fr") {
  URL_PATH = "/user/login";
}

var BASE_URL = resolveBaseUrl(ENV_NAME);
var FULL_URL = URL_PATH.startsWith("http")
  ? URL_PATH
  : BASE_URL + (URL_PATH.startsWith("/") ? URL_PATH : "/" + URL_PATH);

var cacheKey  = crypto.createHash("md5").update(ENV_NAME + "|" + FULL_URL).digest("hex");
var CACHE_FILE = path.join(CACHE_DIR, cacheKey + ".json");

async function inspect() {
  // Cache valide 1h
  if (!FORCE && fs.existsSync(CACHE_FILE)) {
    try {
      var cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Date.now() - (cached.cachedAt || 0) < 3600000) {
        console.log("[inspector] Cache valide → " + FULL_URL);
        console.log("INSPECTOR_RESULT:" + JSON.stringify(cached));
        return;
      }
    } catch(e) {}
  }

  console.log("[inspector] Navigation → " + FULL_URL);

  var ctxOpts = {
    viewport:  { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" }
  };

  // HTTP Basic Auth pour envs staging (sophie / paulo / drupal-*)
  // Utilise cfg.httpAuth.sophie/paulo (SOPHIE_HTTP_USER/PASS dans .env)
  var baseEnvName = ENV_NAME.replace("drupal-", "");
  if (baseEnvName === "sophie" || baseEnvName === "paulo") {
    var httpAuthCfg = (cfg.httpAuth && cfg.httpAuth[baseEnvName]) || {};
    var httpUser = httpAuthCfg.user || process.env[baseEnvName.toUpperCase() + "_HTTP_USER"] || (cfg.drupal && cfg.drupal.user) || "";
    var httpPass = httpAuthCfg.pass || process.env[baseEnvName.toUpperCase() + "_HTTP_PASS"] || (cfg.drupal && cfg.drupal.pass) || "";
    if (httpUser) ctxOpts.httpCredentials = { username: httpUser, password: httpPass };
  }

  var browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox"]
  });
  var ctx     = await browser.newContext(ctxOpts);

  // Charger session auth si disponible (cookies Cloudflare + Drupal)
  // Cherche d'abord auth/[env].json (format storageState), puis [env].json à la racine
  var sessionFile = path.join(__dirname, "auth", baseEnvName + ".json");
  if (!fs.existsSync(sessionFile)) sessionFile = path.join(__dirname, baseEnvName + ".json");
  if (fs.existsSync(sessionFile)) {
    try {
      var sess = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      if (sess.cookies && sess.cookies.length) await ctx.addCookies(sess.cookies);
    } catch(e) {}
  }

  var page = await ctx.newPage();
  page.setDefaultTimeout(25000);

  var navOk = true;
  try {
    await page.goto(FULL_URL, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1500);
  } catch(e) {
    console.log("[inspector] ⚠️ Navigation partielle : " + e.message);
    navOk = false;
  }

  var title = await page.title().catch(function() { return ""; });

  // Screenshot
  var shotName = "inspect-" + ENV_NAME + "-" + cacheKey.slice(0, 8) + ".png";
  var shotPath = path.join(SHOTS_DIR, shotName);
  await page.screenshot({ path: shotPath, fullPage: false }).catch(function() { shotName = null; });

  // Extraction DOM
  var snapshot = await page.evaluate(function() {
    var out = { forms: [], inputs: [], buttons: [], links: [], headings: [], meta: {} };

    // Meta
    var descMeta = document.querySelector("meta[name=description]");
    out.meta.description = descMeta ? descMeta.getAttribute("content") : "";
    out.meta.lang = document.documentElement.lang || "";

    // Formulaires
    document.querySelectorAll("form").forEach(function(f, i) {
      out.forms.push({
        id:       f.id || null,
        action:   f.getAttribute("action") || "",
        method:   f.method || "get",
        selector: f.id ? "#" + f.id : "form:nth-of-type(" + (i + 1) + ")"
      });
    });

    // Inputs / textarea / select
    document.querySelectorAll("input:not([type=hidden]):not([type=submit]), textarea, select").forEach(function(el) {
      var type = el.tagName === "INPUT" ? (el.type || "text") : el.tagName.toLowerCase();
      var label = "";
      if (el.id) {
        var lbl = document.querySelector("label[for='" + el.id + "']");
        if (lbl) label = lbl.textContent.trim();
      }
      if (!label && el.placeholder) label = el.placeholder;
      if (!label && el.name)        label = el.name;
      if (!label && el["aria-label"]) label = el["aria-label"];
      var sel = el.id ? "#" + el.id : (el.name ? "[name='" + el.name + "']" : el.tagName.toLowerCase());
      out.inputs.push({ type: type, selector: sel, label: label.slice(0, 60), name: el.name || null });
    });

    // Boutons
    var btnSet = new Set();
    document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]").forEach(function(el) {
      var txt = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (!txt || btnSet.has(txt)) return;
      btnSet.add(txt);
      var sel = el.id ? "#" + el.id : (el.getAttribute("name") ? "[name='" + el.getAttribute("name") + "']" : el.tagName.toLowerCase() + (el.type ? "[type=" + el.type + "]" : ""));
      out.buttons.push({ text: txt, selector: sel });
    });

    // Liens principaux (max 25)
    var linkSet = new Set();
    document.querySelectorAll("a[href]").forEach(function(a) {
      if (linkSet.size >= 25) return;
      var href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript") || href.startsWith("mailto")) return;
      var txt = a.textContent.trim().replace(/\s+/g, " ").slice(0, 60);
      if (!txt || linkSet.has(href)) return;
      linkSet.add(href);
      out.links.push({ text: txt, href: href });
    });

    // Titres H1/H2/H3
    document.querySelectorAll("h1, h2, h3").forEach(function(h) {
      var txt = h.textContent.trim().replace(/\s+/g, " ").slice(0, 80);
      if (txt) out.headings.push({ level: h.tagName, text: txt });
    });

    return out;
  }).catch(function() {
    return { forms: [], inputs: [], buttons: [], links: [], headings: [], meta: {} };
  });

  await browser.close();

  var result = {
    ok:         true,
    cached:     false,
    env:        ENV_NAME,
    url:        FULL_URL,
    title:      title,
    navOk:      navOk,
    snapshot:   snapshot,
    screenshot: shotName,
    cachedAt:   Date.now()
  };

  // Sauvegarder cache
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2)); } catch(e) {}

  var s = snapshot;
  console.log("[inspector] ✅ " + title);
  console.log("[inspector] " + s.inputs.length + " inputs · " + s.buttons.length + " boutons · " + s.links.length + " liens · " + s.headings.length + " titres");
  console.log("INSPECTOR_RESULT:" + JSON.stringify(result));
}

inspect().catch(function(e) {
  console.error("[inspector] ERREUR : " + e.message);
  console.log("INSPECTOR_RESULT:" + JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
