// agent-playwright-direct.js — Tests Playwright Direct
// Modes : ui | api | fix | tnr
// Sources : url | jira-key | xml | text
"use strict";

// Forcer le chemin des navigateurs Playwright (Render/cloud Linux uniquement)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

const fs     = require("fs");
const path   = require("path");
const https  = require("https");
const { chromium, firefox, webkit } = require("playwright");
const CFG    = require("./config");
CFG.paths.init();

const REPORTS_DIR     = CFG.paths.reports;
const SCREENSHOTS_DIR = CFG.paths.screenshots;
const BASE_DIR        = __dirname;

var args = process.argv.slice(2);
function arg(name) {
  var a = args.find(function(a) { return a.startsWith("--" + name + "="); });
  return a ? a.split("=").slice(1).join("=") : null;
}
function flag(name) { return args.includes("--" + name); }

var MODE     = arg("mode")    || "ui";
var SOURCE   = arg("source")  || "url";
var ENV_NAME = arg("env")     || "sophie";
var DRY_RUN  = flag("dry-run");

// Multi-env support (--envs=sophie,prod)
var ENV_NAMES_RAW = arg("envs");
var ENV_NAMES     = ENV_NAMES_RAW ? ENV_NAMES_RAW.split(",") : [ENV_NAME];
var IS_MULTI_ENV  = ENV_NAMES.length > 1;
var KEY      = arg("key")     || null;
var XML_FILE = arg("xml")     || null;
var TEXT     = arg("text")    || null;
var URLS_RAW = arg("urls")    || null;

// Support --urls-file= (fichier temporaire, évite les problèmes shell Windows avec &quot;)
var URLS_FILE_ARG = args.find(function(a) { return a.startsWith("--urls-file="); });
if (URLS_FILE_ARG) {
  var tmpFile = URLS_FILE_ARG.replace("--urls-file=", "").trim();
  try {
    URLS_RAW = fs.readFileSync(tmpFile, "utf8").trim();
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  } catch(e) { console.log("[WARN] Erreur lecture --urls-file : " + e.message); }
}
// Décoder les entités HTML résiduelles — gère &quot; ET &quot (sans ; final)
if (URLS_RAW) {
  URLS_RAW = URLS_RAW
    .replace(/&[a-z0-9]+;?/gi, function(e) {
      var map = { "&amp;":"&","&lt;":"","&gt;":"","&quot;":"","&#39;":"","&apos;":"" };
      var key = e.replace(/;$/, "").toLowerCase() + ";";
      return map[key] !== undefined ? map[key] : "";
    })
    .replace(/['"[\]<>]/g, "")
    .replace(/&/g, "")
    .trim();
}

var STEPS = [];
try { STEPS = arg("steps") ? JSON.parse(arg("steps")) : []; } catch(e) { STEPS = []; }

var DEVICES = [];
try { DEVICES = arg("devices") ? JSON.parse(arg("devices")) : [{ name:"desktop-hd", w:1920, h:1080 }]; }
catch(e) { DEVICES = [{ name:"desktop-hd", w:1920, h:1080 }]; }

var BROWSERS = [];
try { BROWSERS = arg("browsers") ? JSON.parse(arg("browsers")) : ["chromium"]; }
catch(e) { BROWSERS = ["chromium"]; }

var BROWSER_MAP = { chromium: chromium, firefox: firefox, webkit: webkit, edge: chromium };
var ENV_URL = CFG.envs[ENV_NAME] || CFG.envs.sophie;

function jiraRequest(method, apiPath, body) {
  return new Promise(function(resolve, reject) {
    var auth    = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var payload = body ? JSON.stringify(body) : null;
    var options = {
      hostname: CFG.jira.host, path: apiPath, method: method,
      headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json", "Accept": "application/json" }
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { try { resolve(JSON.parse(data || "{}")); } catch(e) { resolve({}); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function uploadAttachment(issueKey, filePath) {
  return new Promise(function(resolve) {
    if (!fs.existsSync(filePath)) { resolve(null); return; }
    var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var fileData = fs.readFileSync(filePath);
    var fileName = path.basename(filePath);
    var boundary = "----AbyQABoundary" + Date.now();
    var header = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: image/png\r\n\r\n";
    var footer = "\r\n--" + boundary + "--\r\n";
    var bodyBuf = Buffer.concat([Buffer.from(header), fileData, Buffer.from(footer)]);
    var options = {
      hostname: CFG.jira.host, path: "/rest/api/2/issue/" + issueKey + "/attachments", method: "POST",
      headers: { "Authorization": "Basic " + auth, "X-Atlassian-Token": "no-check", "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": bodyBuf.length }
    };
    var req = https.request(options, function(res) { var d=""; res.on("data",function(c){d+=c;}); res.on("end",function(){resolve(d);}); });
    req.on("error", function() { resolve(null); });
    req.write(bodyBuf); req.end();
  });
}

async function getUrlsFromJiraKey(key) {
  console.log("[->] Lecture du ticket " + key + " dans Jira...");
  var issue = await jiraRequest("GET", "/rest/api/2/issue/" + key + "?fields=summary,description,comment");
  if (!issue.key) { return [{ url: ENV_URL + "/fr", label: "Accueil", context: "ticket " + key }]; }
  var desc = (issue.fields.description || "") + " " +
    ((issue.fields.comment && issue.fields.comment.comments) ? issue.fields.comment.comments.map(function(c){return c.body||"";}).join(" ") : "");
  var urlMatches = desc.match(/https?:\/\/[^\s<"'\]]+/g) || [];
  var seen = {};
  var urls = urlMatches.filter(function(u) {
    return !u.includes("atlassian.net") && !u.includes("avatar") && !seen[u] && (seen[u]=true);
  }).map(function(u) { return { url: u, label: u.split("/").slice(3).join("/") || "page", context: "ticket " + key }; });
  if (urls.length === 0) urls = [{ url: ENV_URL + "/fr", label: "Accueil (fallback)", context: "ticket " + key }];
  console.log("  [OK] " + urls.length + " URL(s) extraite(s) de " + key);
  return urls;
}

function getUrlsFromXML(xmlContent) {
  var urlMatches = xmlContent.match(/href="(https?:\/\/[^"]+)"/g) || [];
  var seen = {};
  var urls = [];
  urlMatches.forEach(function(u) {
    var url = u.replace(/href="/,"").replace(/"$/,"");
    if (!url.includes("atlassian.net") && !url.includes("avatar") && !seen[url]) {
      seen[url] = true;
      urls.push({ url: url, label: url.split("/").slice(3).join("/") || "page", context: "xml" });
    }
  });
  return urls.length > 0 ? urls : [{ url: ENV_URL + "/fr", label: "Accueil", context: "xml" }];
}

async function resolveTargets() {
  if (SOURCE === "url" && URLS_RAW) {
    var seenUrls = {};
    var splitUrls = URLS_RAW
      .split(",")
      .map(function(u) { return u.trim(); })
      .filter(Boolean)
      .reduce(function(acc, chunk) {
        // Gérer les URLs complètes collées (https://a.comhttps://b.com)
        var parts = chunk.split(/(?=https?:\/\/)/);
        return acc.concat(parts.map(function(p) { return p.trim(); }).filter(Boolean));
      }, []);
    return splitUrls.filter(function(url) {
      return url && !seenUrls[url] && (seenUrls[url] = true);
    }).map(function(url) {
      return { url: url, label: url.split("/").slice(3).join("/") || url, context: "url directe" };
    });
  }
  if (SOURCE === "jira-key" && KEY) return await getUrlsFromJiraKey(KEY);
  if (SOURCE === "xml" && XML_FILE) {
    var xmlPath = path.isAbsolute(XML_FILE) ? XML_FILE : path.join(BASE_DIR, XML_FILE);
    if (fs.existsSync(xmlPath)) return getUrlsFromXML(fs.readFileSync(xmlPath, "utf8"));
  }
  if (SOURCE === "text" && TEXT) {
    var urlsInText = (TEXT.match(/https?:\/\/[^\s]+/g) || []).map(function(u) {
      return { url: u, label: u.split("/").slice(3).join("/") || "page", context: "texte libre" };
    });
    if (urlsInText.length > 0) return urlsInText;
    var pages = [];
    if (/login|connexion|auth/i.test(TEXT)) pages.push("fr/login");
    if (/news|actualit/i.test(TEXT)) pages.push("fr/news");
    if (/contact/i.test(TEXT)) pages.push("fr/contact");
    if (pages.length === 0) pages.push("fr");
    return pages.map(function(p) { return { url: ENV_URL + "/" + p, label: p, context: "texte libre" }; });
  }
  return [{ url: ENV_URL + "/fr", label: "Accueil", context: "fallback" }];
}

function getTNRPages() {
  return [
    { path: "fr",                                          label: "accueil" },
    { path: "fr/groupe/presentation",                     label: "groupe-presentation" },
    { path: "fr/groupe/strategie",                        label: "groupe-strategie" },
    { path: "fr/groupe/innovation",                       label: "groupe-innovation" },
    { path: "fr/groupe/excellence-operationnelle",        label: "groupe-excellence" },
    { path: "fr/groupe/engagements",                      label: "groupe-engagements" },
    { path: "fr/groupe/presentation/propulsion-aeronautique", label: "propulsion-aeronautique" },
    { path: "fr/groupe/presentation/defense",             label: "defense" },
    { path: "fr/groupe/presentation/espace",              label: "espace" },
    { path: "fr/actualites",                              label: "actualites" },
    { path: "fr/finance",                                 label: "finance" },
    { path: "fr/contact",                                 label: "contact" },
    { path: "fr/implantations",                           label: "implantations" },
    { path: "fr/safran-monde/notre-presence-mondiale",    label: "presence-mondiale" },
    { path: "fr/societes/safran-aircraft-engines",        label: "safran-aircraft-engines" }
  ].map(function(p) { return { url: ENV_URL + "/" + p.path, label: p.label, context: "tnr" }; });
}

// Remap an absolute target URL to a different env base URL
function remapTargetForEnv(target, envName) {
  var envUrl = CFG.envs[envName] || CFG.envs.sophie;
  var url = target.url;
  var knownBases = Object.values(CFG.envs);
  var urlPath = url;
  for (var i = 0; i < knownBases.length; i++) {
    if (url.startsWith(knownBases[i])) { urlPath = url.slice(knownBases[i].length); break; }
  }
  if (!urlPath.startsWith("/")) urlPath = "/" + urlPath;
  return Object.assign({}, target, { url: envUrl + urlPath });
}

async function runCustomStep(page, step) {
  var s = { label: step.label || step.action, status: "PASS", detail: "" };
  try {
    switch(step.action) {
      case "expect-visible":
        await page.waitForSelector(step.selector, { timeout: 5000 });
        s.detail = "Élément visible : " + step.selector; break;
      case "expect-text":
        var txt = await page.locator(step.selector || "body").textContent({ timeout: 5000 }).catch(function(){return "";});
        if (step.expected && !txt.includes(step.expected)) { s.status="FAIL"; s.detail="Texte '"+step.expected+"' non trouvé"; }
        else { s.detail = "Texte trouvé"; } break;
      case "expect-url":
        var cur = page.url();
        if (step.expected && !cur.includes(step.expected)) { s.status="FAIL"; s.detail="URL inattendue : "+cur.substring(0,60); }
        else { s.detail = "URL valide"; } break;
      case "click":
        await page.click(step.selector, { timeout: 5000 });
        await page.waitForTimeout(800); s.detail = "Clic : " + step.selector; break;
      case "fill":
        await page.fill(step.selector, step.value || "", { timeout: 5000 });
        s.detail = "Champ rempli : " + step.selector; break;
      case "wait":
        var ms = parseInt(step.value || step.expected || "1000");
        await page.waitForTimeout(ms); s.detail = "Attente : " + ms + "ms"; break;
      default:
        s.detail = "Action : " + step.action;
    }
  } catch(e) { s.status="FAIL"; s.detail="Erreur : " + e.message.substring(0,80); }
  return s;
}

async function runTest(target, BT, device, browserName, mode, envNameOverride) {
  var thisEnv = envNameOverride || ENV_NAME;
  var result = { label: target.label, url: target.url, mode: mode, env: thisEnv, device: device.name, browser: browserName, status: "PASS", failType: null, issues: [], steps: [], screenshot: null };
  var page = null; var browser = null;
  try {
    var isEdge = browserName === "edge";
    browser = await BT.launch({
      headless: true,
      channel: isEdge ? "msedge" : undefined,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-infobars"]
    });
    var isMobile = device.name.includes("mobile") || device.name.includes("iphone") || device.name.includes("samsung");
    var desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" + (isEdge ? " Edg/131.0.0.0" : "");
    var ctxOpts = {
      viewport: { width: device.w, height: device.h },
      userAgent: isMobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
        : desktopUA,
      extraHTTPHeaders: {
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      }
    };
    // Basic Auth pour les envs staging (sophie / paulo)
    if (thisEnv === "sophie" || thisEnv === "paulo") {
      ctxOpts.httpCredentials = { username: CFG.drupal.user, password: CFG.drupal.pass };
    }
    // Charger la session auth si disponible (sophie.json / paulo.json)
    var authFile = path.join(BASE_DIR, "auth", thisEnv + ".json");
    var authLoaded = false;
    if (fs.existsSync(authFile)) {
      ctxOpts.storageState = authFile;
      authLoaded = true;
      console.log("  [AUTH] Session chargée : " + thisEnv);
    }
    var context = await browser.newContext(ctxOpts);
    // Masquer le flag webdriver pour éviter la détection anti-bot
    await context.addInitScript(function() {
      Object.defineProperty(navigator, "webdriver", { get: function() { return undefined; } });
    });
    page = await context.newPage();

    var networkFails = [];
    if (mode === "api") {
      page.on("response", function(resp) { if (resp.status() >= 400) networkFails.push({ url: resp.url(), status: resp.status() }); });
    }

    var t0 = Date.now();
    var resp = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    var loadMs = Date.now() - t0;
    // Scroll progressif pour déclencher le lazy-loading
    await page.evaluate(async function() {
      await new Promise(function(resolve) {
        var total = document.body.scrollHeight;
        var step  = Math.ceil(total / 5);
        var pos   = 0;
        var timer = setInterval(function() {
          pos += step;
          window.scrollTo(0, pos);
          if (pos >= total) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
        }, 300);
      });
    }).catch(function(){});
    await page.waitForTimeout(2500);

    // Étape HTTP
    var httpCode = resp ? resp.status() : 0;
    // /node/NNN = URL interne Drupal, peut être absente sur certains envs → 404 non bloquant
    var isInternalNode = /\/node\/\d+/.test(target.url);
    var httpSt = httpCode < 400 ? "PASS" : (httpCode === 404 && isInternalNode ? "WARN" : "FAIL");
    var s1 = { label: "Statut HTTP", status: httpSt,
      detail: "HTTP " + httpCode + " — " + loadMs + "ms" + (httpCode === 404 && isInternalNode ? " (nœud interne — ignoré)" : "") };
    result.steps.push(s1);
    if (httpCode >= 400 && !(httpCode === 404 && isInternalNode)) {
      result.status = "FAIL";
      result.issues.push("HTTP " + httpCode);
      if (httpCode === 404) result.failType = "URL_404"; // raffiné plus tard en multi-env
    }
    if ((httpCode === 403 || httpCode === 401) && authLoaded) {
      var authMsg = "Session expirée — relance : node login-save-state.js " + thisEnv;
      result.issues.push(authMsg);
      result.failType = "SESSION_EXPIRED";
      console.log("  [AUTH] ⚠️  " + authMsg);
    }

    if (mode === "api") {
      // Temps de réponse
      var s2 = { label: "Temps de réponse", status: loadMs < 5000 ? "PASS" : "FAIL", detail: loadMs + "ms" };
      result.steps.push(s2);
      if (loadMs >= 5000) { result.status="FAIL"; result.issues.push("Temps trop élevé : " + loadMs + "ms"); }
      // Erreurs console
      var consoleErrors = [];
      page.on("console", function(m) { if (m.type()==="error") consoleErrors.push(m.text()); });
      await page.waitForTimeout(500);
      var s3 = { label: "Console errors", status: consoleErrors.length===0?"PASS":"FAIL", detail: consoleErrors.length>0 ? consoleErrors[0].substring(0,60) : "Aucune" };
      result.steps.push(s3);
      if (consoleErrors.length > 0) { result.status="FAIL"; result.issues.push("Console errors : " + consoleErrors.length); }
      // Requêtes réseau KO
      await page.waitForTimeout(800);
      var s4 = { label: "Requêtes réseau", status: networkFails.length===0?"PASS":"FAIL", detail: networkFails.length>0 ? networkFails.length+" KO" : "Toutes OK" };
      result.steps.push(s4);
      if (networkFails.length > 0) { result.status="FAIL"; result.issues.push(networkFails.length + " requête(s) KO"); }
    } else {
      // Titre
      var title = await page.title().catch(function(){return "";});
      var s2 = { label: "Titre page", status: title ? "PASS" : "FAIL", detail: title ? title.substring(0,50) : "Absent" };
      result.steps.push(s2);
      // Police Barlow
      var fontIssues = await page.evaluate(function() {
        var issues=[]; var seen={};
        Array.from(document.querySelectorAll("h1,h2,h3,p,.nav-link")).slice(0,12).forEach(function(el) {
          var ff = getComputedStyle(el).fontFamily;
          if (!ff.toLowerCase().includes("barlow") && !ff.toLowerCase().includes("sans-serif") && !seen[ff]) { seen[ff]=true; issues.push(ff.split(",")[0].trim()); }
        });
        return issues;
      }).catch(function(){return [];});
      var s3 = { label: "Police Barlow", status: fontIssues.length===0?"PASS":"FAIL", detail: fontIssues.length>0 ? "Police incorrecte : "+fontIssues[0] : "OK" };
      result.steps.push(s3);
      if (fontIssues.length > 0) { result.status="FAIL"; result.issues.push("Police : " + fontIssues.join(", ")); }
      // Responsive mobile
      if (isMobile) {
        var ov = await page.evaluate(function(){return document.body.scrollWidth > window.innerWidth;}).catch(function(){return false;});
        var s4 = { label: "Responsive", status: !ov?"PASS":"FAIL", detail: ov?"Débordement horizontal":"OK" };
        result.steps.push(s4);
        if (ov) { result.status="FAIL"; result.issues.push("Débordement mobile"); }
      }
      // Images — exclure les placeholders lazy non encore déclenchés (data-src sans src)
      var brokenImgs = await page.evaluate(function() {
        return Array.from(document.querySelectorAll("img")).filter(function(img) {
          var src = img.getAttribute("src") || "";
          // Ignorer les images sans src réel (lazy non déclenchées)
          if (!src || src === "" || src.startsWith("data:image/gif") || src.startsWith("data:image/png;base64,R0lGOD")) return false;
          return !img.naturalWidth || img.naturalWidth === 0;
        }).length;
      }).catch(function(){return 0;});
      var s5 = { label: "Images", status: brokenImgs===0?"PASS":"FAIL", detail: brokenImgs>0 ? brokenImgs+" image(s) manquante(s)" : "Toutes chargées" };
      result.steps.push(s5);
      if (brokenImgs > 0) { result.status="FAIL"; result.issues.push(brokenImgs + " image(s) manquante(s)"); if (!result.failType) result.failType = "IMAGE_MANQUANTE"; }
    }

    // Étapes custom
    for (var i = 0; i < STEPS.length; i++) {
      var sr = await runCustomStep(page, STEPS[i]);
      result.steps.push(sr);
      if (sr.status === "FAIL") { result.status="FAIL"; result.issues.push(STEPS[i].label + " : " + sr.detail); }
    }

  } catch(e) {
    result.status = "FAIL";
    result.issues.push("Erreur : " + e.message.substring(0,100));
    result.steps.push({ label: "Navigation", status: "FAIL", detail: e.message.substring(0,80) });
  }

  // Screenshot
  if (page) {
    try {
      var shotName = [mode, thisEnv, device.name, browserName, (target.label||"page").replace(/[^a-z0-9]/gi,"-")].join("_") + "_" + Date.now() + ".png";
      result.screenshot = path.join(SCREENSHOTS_DIR, shotName);
      await page.screenshot({ path: result.screenshot, fullPage: false });
    } catch(e) {}
  }
  if (browser) await browser.close().catch(function(){});
  return result;
}

async function createBugJira(result, mode) {
  if (DRY_RUN) { console.log("  [DRY_RUN] Bug Jira ignoré : " + result.label); return null; }
  var date = new Date().toLocaleString("fr-FR");
  var stepsSummary = (result.steps||[]).map(function(s) {
    return (s.status==="PASS"?"✅":"❌") + " " + s.label + " — " + (s.detail||"").substring(0,80);
  }).join("\n");
  var desc = "h3. Résumé\n*Mode* : "+mode.toUpperCase()+" | *URL* : "+result.url+" | *Env* : "+result.env+"\n\n" +
    "h3. Étant donné\nTest Playwright Direct lancé sur "+result.url+"\n\n" +
    "h3. Résultat obtenu\n"+(result.issues||[]).join("\n")+"\n\n" +
    "h3. Résultat attendu\nToutes les étapes en PASS\n\n" +
    "h3. Étapes de contrôle\n{noformat}\n"+stepsSummary+"\n{noformat}\n\n" +
    "h3. Environnement\n*Env* : "+result.env+" | *Browser* : "+result.browser+" | *Device* : "+result.device+" | *Date* : "+date+"\n\n" +
    "h3. Impact\n*Page* : "+result.label+" | *Sévérité* : "+(result.issues.length>2?"Majeur":"Mineur")+"\n\n" +
    "_Généré par Aby QA V2 — agent-playwright-direct.js_";
  try {
    var bug = await jiraRequest("POST", "/rest/api/2/issue", {
      fields: {
        project: { key: CFG.jira.project }, issuetype: { name: "Bug" },
        summary: "[PW-DIRECT]["+mode.toUpperCase()+"] FAIL — " + result.label,
        description: desc, priority: { name: result.issues.length>2?"High":"Medium" },
        labels: ["pw-direct", mode, result.env, "aby-qa-v2"]
      }
    });
    if (bug.key) {
      console.log("  [BUG] " + bug.key + " — " + result.label);
      if (result.screenshot && fs.existsSync(result.screenshot)) {
        await uploadAttachment(bug.key, result.screenshot);
        console.log("  [PJ]  Screenshot sur " + bug.key);
      }
      return bug.key;
    }
  } catch(e) { console.log("  [WARN] Bug KO : " + e.message.substring(0,60)); }
  return null;
}

function failTypeBadge(ft) {
  var cfg = {
    SESSION_EXPIRED: { label: "SESSION EXPIRÉE", color: "#ff9500", bg: "rgba(255,149,0,.18)"   },
    URL_INVALIDE:    { label: "URL INVALIDE",    color: "#8892a4", bg: "rgba(136,146,164,.18)" },
    REGRESSION:      { label: "RÉGRESSION",      color: "#ff3b5c", bg: "rgba(255,59,92,.18)"   },
    IMAGE_MANQUANTE: { label: "IMAGE MANQUANTE", color: "#e879f9", bg: "rgba(232,121,249,.18)" }
  };
  var c = cfg[ft] || { label: ft, color: "#ff3b5c", bg: "rgba(255,59,92,.18)" };
  return "<span style='font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700;font-family:monospace;background:" + c.bg + ";color:" + c.color + "'>" + c.label + "</span>";
}

function generateHTMLReport(allResults, mode, sourceLabel) {
  var pass=allResults.filter(function(r){return r.status==="PASS";}).length;
  var fail=allResults.filter(function(r){return r.status==="FAIL";}).length;
  var total=allResults.length;
  var pct=total>0?Math.round(pass/total*100):0;
  var date=new Date().toLocaleString("fr-FR");
  var pctColor=pct>=80?"#00e87a":pct>=50?"#ff9500":"#ff3b5c";

  var rows = allResults.map(function(r) {
    var badges = (r.steps||[]).map(function(s) {
      return "<span style='font-size:10px;padding:2px 6px;border-radius:4px;margin:1px;display:inline-block;background:"+(s.status==="PASS"?"rgba(0,232,122,.15)":"rgba(255,59,92,.15)")+";color:"+(s.status==="PASS"?"#00e87a":"#ff3b5c")+"'>"+s.label+"</span>";
    }).join(" ");
    var shotCell = r.screenshot
      ? "<a href='/screenshots/"+path.basename(r.screenshot)+"' target='_blank'>" +
        "<img src='/screenshots/"+path.basename(r.screenshot)+"' style='max-width:90px;max-height:60px;border-radius:4px;border:1px solid #1e2536;display:block' loading='lazy'></a>"
      : "<span style='color:#4a5568;font-size:10px'>—</span>";
    return "<tr style='border-bottom:1px solid #1e2536'>" +
      "<td style='padding:10px 14px;font-family:monospace;font-size:12px;color:#00d4ff'>"+((r.label||r.url).substring(0,40))+"</td>" +
      "<td style='padding:10px 14px;font-size:11px;color:#8892a4'>"+(r.device||"—")+" / "+(r.browser||"—")+"</td>" +
      "<td style='padding:10px 14px;text-align:center;font-family:monospace;font-weight:700;color:"+(r.status==="PASS"?"#00e87a":"#ff3b5c")+"'>"+(r.status==="PASS"?"✅ PASS":"❌ FAIL")+"</td>" +
      "<td style='padding:10px 14px;text-align:center'>"+(r.failType ? failTypeBadge(r.failType) : "<span style='color:#00e87a;font-size:11px'>—</span>")+"</td>" +
      "<td style='padding:10px 14px'>"+badges+"</td>" +
      "<td style='padding:10px 14px;font-size:11px;color:#8892a4'>"+(r.issues&&r.issues[0]?r.issues[0].substring(0,60):"—")+"</td>" +
      "<td style='padding:6px 10px;text-align:center'>"+shotCell+"</td>" +
      "</tr>";
  }).join("");

  var failsSection = "";
  if (fail > 0) {
    failsSection = "<div style='margin-top:24px;padding:16px 20px;background:rgba(255,59,92,.08);border:1px solid rgba(255,59,92,.25);border-radius:10px'>" +
      "<h2 style='font-size:13px;color:#ff3b5c;margin:0 0 12px'>❌ ANOMALIES (" + fail + ")</h2>" +
      allResults.filter(function(r){return r.status==="FAIL";}).map(function(r) {
        return "<div style='margin-bottom:12px;padding:12px;background:#111520;border-radius:8px;display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start'>" +
          "<div>" +
          "<div style='font-family:monospace;font-size:12px;font-weight:700;color:#ff3b5c;margin-bottom:6px'>"+(r.label||r.url)+"</div>" +
          (r.issues||[]).map(function(i){return "<div style='font-size:12px;color:#8892a4;margin-bottom:3px'>• "+i+"</div>";}).join("") +
          "<div style='margin-top:8px'>" +
          (r.steps||[]).filter(function(s){return s.status==="FAIL";}).map(function(s){
            return "<div style='font-size:11px;color:#ff9500;font-family:monospace'>  ❌ "+s.label+" : "+s.detail+"</div>";
          }).join("") +
          "</div></div>" +
          (r.screenshot ? "<a href='/screenshots/"+path.basename(r.screenshot)+"' target='_blank'>" +
            "<img src='/screenshots/"+path.basename(r.screenshot)+"' style='max-width:160px;border-radius:6px;border:1px solid rgba(255,59,92,.3)' loading='lazy'></a>" : "<span></span>") +
          "</div>";
      }).join("") + "</div>";
  }

  var html = "<!DOCTYPE html><html lang='fr'><head><meta charset='UTF-8'><title>Rapport PW Direct — "+mode.toUpperCase()+"</title>" +
    "<link href='https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@400;600&display=swap' rel='stylesheet'>" +
    "<style>body{background:#0a0d14;color:#e2e8f0;font-family:'DM Sans',sans-serif;margin:0;padding:32px} h1,h2{font-family:'Space Mono',monospace} " +
    "table{width:100%;border-collapse:collapse;background:#111520;border:1px solid #1e2536;border-radius:10px;overflow:hidden} " +
    "th{padding:10px 14px;font-family:'Space Mono',monospace;font-size:10px;color:#4a5568;text-align:left;background:#171c2b;text-transform:uppercase}</style></head>" +
    "<body><div style='max-width:1100px;margin:0 auto'>" +
    "<div style='display:flex;align-items:center;gap:16px;margin-bottom:32px'>" +
    "<div style='background:linear-gradient(135deg,#3b6fff,#00d4ff);border-radius:10px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-weight:700;font-size:14px;color:#fff'>AQ</div>" +
    "<div><h1 style='font-size:20px;margin:0'>Rapport Playwright Direct — <span style='color:#00d4ff'>"+mode.toUpperCase()+"</span></h1>" +
    "<p style='margin:4px 0 0;font-size:12px;color:#8892a4;font-family:monospace'>"+sourceLabel+" · "+ENV_NAME+" · "+date+(DRY_RUN?" · <span style='color:#ff9500'>DRY RUN</span>":"")+"</p></div></div>" +
    "<div style='display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px'>" +
    "<div style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid #00d4ff'><div style='font-family:monospace;font-size:28px;font-weight:700;color:#00d4ff'>"+total+"</div><div style='font-size:12px;color:#8892a4'>Total</div></div>" +
    "<div style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid #00e87a'><div style='font-family:monospace;font-size:28px;font-weight:700;color:#00e87a'>"+pass+"</div><div style='font-size:12px;color:#8892a4'>PASS</div></div>" +
    "<div style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid "+(fail>0?"#ff3b5c":"#00e87a")+"'><div style='font-family:monospace;font-size:28px;font-weight:700;color:"+(fail>0?"#ff3b5c":"#00e87a")+"'>"+fail+"</div><div style='font-size:12px;color:#8892a4'>FAIL</div></div>" +
    "<div style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid "+pctColor+"'><div style='font-family:monospace;font-size:28px;font-weight:700;color:"+pctColor+"'>"+pct+"%</div><div style='font-size:12px;color:#8892a4'>Qualité</div></div>" +
    "</div>" +
    "<h2 style='font-size:14px;margin:0 0 12px;color:#8892a4'>RÉSULTATS PAR TEST</h2>" +
    "<table><thead><tr><th>Page / URL</th><th>Device / Browser</th><th>Statut</th><th>Catégorie</th><th>Étapes de contrôle</th><th>Problème</th><th>📸</th></tr></thead><tbody>"+rows+"</tbody></table>" +
    failsSection +
    "<p style='font-size:11px;color:#4a5568;margin-top:24px;font-family:monospace'>Généré par Aby QA V2 — agent-playwright-direct.js</p>" +
    "</div></body></html>";

  var prefix = fail===0 ? "RAPPORT-OK-PW-DIRECT-" : "RAPPORT-FAIL-PW-DIRECT-";
  var keySuffix = (KEY && /^[A-Z]+-\d+$/i.test(KEY)) ? "-" + KEY.toUpperCase() : "";
  var reportPath = path.join(REPORTS_DIR, prefix + mode.toUpperCase() + "-" + Date.now() + keySuffix + ".html");
  fs.writeFileSync(reportPath, html, "utf8");
  return reportPath;
}

function generateComparisonReport(allEnvResults, mode) {
  var envNames = allEnvResults.map(function(e) { return e.envName; });
  var date = new Date().toLocaleString("fr-FR");

  // Per-env stats
  var envStats = allEnvResults.map(function(e) {
    var pass = e.results.filter(function(r){return r.status==="PASS";}).length;
    var fail = e.results.filter(function(r){return r.status==="FAIL";}).length;
    var pct  = e.results.length > 0 ? Math.round(pass/e.results.length*100) : 0;
    return { envName: e.envName, pass: pass, fail: fail, total: e.results.length, pct: pct };
  });

  // Group by page label
  var byLabel = {};
  allEnvResults.forEach(function(envData) {
    envData.results.forEach(function(r) {
      var key = r.label || r.url;
      if (!byLabel[key]) byLabel[key] = {};
      if (!byLabel[key][envData.envName]) byLabel[key][envData.envName] = [];
      byLabel[key][envData.envName].push(r);
    });
  });

  // Detect delta pages (FAIL on some envs, PASS on others)
  var regressions = Object.keys(byLabel).filter(function(key) {
    var statuses = envNames.map(function(en) {
      var rs = byLabel[key][en] || [];
      return rs.some(function(r){return r.status==="FAIL";}) ? "FAIL" : "PASS";
    });
    return statuses.includes("FAIL") && statuses.includes("PASS");
  });

  // Table rows
  var rows = Object.keys(byLabel).map(function(key) {
    var statuses = envNames.map(function(en) {
      var rs = byLabel[key][en] || [];
      return rs.some(function(r){return r.status==="FAIL";}) ? "FAIL" : "PASS";
    });
    var isDelta  = statuses.includes("FAIL") && statuses.includes("PASS");
    var allFail  = statuses.every(function(s){return s==="FAIL";});
    var rowBg    = isDelta ? "background:rgba(255,149,0,.06)" : allFail ? "background:rgba(255,59,92,.06)" : "";

    var cells = envNames.map(function(en) {
      var rs = byLabel[key][en] || [];
      var hasFail = rs.some(function(r){return r.status==="FAIL";});
      var failR   = hasFail ? rs.find(function(r){return r.status==="FAIL";}) : null;
      var ft      = failR ? failR.failType : null;
      var badge   = ft ? "<br>" + failTypeBadge(ft) : "";
      var issue   = failR && failR.issues[0] ? "<br><span style='font-size:10px;color:#8892a4'>" + failR.issues[0].substring(0,50) + "</span>" : "";
      var color   = hasFail ? "#ff3b5c" : "#00e87a";
      var label   = hasFail ? "❌ FAIL" : "✅ PASS";
      return "<td style='padding:10px 14px;color:" + color + ";font-family:monospace;font-weight:700;font-size:12px'>" + label + badge + issue + "</td>";
    });

    var deltaCell = isDelta
      ? "<td style='padding:10px 14px;text-align:center;font-size:14px'>⚠️</td>"
      : "<td style='padding:10px 14px;text-align:center;color:#4a5568;font-size:12px'>=</td>";

    return "<tr style='border-bottom:1px solid #1e2536;" + rowBg + "'>" +
      "<td style='padding:10px 14px;font-family:monospace;font-size:12px;color:#00d4ff'>" + key.substring(0,45) + "</td>" +
      cells.join("") + deltaCell + "</tr>";
  }).join("");

  // Env stat cards
  var statCards = envStats.map(function(s) {
    var pctColor = s.pct >= 80 ? "#00e87a" : s.pct >= 50 ? "#ff9500" : "#ff3b5c";
    return "<div style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center'>" +
      "<div style='font-family:monospace;font-size:13px;color:#8892a4;margin-bottom:10px;text-transform:uppercase'>" + s.envName + "</div>" +
      "<div style='display:flex;justify-content:center;gap:16px'>" +
      "<div><div style='font-family:monospace;font-size:22px;font-weight:700;color:#00e87a'>" + s.pass + "</div><div style='font-size:10px;color:#8892a4'>PASS</div></div>" +
      "<div><div style='font-family:monospace;font-size:22px;font-weight:700;color:" + (s.fail>0?"#ff3b5c":"#00e87a") + "'>" + s.fail + "</div><div style='font-size:10px;color:#8892a4'>FAIL</div></div>" +
      "<div><div style='font-family:monospace;font-size:22px;font-weight:700;color:" + pctColor + "'>" + s.pct + "%</div><div style='font-size:10px;color:#8892a4'>Qualité</div></div>" +
      "</div></div>";
  }).join("");

  // Regression banner
  // Compter les FAILs par catégorie dans tous les résultats
  var allFlatForBanner = allEnvResults.reduce(function(acc, e){ return acc.concat(e.results); }, []);
  var failCounts = { SESSION_EXPIRED:0, REGRESSION:0, URL_INVALIDE:0, IMAGE_MANQUANTE:0, AUTRE:0 };
  allFlatForBanner.filter(function(r){return r.status==="FAIL";}).forEach(function(r) {
    var k = r.failType && failCounts[r.failType] !== undefined ? r.failType : "AUTRE";
    failCounts[k]++;
  });
  var totalFails = allFlatForBanner.filter(function(r){return r.status==="FAIL";}).length;
  var summaryChips = [
    { key:"REGRESSION",      label:"Régressions",      color:"#ff3b5c" },
    { key:"SESSION_EXPIRED", label:"Session expirée",  color:"#ff9500" },
    { key:"URL_INVALIDE",    label:"URLs invalides",   color:"#8892a4" },
    { key:"IMAGE_MANQUANTE", label:"Images manquantes",color:"#e879f9" },
    { key:"AUTRE",           label:"Autres FAIL",      color:"#ff3b5c" }
  ].filter(function(c){ return failCounts[c.key] > 0; })
   .map(function(c){ return "<span style='margin-right:12px;font-family:monospace;font-size:12px;font-weight:700;color:"+c.color+"'>"+failCounts[c.key]+" "+c.label+"</span>"; }).join("");

  var regressionBanner = totalFails > 0
    ? "<div style='margin-bottom:20px;padding:14px 20px;background:rgba(255,149,0,.08);border:1px solid rgba(255,149,0,.3);border-radius:10px'>" +
      "<div style='font-size:13px;font-weight:700;color:#ff9500;margin-bottom:8px'>⚠️ " + totalFails + " FAIL(s) détecté(s)</div>" +
      "<div style='margin-bottom:10px'>" + summaryChips + "</div>" +
      regressions.map(function(r){ return "<div style='font-family:monospace;font-size:11px;color:#8892a4'>• " + r + "</div>"; }).join("") +
      "</div>"
    : "<div style='margin-bottom:20px;padding:14px 20px;background:rgba(0,232,122,.06);border:1px solid rgba(0,232,122,.2);border-radius:10px'>" +
      "<div style='font-size:13px;font-weight:700;color:#00e87a'>✅ Aucun FAIL entre les environnements</div></div>";

  var thEnvs = envNames.map(function(en) {
    return "<th style='padding:10px 14px;font-family:monospace;font-size:10px;color:#4a5568;text-align:left;background:#171c2b;text-transform:uppercase'>" + en.toUpperCase() + "</th>";
  }).join("");

  var hasAnyFail = allEnvResults.some(function(e){ return e.results.some(function(r){return r.status==="FAIL";}); });

  var html = "<!DOCTYPE html><html lang='fr'><head><meta charset='UTF-8'><title>Rapport Comparatif — " + mode.toUpperCase() + " — " + envNames.join(" vs ") + "</title>" +
    "<link href='https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@400;600&display=swap' rel='stylesheet'>" +
    "<style>body{background:#0a0d14;color:#e2e8f0;font-family:'DM Sans',sans-serif;margin:0;padding:32px} h1,h2{font-family:'Space Mono',monospace} " +
    "table{width:100%;border-collapse:collapse;background:#111520;border:1px solid #1e2536;border-radius:10px;overflow:hidden} " +
    "th{padding:10px 14px;font-family:'Space Mono',monospace;font-size:10px;color:#4a5568;text-align:left;background:#171c2b;text-transform:uppercase}</style></head>" +
    "<body><div style='max-width:1200px;margin:0 auto'>" +
    "<div style='display:flex;align-items:center;gap:16px;margin-bottom:28px'>" +
    "<div style='background:linear-gradient(135deg,#3b6fff,#00d4ff);border-radius:10px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-weight:700;font-size:14px;color:#fff'>AQ</div>" +
    "<div><h1 style='font-size:20px;margin:0'>Rapport Comparatif — <span style='color:#00d4ff'>" + mode.toUpperCase() + "</span> — " +
    envNames.map(function(en,i){ return i===0 ? en : "<span style='color:#ff9500'>vs</span> " + en; }).join(" ") + "</h1>" +
    "<p style='margin:4px 0 0;font-size:12px;color:#8892a4;font-family:monospace'>" + date + (DRY_RUN?" · <span style='color:#ff9500'>DRY RUN</span>":"") + "</p></div></div>" +
    "<div style='display:grid;grid-template-columns:repeat(" + envNames.length + ",1fr);gap:14px;margin-bottom:24px'>" + statCards + "</div>" +
    regressionBanner +
    "<h2 style='font-size:14px;margin:0 0 12px;color:#8892a4'>COMPARAISON PAR PAGE</h2>" +
    "<table><thead><tr>" +
    "<th style='padding:10px 14px;font-family:monospace;font-size:10px;color:#4a5568;text-align:left;background:#171c2b;text-transform:uppercase'>Page / URL</th>" +
    thEnvs +
    "<th style='padding:10px 14px;font-family:monospace;font-size:10px;color:#4a5568;text-align:center;background:#171c2b;text-transform:uppercase'>Delta</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    "<p style='font-size:11px;color:#4a5568;margin-top:24px;font-family:monospace'>Généré par Aby QA V2 — agent-playwright-direct.js (comparaison multi-env)</p>" +
    "</div></body></html>";

  var prefix = hasAnyFail ? "RAPPORT-FAIL-PW-DIRECT-COMPARE-" : "RAPPORT-OK-PW-DIRECT-COMPARE-";
  var reportPath = path.join(REPORTS_DIR, prefix + mode.toUpperCase() + "-" + Date.now() + ".html");
  fs.writeFileSync(reportPath, html, "utf8");
  return reportPath;
}

async function main() {
  console.log("==================================================");
  console.log("  AGENT PLAYWRIGHT DIRECT - ABY QA V2");
  console.log("==================================================");
  console.log("  Mode    : " + MODE + " | Source : " + SOURCE + " | Env : " + (IS_MULTI_ENV ? ENV_NAMES.join(", ") : ENV_NAME));
  console.log("  Devices : " + DEVICES.map(function(d){return d.name;}).join(", "));
  console.log("  Browsers: " + BROWSERS.join(", "));
  if (STEPS.length > 0) console.log("  Étapes custom : " + STEPS.length);
  if (DRY_RUN) console.log("  [DRY_RUN] Pas de création Jira");
  if (IS_MULTI_ENV) console.log("  [COMPARAISON] " + ENV_NAMES.join(" vs "));
  console.log("==================================================\n");

  // ── MODE MULTI-ENV : comparaison côte-à-côte ─────────────────────────────
  if (IS_MULTI_ENV) {
    // 1. Résoudre les cibles une seule fois (avec le premier env comme base)
    var baseTargets = MODE === "tnr" ? getTNRPages() : await resolveTargets();
    console.log("[CIBLES] " + baseTargets.length + " URL(s) × " + ENV_NAMES.length + " environnements");

    // 2. Lancer les tests en parallèle sur chaque env
    var allEnvResults = await Promise.all(ENV_NAMES.map(async function(envName) {
      var envTargets = baseTargets.map(function(t) { return remapTargetForEnv(t, envName); });
      var results = [];
      for (var bi2 = 0; bi2 < BROWSERS.length; bi2++) {
        for (var di2 = 0; di2 < DEVICES.length; di2++) {
          var bn2 = BROWSERS[bi2]; var dev2 = DEVICES[di2];
          var BT2 = BROWSER_MAP[bn2] || chromium;
          console.log("\n[" + envName + " | " + bn2 + " | " + dev2.name + "] — " + envTargets.length + " cible(s)");
          for (var ti2 = 0; ti2 < envTargets.length; ti2++) {
            var tgt2 = envTargets[ti2];
            process.stdout.write("  [" + (ti2+1) + "/" + envTargets.length + "] " + (tgt2.label||tgt2.url).substring(0,35) + "... ");
            var r2 = await runTest(tgt2, BT2, dev2, bn2, MODE, envName);
            console.log(r2.status + (r2.issues.length ? " — " + r2.issues[0].substring(0,45) : ""));
            results.push(r2);
          }
        }
      }
      return { envName: envName, envUrl: CFG.envs[envName], results: results };
    }));

    // 2b. Raffiner URL_404 → URL_INVALIDE (404 partout) ou REGRESSION (404 sur un seul env)
    var labelMap = {};
    allEnvResults.forEach(function(envData) {
      envData.results.forEach(function(r) {
        var key = r.label || r.url;
        if (!labelMap[key]) labelMap[key] = [];
        labelMap[key].push(r);
      });
    });
    Object.keys(labelMap).forEach(function(key) {
      var group   = labelMap[key];
      var url404  = group.filter(function(r) { return r.failType === "URL_404"; });
      if (url404.length === 0) return;
      if (url404.length === group.length) {
        url404.forEach(function(r) { r.failType = "URL_INVALIDE"; }); // page inexistante partout
      } else {
        url404.forEach(function(r) { r.failType = "REGRESSION"; });   // page absente sur certains envs
      }
    });

    // 3. Rapport comparatif
    var cmpReportPath = generateComparisonReport(allEnvResults, MODE);
    console.log("\n[RAPPORT COMPARATIF] " + path.basename(cmpReportPath));

    // 4. Totaux agrégés
    var allFlat = allEnvResults.reduce(function(acc, e){ return acc.concat(e.results); }, []);
    var cPass = allFlat.filter(function(r){return r.status==="PASS";}).length;
    var cFail = allFlat.filter(function(r){return r.status==="FAIL";}).length;
    var cTotal = allFlat.length;
    var cPct = cTotal > 0 ? Math.round(cPass/cTotal*100) : 0;

    // 5. Sortie JSON pour le dashboard
    console.log("PLAYWRIGHT_DIRECT_RESULT:" + JSON.stringify({
      comparison: true, envs: ENV_NAMES.join(" vs "),
      pass: cPass, fail: cFail, total: cTotal, pct: cPct,
      mode: MODE, reportPath: path.basename(cmpReportPath), bugs: [], dryRun: DRY_RUN
    }));
    var cmpFull = allEnvResults.map(function(e) {
      return { envName: e.envName, results: e.results.map(function(r) {
        return { label:r.label, url:r.url, status:r.status, env:r.env, device:r.device, browser:r.browser, issues:r.issues, steps:r.steps, screenshot: r.screenshot ? path.basename(r.screenshot) : null };
      })};
    });
    console.log("PLAYWRIGHT_DIRECT_FULL:" + JSON.stringify(cmpFull));

    console.log("\n==================================================");
    allEnvResults.forEach(function(e) {
      var ep = e.results.filter(function(r){return r.status==="PASS";}).length;
      var ef = e.results.filter(function(r){return r.status==="FAIL";}).length;
      console.log("  " + e.envName.toUpperCase() + " : " + ep + " PASS / " + ef + " FAIL");
    });
    console.log("  " + (cFail===0 ? "✅ AUCUNE RÉGRESSION" : "⚠️  " + cFail + " FAIL(S)"));
    console.log("==================================================\n");
    process.exit(cFail > 0 ? 1 : 0);
    return;
  }

  // ── MODE SINGLE ENV (comportement existant) ───────────────────────────────
  var targets = MODE === "tnr" ? getTNRPages() : await resolveTargets();
  console.log("[CIBLES] " + targets.length + " URL(s)");

  var allResults = [];
  for (var bi = 0; bi < BROWSERS.length; bi++) {
    for (var di = 0; di < DEVICES.length; di++) {
      var bn = BROWSERS[bi]; var dev = DEVICES[di];
      var BT = BROWSER_MAP[bn] || chromium;
      console.log("\n[" + bn + " | " + dev.name + "] — " + targets.length + " cible(s)");
      for (var ti = 0; ti < targets.length; ti++) {
        var tgt = targets[ti];
        process.stdout.write("  [" + (ti+1) + "/" + targets.length + "] " + (tgt.label||tgt.url).substring(0,40) + "... ");
        var r = await runTest(tgt, BT, dev, bn, MODE);
        console.log(r.status + (r.issues.length ? " — " + r.issues[0].substring(0,50) : ""));
        allResults.push(r);
      }
    }
  }

  var pass=allResults.filter(function(r){return r.status==="PASS";}).length;
  var fail=allResults.filter(function(r){return r.status==="FAIL";}).length;
  var total=allResults.length;
  var pct=total>0?Math.round(pass/total*100):0;

  var sourceLabel = SOURCE==="jira-key"&&KEY?KEY : SOURCE==="xml"?(XML_FILE||"xml") : SOURCE==="text"?"texte libre" : (URLS_RAW||"url");
  var reportPath = generateHTMLReport(allResults, MODE, sourceLabel);
  console.log("\n[RAPPORT] " + path.basename(reportPath));

  var bugKeys = [];
  var fails = allResults.filter(function(r){return r.status==="FAIL";});
  if (fails.length > 0) {
    console.log("\n[BUGS] " + fails.length + " FAIL(s)...");
    for (var i = 0; i < fails.length; i++) {
      var k = await createBugJira(fails[i], MODE);
      if (k) bugKeys.push(k);
    }
  }

  console.log("PLAYWRIGHT_DIRECT_RESULT:" + JSON.stringify({ pass:pass, fail:fail, total:total, pct:pct, mode:MODE, env:ENV_NAME, reportPath:path.basename(reportPath), bugs:bugKeys, dryRun:DRY_RUN, ticketKey: KEY || null }));
  var fullForDashboard = allResults.map(function(r) {
    return { label:r.label, url:r.url, status:r.status, device:r.device, browser:r.browser, issues:r.issues, steps:r.steps, screenshot: r.screenshot ? path.basename(r.screenshot) : null };
  });
  console.log("PLAYWRIGHT_DIRECT_FULL:" + JSON.stringify(fullForDashboard));

  console.log("\n==================================================");
  console.log("  PASS : " + pass + "/" + total + " (" + pct + "%) | FAIL : " + fail + " | Bugs : " + bugKeys.length);
  console.log("  " + (fail===0 ? "✅ TOUT PASS" : "⚠️  " + fail + " FAIL(S)"));
  console.log("==================================================\n");

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function(e) { console.error("[ERR FATAL]", e.message); process.exit(1); });
