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
const reporterUtils   = require("./reporter-utils");
const scenarioExec    = require("./scenario-executor");
var leadQA;
try { leadQA = require("./agent-lead-qa"); } catch(e) { leadQA = null; }

var args = process.argv.slice(2);
function arg(name) {
  var a = args.find(function(a) { return a.startsWith("--" + name + "="); });
  return a ? a.split("=").slice(1).join("=") : null;
}
function flag(name) { return args.includes("--" + name); }

var MODE     = arg("mode")    || "ui";
var SOURCE   = arg("source")  || "url";
var ENV_NAME = arg("env")     || "sophie";
var DRY_RUN       = flag("dry-run");
var NO_JIRA_PUSH  = flag("no-jira-push");

// Multi-env support (--envs=sophie,prod)
var ENV_NAMES_RAW = arg("envs");
var ENV_NAMES     = ENV_NAMES_RAW ? ENV_NAMES_RAW.split(",") : [ENV_NAME];
var IS_MULTI_ENV  = ENV_NAMES.length > 1;
var KEY      = arg("key")     || null;
var XML_FILE = arg("xml")     || null;
var TEXT     = arg("text")    || null;
var URLS_RAW = arg("urls")    || null;
var TICKET_INFO = null; // Enrichi par getUrlsFromJiraKey si --key fourni
var PROPOSED_TESTS = []; // Scénarios AUTO/MANUEL depuis le ticket enrichi
var SCENARIO_RESULTS = []; // Résultats d'exécution des scénarios
var CSV_TEST_CASES = []; // Cas de test parsés depuis le CSV attaché au ticket TEST

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

/**
 * Convertit un document ADF (Atlassian Document Format) en texte markdown.
 * Gère : paragraphs, headings, bulletList, orderedList, codeBlock, table, inlineCard, mentions, links
 */
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  // Texte brut (API v2) — retourner tel quel
  if (typeof node !== "object") return String(node);
  // Si c'est déjà du texte (pas un doc ADF)
  if (!node.type && !node.content) return String(node);

  var text = "";
  switch (node.type) {
    case "doc":
      text = (node.content || []).map(adfToText).join("\n"); break;
    case "paragraph":
      text = (node.content || []).map(adfToText).join(""); break;
    case "heading":
      var level = node.attrs && node.attrs.level || 2;
      var prefix = "#".repeat(Math.min(level, 3)) + " ";
      text = prefix + (node.content || []).map(adfToText).join(""); break;
    case "text":
      var t = node.text || "";
      if (node.marks) {
        node.marks.forEach(function(m) {
          if (m.type === "strong") t = "**" + t + "**";
          if (m.type === "em") t = "*" + t + "*";
          if (m.type === "link" && m.attrs && m.attrs.href) t = "[" + t + "](" + m.attrs.href + ")";
          if (m.type === "code") t = "`" + t + "`";
        });
      }
      text = t; break;
    case "bulletList":
      text = (node.content || []).map(function(li) {
        return "- " + (li.content || []).map(adfToText).join("\n  ");
      }).join("\n"); break;
    case "orderedList":
      text = (node.content || []).map(function(li, i) {
        return (i + 1) + ". " + (li.content || []).map(adfToText).join("\n   ");
      }).join("\n"); break;
    case "listItem":
      text = (node.content || []).map(adfToText).join("\n"); break;
    case "codeBlock":
      text = "```\n" + (node.content || []).map(adfToText).join("") + "\n```"; break;
    case "blockquote":
      text = (node.content || []).map(function(c) { return "> " + adfToText(c); }).join("\n"); break;
    case "rule":
      text = "---"; break;
    case "table":
      text = (node.content || []).map(function(row) {
        return "| " + (row.content || []).map(function(cell) {
          return (cell.content || []).map(adfToText).join(" ");
        }).join(" | ") + " |";
      }).join("\n"); break;
    case "inlineCard":
      text = node.attrs && node.attrs.url ? node.attrs.url : ""; break;
    case "mention":
      text = "@" + (node.attrs && node.attrs.text || ""); break;
    case "hardBreak":
      text = "\n"; break;
    case "emoji":
      text = node.attrs && node.attrs.shortName || ""; break;
    case "mediaSingle": case "media":
      text = "[media]"; break;
    default:
      if (node.content) text = (node.content || []).map(adfToText).join("");
  }
  return text;
}

/**
 * Normalise une description Jira : convertit ADF objet en markdown, garde le texte tel quel.
 */
function normalizeDescription(desc) {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  if (typeof desc === "object" && desc.type === "doc") return adfToText(desc);
  return String(desc);
}

function mimeFromExt(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".html") return "text/html";
  if (ext === ".json") return "application/json";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/png";
}

function uploadAttachment(issueKey, filePath) {
  return new Promise(function(resolve) {
    if (!fs.existsSync(filePath)) { resolve(null); return; }
    var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var fileData = fs.readFileSync(filePath);
    var fileName = path.basename(filePath);
    var boundary = "----QABoundary" + Date.now();
    var header = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: " + mimeFromExt(filePath) + "\r\n\r\n";
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

// Télécharger une pièce jointe Jira (retourne le contenu texte)
function downloadJiraAttachment(contentUrl) {
  return new Promise(function(resolve, reject) {
    var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var parsed = new URL(contentUrl);
    var req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + (parsed.search || ""), method: "GET",
      headers: { "Authorization": "Basic " + auth, "Accept": "*/*" }
    }, function(res) {
      // Suivre les redirections (Jira peut rediriger vers S3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var rParsed = new URL(res.headers.location);
        var req2 = https.request({
          hostname: rParsed.hostname, path: rParsed.pathname + (rParsed.search || ""), method: "GET"
        }, function(res2) {
          var d = ""; res2.on("data", function(c) { d += c; }); res2.on("end", function() { resolve(d); });
        });
        req2.on("error", reject); req2.end();
        return;
      }
      var d = ""; res.on("data", function(c) { d += c; }); res.on("end", function() { resolve(d); });
    });
    req.on("error", reject); req.end();
  });
}

// Parser un CSV cas de test (Action, Données, Résultat Attendu)
function parseCSVTestCases(csvContent) {
  // Retirer BOM UTF-8
  var content = csvContent.replace(/^\uFEFF/, "").trim();
  var lines = content.split("\n").map(function(l) { return l.trim(); }).filter(function(l) { return l; });
  if (lines.length < 2) return [];

  // Sauter la ligne d'en-tête
  var cases = [];
  for (var i = 1; i < lines.length; i++) {
    // Parser CSV avec gestion des guillemets
    var fields = parseCSVLine(lines[i]);
    if (fields.length >= 3) {
      cases.push({
        action: fields[0] || "",
        data: fields[1] || "",
        expected: fields[2] || ""
      });
    }
  }
  return cases;
}

// Parser une ligne CSV (gère les guillemets et virgules dans les champs)
function parseCSVLine(line) {
  var fields = [];
  var current = "";
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function getUrlsFromJiraKey(key) {
  console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "read-ticket", message: "📖 Lecture ticket " + key + "...", pct: 5 }));
  console.log("[->] Lecture du ticket " + key + " dans Jira...");
  var issue = await jiraRequest("GET", "/rest/api/3/issue/" + key + "?fields=summary,description,comment,issuetype,issuelinks,attachment");
  console.log("[DEBUG] Jira response key=" + (issue.key || "NONE") + " type=" + ((issue.fields && issue.fields.issuetype && issue.fields.issuetype.name) || "NONE") + " attachments=" + ((issue.fields && issue.fields.attachment) ? issue.fields.attachment.length : "NONE"));
  if (!issue.key) { console.log("[DEBUG] issue.key vide — fallback accueil"); return [{ url: ENV_URL + "/fr", label: "Accueil", context: "ticket " + key }]; }
  // Stocker les infos du ticket pour le rapport (ADF → markdown)
  TICKET_INFO = {
    key: issue.key,
    summary: issue.fields.summary || "",
    description: normalizeDescription(issue.fields.description),
    type: (issue.fields.issuetype && issue.fields.issuetype.name) || ""
  };
  // Si ticket Test, remonter au ticket parent (Bug/US) pour avoir le cas de test complet
  console.log("[DEBUG] TICKET_INFO.type = '" + TICKET_INFO.type + "' — isTest=" + (TICKET_INFO.type === "Test" || TICKET_INFO.type === "Test Case"));
  if (TICKET_INFO.type === "Test" || TICKET_INFO.type === "Test Case") {
    var links = (issue.fields.issuelinks || []);
    var parentKey = null;
    for (var li = 0; li < links.length; li++) {
      var lk = links[li];
      // "tests" / "is test of" → outwardIssue est le parent
      if (lk.outwardIssue && lk.outwardIssue.key) { parentKey = lk.outwardIssue.key; break; }
      if (lk.inwardIssue && lk.inwardIssue.key) { parentKey = lk.inwardIssue.key; break; }
    }
    if (parentKey) {
      console.log("  [TEST] Ticket Test détecté — chargement du parent " + parentKey + "...");
      var parent = await jiraRequest("GET", "/rest/api/3/issue/" + parentKey + "?fields=summary,description,issuetype");
      if (parent && parent.key) {
        TICKET_INFO.parentKey = parent.key;
        TICKET_INFO.parentSummary = parent.fields.summary || "";
        TICKET_INFO.parentDescription = normalizeDescription(parent.fields.description);
        TICKET_INFO.parentType = (parent.fields.issuetype && parent.fields.issuetype.name) || "";
      }
    }

    // Télécharger le CSV de cas de test attaché au ticket TEST
    var attachments = issue.fields.attachment || [];
    var csvAttachment = attachments.find(function(a) {
      return a.filename && /^CAS-TEST-.*\.csv$/i.test(a.filename);
    });
    if (csvAttachment && csvAttachment.content) {
      console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "download-csv", message: "📎 Téléchargement " + csvAttachment.filename + "...", pct: 10 }));
      try {
        var csvContent = await downloadJiraAttachment(csvAttachment.content);
        // Debug : afficher le contenu brut du CSV téléchargé
        console.log("\n╔══════════════════════════════════════════════════════════════╗");
        console.log("║  CSV BRUT TÉLÉCHARGÉ — " + csvAttachment.filename);
        console.log("║  Taille : " + csvContent.length + " chars");
        console.log("║  Premiers 500 chars :");
        console.log("╠══════════════════════════════════════════════════════════════╣");
        console.log(csvContent.substring(0, 500));
        console.log("╠══════════════════════════════════════════════════════════════╣");
        console.log("║  Char codes des 20 premiers : " + csvContent.substring(0, 20).split("").map(function(c) { return c.charCodeAt(0); }).join(","));
        // Debug : tester le split
        var debugLines = csvContent.replace(/^\uFEFF/, "").trim().split("\n");
        console.log("║  Lignes après split(\\n) : " + debugLines.length);
        debugLines.forEach(function(l, i) {
          console.log("║  Ligne " + i + " (" + l.length + " chars) : " + l.substring(0, 80));
        });
        console.log("╚══════════════════════════════════════════════════════════════╝\n");

        CSV_TEST_CASES = parseCSVTestCases(csvContent);
        console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "csv-loaded", message: "📎 CSV chargé — " + CSV_TEST_CASES.length + " cas de test", pct: 12 }));
        console.log("[CSV] " + CSV_TEST_CASES.length + " cas de test parsés depuis " + csvAttachment.filename);
        TICKET_INFO.csvTestCases = CSV_TEST_CASES;
        TICKET_INFO.csvFileName = csvAttachment.filename;
      } catch(csvErr) {
        console.log("[CSV] Erreur téléchargement/parsing : " + csvErr.message);
      }
    } else {
      console.log("  [CSV] Aucun fichier CAS-TEST-*.csv attaché au ticket");
    }
  }
  var descText = normalizeDescription(issue.fields.description);
  var commentsText = (issue.fields.comment && issue.fields.comment.comments)
    ? issue.fields.comment.comments.map(function(c) { return normalizeDescription(c.body); }).join(" ")
    : "";
  var desc = descText + " " + commentsText;
  // 1. Extraire les URLs depuis la syntaxe Jira [texte|url] en priorité
  var jiraLinkUrls = [];
  var jiraLinkRe = /\[([^\|\]]+)\|([^\]]+)\]/g;
  var jlm;
  while ((jlm = jiraLinkRe.exec(desc)) !== null) {
    var jlUrl = jlm[2].trim();
    if (/^https?:\/\//i.test(jlUrl)) jiraLinkUrls.push(jlUrl);
  }
  // 2. Extraire les URLs brutes du texte
  var urlMatches = desc.match(/https?:\/\/[^\s<"'\]\)]+/g) || [];
  // 3. Combiner et nettoyer
  var allRawUrls = jiraLinkUrls.concat(urlMatches);
  var seen = {};
  var urls = allRawUrls
    .reduce(function(acc, raw) {
      // Séparer les URLs collées par pipe, virgule ou point-virgule
      return acc.concat(raw.split(/[|,;]/).map(function(u) { return u.trim(); }));
    }, [])
    .map(function(u) {
      // Nettoyer les caractères Jira parasites en fin d'URL : ) ( ] [ | _ { }
      return u.replace(/[\)\(\]\[\|\_\{\}]+$/g, "").trim();
    })
    .filter(function(u) {
      if (!u || !/^https?:\/\//i.test(u)) return false;
      try { var p = new URL(u); return p.hostname && p.hostname.includes("."); } catch(e) {
        console.log("  [URL] Rejetée (invalide) : " + u.substring(0, 60));
        return false;
      }
    })
    .filter(function(u) {
      return !u.includes("atlassian.net") && !u.includes("avatar") && !seen[u] && (seen[u]=true);
    }).map(function(u) { return { url: u, label: u.split("/").slice(3).join("/") || "page", context: "ticket " + key }; });
  if (urls.length === 0) urls = [{ url: ENV_URL + "/fr", label: "Accueil (fallback)", context: "ticket " + key }];
  // Charger les scénarios proposés depuis le ticket enrichi
  var enrichedKey = TICKET_INFO.parentKey || TICKET_INFO.key;
  var enrichedPath = path.join(BASE_DIR, "inbox", "enriched", enrichedKey + ".json");
  if (fs.existsSync(enrichedPath)) {
    try {
      var enrichedData = JSON.parse(fs.readFileSync(enrichedPath, "utf8"));
      if (enrichedData.proposedTests && enrichedData.proposedTests.length) {
        PROPOSED_TESTS = enrichedData.proposedTests;
        console.log("  [SCENARIOS] " + PROPOSED_TESTS.length + " scénario(s) chargé(s) depuis " + enrichedKey);
      }
      if (enrichedData.fixTests && enrichedData.fixTests.length) {
        // Convertir fixTests en format proposedTests MANUEL
        enrichedData.fixTests.forEach(function(ft) {
          PROPOSED_TESTS.push({ name: ft, type: "manual", steps: [ft], expectedResult: "Vérification manuelle OK" });
        });
      }
      if (enrichedData.testCases && enrichedData.testCases.length) {
        enrichedData.testCases.forEach(function(tc) {
          PROPOSED_TESTS.push({
            name: tc.id ? tc.id + " — " + (tc.action || "").substring(0, 50) : (tc.action || "").substring(0, 50),
            type: "manual",
            steps: [tc.action || ""],
            expectedResult: tc.expected || "",
            data: tc.data || ""
          });
        });
      }
    } catch(e) { /* pas de scénarios enrichis */ }
  }

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
        // Séparateur pipe : "path|https://full" ou "label|url" → prendre la partie URL complète si présente, sinon le chunk
        if (chunk.includes("|")) {
          var pipeParts = chunk.split("|").map(function(p) { return p.trim(); }).filter(Boolean);
          // Prendre la partie qui ressemble à une URL complète (https://) en priorité, sinon la première partie
          var fullUrl = pipeParts.find(function(p) { return /^https?:\/\//i.test(p); });
          chunk = fullUrl || pipeParts[0];
        }
        // Nettoyer les caractères parasites en fin d'URL (virgule, point, espace, guillemets)
        chunk = chunk.replace(/[,.\s"']+$/, "");
        // Gérer les URLs complètes collées (https://a.comhttps://b.com)
        var parts = chunk.split(/(?=https?:\/\/)/);
        return acc.concat(parts.map(function(p) { return p.trim().replace(/[,.\s]+$/, ""); }).filter(Boolean));
      }, []);
    // Pour les chemins relatifs, préfixer avec ENV_URL
    var normalized = splitUrls.map(function(url) {
      if (!/^https?:\/\//i.test(url)) {
        var p = url.replace(/^\/+/, "");
        url = ENV_URL + "/" + p;
      }
      return url;
    });
    return normalized.filter(function(url) {
      // Rejeter les URLs malformées (domaine vide, contenant virgule dans le host, etc.)
      try { var u = new URL(url); return u.hostname && !u.hostname.includes(","); } catch(e) { return false; }
    }).filter(function(url) {
      return !seenUrls[url] && (seenUrls[url] = true);
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
  var s = { label: step.label || step.action, status: "PASS", detail: "", selector: step.selector || null };
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

// Injecte des encadrés vert/rouge + badges sur les éléments testés avant le screenshot
async function annotateScreenshot(page, steps) {
  try {
    await page.evaluate(function(stepsData) {
      // Nettoyer une éventuelle annotation précédente
      var old = document.getElementById("__aby-qa-overlay__");
      if (old) old.remove();

      var overlay = document.createElement("div");
      overlay.id = "__aby-qa-overlay__";
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647";
      document.body.appendChild(overlay);

      stepsData.forEach(function(step) {
        if (!step.selector) return;
        try {
          var el = document.querySelector(step.selector);
          if (!el) return;
          var rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return; // élément invisible/hors viewport

          var isPass  = step.status === "PASS";
          var color   = isPass ? "#00e87a" : "#ff3b5c";
          var bgColor = isPass ? "rgba(0,232,122,0.10)" : "rgba(255,59,92,0.10)";

          // Encadré coloré sur l'élément
          var box = document.createElement("div");
          box.style.cssText = [
            "position:fixed", "pointer-events:none", "box-sizing:border-box",
            "border:2px solid " + color,
            "background:" + bgColor,
            "border-radius:4px",
            "top:"    + rect.top    + "px",
            "left:"   + rect.left   + "px",
            "width:"  + rect.width  + "px",
            "height:" + rect.height + "px",
            "z-index:2147483647"
          ].join(";");
          overlay.appendChild(box);

          // Badge label en haut à gauche de l'encadré
          var badge = document.createElement("div");
          badge.style.cssText = [
            "position:fixed", "pointer-events:none",
            "background:" + color, "color:#fff",
            "font-size:9px", "font-family:monospace", "font-weight:700",
            "padding:1px 5px", "border-radius:3px", "white-space:nowrap",
            "top:"  + Math.max(2, rect.top - 18) + "px",
            "left:" + rect.left + "px",
            "z-index:2147483648"
          ].join(";");
          badge.textContent = (isPass ? "✓ " : "✗ ") + step.label;
          overlay.appendChild(badge);
        } catch(e) {}
      });

      // Bandeau récapitulatif en bas de page
      var pass = stepsData.filter(function(s){ return s.status === "PASS"; }).length;
      var fail = stepsData.filter(function(s){ return s.status === "FAIL"; }).length;
      var bar  = document.createElement("div");
      bar.style.cssText = [
        "position:fixed", "bottom:0", "left:0", "right:0",
        "background:rgba(10,13,20,0.88)", "color:#fff",
        "font-family:monospace", "font-size:11px", "font-weight:700",
        "padding:6px 16px", "display:flex", "gap:16px", "align-items:center",
        "z-index:2147483648", "border-top:1px solid rgba(255,255,255,.15)"
      ].join(";");
      bar.innerHTML = "<span style='color:#8892a4'>QA Report</span>" +
        "<span style='color:#00e87a'>✅ " + pass + " PASS</span>" +
        (fail > 0 ? "<span style='color:#ff3b5c'>❌ " + fail + " FAIL</span>" : "") +
        "<span style='color:#8892a4;margin-left:auto;font-size:9px'>" + new Date().toLocaleDateString("fr-FR") + "</span>";
      overlay.appendChild(bar);
    }, steps);
  } catch(e) { /* annotations non critiques — ne pas bloquer le screenshot */ }
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

    // ── Capture diagnostics développeur (tous modes) ──────────────────────────
    var networkFails   = [];  // { url, status, method, timing }
    var consoleErrFull = [];  // { text, file, line, col }
    var jsExceptions   = [];  // { message, stack }

    page.on("response", function(resp) {
      if (resp.status() >= 400) {
        networkFails.push({ url: resp.url().substring(0, 200), status: resp.status(), method: resp.request().method() });
      }
    });
    page.on("console", function(msg) {
      if (msg.type() === "error") {
        var loc = msg.location ? msg.location() : {};
        consoleErrFull.push({
          text: msg.text().substring(0, 300),
          file: (loc.url || "").replace(/https?:\/\/[^/]+/, "").substring(0, 120),
          line: loc.lineNumber != null ? loc.lineNumber + 1 : null,
          col:  loc.columnNumber != null ? loc.columnNumber + 1 : null
        });
      }
    });
    page.on("pageerror", function(err) {
      jsExceptions.push({
        message: (err.message || String(err)).substring(0, 300),
        stack: (err.stack || "").split("\n").slice(0, 8)
          .map(function(l) { return l.replace(/https?:\/\/[^/]+/, "").substring(0, 120); })
          .join("\n")
      });
    });

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

    // ── Contexte DOM pour les steps FAIL avec sélecteur ──────────────────────
    var domSnippets = [];
    var failedSelectors = result.steps.filter(function(s) { return s.status === "FAIL" && s.selector; });
    if (failedSelectors.length > 0 && page) {
      for (var fi = 0; fi < failedSelectors.length; fi++) {
        var fStep = failedSelectors[fi];
        try {
          var snippet = await page.evaluate(function(sel) {
            var el = document.querySelector(sel);
            if (!el) return null;
            return {
              outerHTML:  el.outerHTML.substring(0, 500),
              parentHTML: (el.parentElement || el).outerHTML.substring(0, 800),
              tagName:    el.tagName.toLowerCase(),
              id:         el.id || null,
              classes:    el.className || null,
              visible:    (el.offsetWidth > 0 && el.offsetHeight > 0)
            };
          }, fStep.selector);
          if (snippet) domSnippets.push({ selector: fStep.selector, label: fStep.label, snippet: snippet });
        } catch(e) {}
      }
    }

    // Stocker les diagnostics dans result
    result.jsExceptions   = jsExceptions;
    result.consoleErrors  = consoleErrFull;
    result.networkFails   = networkFails.filter(function(n) {
      // Filtrer les ressources Jira/analytics (pas pertinentes pour les devs)
      return !n.url.includes("analytics") && !n.url.includes("gravatar");
    });
    result.domSnippets    = domSnippets;

  } catch(e) {
    result.status = "FAIL";
    result.issues.push("Erreur : " + e.message.substring(0,100));
    result.steps.push({ label: "Navigation", status: "FAIL", detail: e.message.substring(0,80) });
  }

  // Screenshot annoté (encadrés vert/rouge sur les éléments testés)
  if (page) {
    try {
      var shotName = [mode, thisEnv, device.name, browserName, (target.label||"page").replace(/[^a-z0-9]/gi,"-")].join("_") + "_" + Date.now() + ".png";
      result.screenshot = path.join(SCREENSHOTS_DIR, shotName);
      var annotableSteps = result.steps.filter(function(s) { return s.selector; });
      if (annotableSteps.length > 0) await annotateScreenshot(page, annotableSteps);
      await page.screenshot({ path: result.screenshot, fullPage: false });
    } catch(e) {}
  }
  if (browser) await browser.close().catch(function(){});
  return result;
}

/**
 * Génère et exécute les scénarios Playwright pour un ticket.
 * @param {Array} targets — URLs résolues
 * @param {string} envName — environnement
 * @returns {Promise<Array>} résultats par scénario
 */
async function runScenarios(targets, envName) {
  if (!leadQA || !TICKET_INFO) {
    console.log("[SCENARIOS] Pas de ticket info ou lead-qa indisponible — skip");
    return [];
  }

  // 1. Générer les scénarios exécutables via IA
  // Si des cas de test CSV sont disponibles, les inclure dans le contexte
  var csvContext = "";
  if (CSV_TEST_CASES.length > 0) {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  SCÉNARIOS DEPUIS CSV — " + CSV_TEST_CASES.length + " cas de test");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    CSV_TEST_CASES.forEach(function(tc, i) {
      console.log("║ Cas " + (i + 1) + "/" + CSV_TEST_CASES.length);
      console.log("║   Action   : " + tc.action.substring(0, 70));
      console.log("║   Données  : " + tc.data.substring(0, 70));
      console.log("║   Attendu  : " + tc.expected.substring(0, 70));
    });
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "scenarios", message: "🎭 Conversion de " + CSV_TEST_CASES.length + " cas CSV en scénarios Playwright...", pct: 15 }));

    csvContext = "\n\nCAS DE TEST À EXÉCUTER (extraits du CSV attaché au ticket TEST) :\n" +
      CSV_TEST_CASES.map(function(tc, i) {
        return "Cas " + (i + 1) + " :\n" +
          "  Action : " + tc.action + "\n" +
          "  Données : " + tc.data + "\n" +
          "  Résultat attendu : " + tc.expected;
      }).join("\n\n") +
      "\n\nIMPORTANT : Tu DOIS générer un scénario Playwright pour CHAQUE cas de test du CSV ci-dessus. " +
      "Chaque cas = 1 scénario. Utilise les données du cas pour construire les actions et assertions.";
  } else {
    console.log("\n[SCENARIOS] Génération des scénarios exécutables via IA...");
  }

  var scenarios = [];
  try {
    scenarios = await leadQA.generateExecutableScenarios({
      key: TICKET_INFO.key,
      summary: TICKET_INFO.summary,
      description: TICKET_INFO.description + csvContext,
      type: TICKET_INFO.type,
      urls: targets,
      parentKey: TICKET_INFO.parentKey || null,
      parentSummary: TICKET_INFO.parentSummary || "",
      parentDescription: TICKET_INFO.parentDescription || ""
    });
  } catch(e) {
    console.log("[SCENARIOS] Erreur génération : " + e.message.substring(0, 80));
    return [];
  }

  if (!scenarios || scenarios.length === 0) {
    console.log("[SCENARIOS] Aucun scénario généré");
    return [];
  }

  console.log("[SCENARIOS] " + scenarios.length + " scénario(s) généré(s)");

  // 2. Valider et basculer les scénarios invalides en MANUEL
  var validScenarios = scenarios.map(function(s, i) {
    s.id = s.id || ("scenario-" + (i + 1));
    s.titre = s.titre || s.title || ("Scénario " + (i + 1));
    s.type = (s.type || "AUTO").toUpperCase();

    if (s.type === "AUTO") {
      var validation = scenarioExec.validateScenario(s);
      if (!validation.valid) {
        console.log("  [" + s.id + "] AUTO -> MANUEL (invalide : " + validation.reason + ")");
        s.type = "MANUEL";
        s.downgradeReason = validation.reason;
      }
    }
    return s;
  });

  // 3. Exécuter les scénarios AUTO
  var results = [];
  var thisEnv = envName || ENV_NAME;

  for (var i = 0; i < validScenarios.length; i++) {
    var scenario = validScenarios[i];
    var pctBase = 20 + Math.floor(70 * i / validScenarios.length);
    console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "test-run", message: "🎭 Exécution cas " + (i + 1) + "/" + validScenarios.length + " — " + (scenario.titre || "").substring(0, 50) + "...", pct: pctBase }));
    var sr = {
      id: scenario.id,
      titre: scenario.titre,
      type: scenario.type,
      pass: null,
      error: null,
      actionsExecuted: [],
      assertionsChecked: [],
      screenshot: null,
      downgradeReason: scenario.downgradeReason || null
    };

    if (scenario.type === "MANUEL") {
      console.log("  [" + scenario.id + "] MANUEL — " + scenario.titre + (sr.downgradeReason ? " (" + sr.downgradeReason + ")" : ""));
      results.push(sr);
      continue;
    }

    // Exécuter le scénario AUTO
    console.log("  [" + scenario.id + "] AUTO — " + scenario.titre + "...");
    var browser = null;
    var page = null;
    try {
      var BT = BROWSER_MAP[BROWSERS[0]] || chromium;
      browser = await BT.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-infobars"]
      });
      var ctxOpts = {
        viewport: { width: DEVICES[0].w, height: DEVICES[0].h },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" }
      };
      if (thisEnv === "sophie" || thisEnv === "paulo") {
        ctxOpts.httpCredentials = { username: CFG.drupal.user, password: CFG.drupal.pass };
      }
      var authFile = path.join(BASE_DIR, "auth", thisEnv + ".json");
      if (fs.existsSync(authFile)) ctxOpts.storageState = authFile;

      var context = await browser.newContext(ctxOpts);
      await context.addInitScript(function() {
        Object.defineProperty(navigator, "webdriver", { get: function() { return undefined; } });
      });
      page = await context.newPage();

      var execResult = await scenarioExec.executeScenario(page, scenario, { timeout: 15000 });
      sr.pass = execResult.pass;
      sr.error = execResult.error;
      sr.actionsExecuted = execResult.actionsExecuted;
      sr.assertionsChecked = execResult.assertionsChecked;

      // Screenshot post-exécution
      try {
        var shotName = "scenario_" + scenario.id + "_" + thisEnv + "_" + Date.now() + ".png";
        sr.screenshot = path.join(SCREENSHOTS_DIR, shotName);
        await page.screenshot({ path: sr.screenshot, fullPage: false });
      } catch(e) {}

      var statusIcon = sr.pass ? "PASS" : "FAIL";
      console.log("    -> " + statusIcon + (sr.error ? " — " + sr.error.substring(0, 60) : ""));
    } catch(e) {
      sr.pass = false;
      sr.error = "Erreur exécution : " + e.message.substring(0, 100);
      console.log("    -> FAIL — " + sr.error);
    }
    // Émettre progress PASS/FAIL pour le dashboard
    console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({
      step: "test-done",
      status: sr.pass ? "PASS" : "FAIL",
      label: "Cas " + (i + 1) + "/" + validScenarios.length + " — " + (scenario.titre || ""),
      message: (sr.pass ? "✅" : "❌") + " Cas " + (i + 1) + " " + (sr.pass ? "PASS" : "FAIL") + (sr.error ? " — " + sr.error.substring(0, 60) : ""),
      pct: 20 + Math.floor(70 * (i + 1) / validScenarios.length)
    }));
    if (browser) await browser.close().catch(function(){});
    results.push(sr);
  }

  return results;
}

async function createBugJira(result, mode) {
  if (DRY_RUN) { console.log("  [DRY_RUN] Bug Jira ignoré : " + result.label); return null; }
  var date = new Date().toLocaleString("fr-FR");
  var stepsSummary = (result.steps||[]).map(function(s) {
    return (s.status==="PASS"?"[OK]":"[FAIL]") + " " + s.label + " — " + (s.detail||"").substring(0,80);
  }).join("\n");

  // ── Blocs diagnostics développeur ────────────────────────────────────────────
  var devSection = "";

  // Exceptions JS (page errors)
  if (result.jsExceptions && result.jsExceptions.length) {
    devSection += "h3. ⚡ Exceptions JavaScript\n";
    result.jsExceptions.forEach(function(ex, i) {
      devSection += "*Exception " + (i+1) + "* : " + ex.message + "\n";
      if (ex.stack) devSection += "{noformat:title=Stack trace}\n" + ex.stack + "\n{noformat}\n";
    });
    devSection += "\n";
  }

  // Erreurs console avec localisation fichier:ligne:col
  if (result.consoleErrors && result.consoleErrors.length) {
    devSection += "h3. 🖥️ Erreurs Console\n{noformat}\n";
    result.consoleErrors.forEach(function(ce) {
      var loc = ce.file ? (ce.file + (ce.line != null ? ":" + ce.line : "") + (ce.col != null ? ":" + ce.col : "")) : "";
      devSection += (loc ? "[" + loc + "] " : "") + ce.text + "\n";
    });
    devSection += "{noformat}\n\n";
  }

  // Requêtes réseau KO
  if (result.networkFails && result.networkFails.length) {
    devSection += "h3. 🌐 Requêtes Réseau KO\n{noformat}\n";
    result.networkFails.forEach(function(nf) {
      devSection += nf.method + "  " + nf.status + "  " + nf.url + "\n";
    });
    devSection += "{noformat}\n\n";
  }

  // Contexte DOM des éléments en échec
  if (result.domSnippets && result.domSnippets.length) {
    devSection += "h3. 🔍 Contexte DOM — Éléments en échec\n";
    result.domSnippets.forEach(function(ds) {
      devSection += "*" + ds.label + "* — sélecteur : {{" + ds.selector + "}}\n";
      devSection += "Visible : " + (ds.snippet.visible ? "oui" : "*non — élément absent/caché*") + "\n";
      devSection += "{noformat:title=outerHTML}\n" + ds.snippet.outerHTML + "\n{noformat}\n";
    });
    devSection += "\n";
  }

  var desc = "h3. Résumé\n*Mode* : "+mode.toUpperCase()+" | *URL* : "+result.url+" | *Env* : "+result.env+"\n\n" +
    "h3. Étant donné\nTest Playwright Direct lancé sur "+result.url+"\n\n" +
    "h3. Résultat obtenu\n"+(result.issues||[]).join("\n")+"\n\n" +
    "h3. Résultat attendu\nToutes les étapes en PASS\n\n" +
    "h3. Étapes de contrôle\n{noformat}\n"+stepsSummary+"\n{noformat}\n\n" +
    (devSection || "") +
    "h3. Environnement\n*Env* : "+result.env+" | *Browser* : "+result.browser+" | *Device* : "+result.device+" | *Date* : "+date+"\n\n" +
    "h3. Impact\n*Page* : "+result.label+" | *Sévérité* : "+(result.issues.length>2?"Majeur":"Mineur")+"\n\n" +
    "_Généré automatiquement — test Playwright_";
  try {
    var bug = await jiraRequest("POST", "/rest/api/2/issue", {
      fields: {
        project: { key: CFG.jira.project }, issuetype: { name: "Bug" },
        summary: "[PW-DIRECT]["+mode.toUpperCase()+"] FAIL — " + result.label,
        description: desc, priority: { name: result.issues.length>2?"High":"Medium" },
        labels: ["pw-direct", mode, result.env, "qa-auto"]
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

// ── CSS print professionnel (thème clair pour PDF) ──────────────────────────
var PRINT_CSS =
  "@media print {" +
  "body{background:#fff!important;color:#1a1a2e!important;padding:0!important;font-size:11px}" +
  "*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}" +
  /* Header */
  ".report-header{background:linear-gradient(135deg,#1a237e,#283593)!important;-webkit-print-color-adjust:exact;color:#fff!important;border-radius:8px;padding:20px 24px;margin-bottom:20px}" +
  ".report-header h1{color:#fff!important;font-size:16px!important}" +
  ".report-header p{color:rgba(255,255,255,.8)!important}" +
  ".report-header a{color:#fff!important;text-decoration:underline!important}" +
  ".aq-logo{-webkit-print-color-adjust:exact!important}" +
  /* Stats cards */
  ".stats-grid{display:grid!important;grid-template-columns:repeat(4,1fr)!important;gap:10px!important;margin-bottom:20px!important}" +
  ".stat-card{background:#f8f9fa!important;border:1px solid #dee2e6!important;border-radius:6px!important;padding:14px!important;text-align:center!important}" +
  ".stat-num{font-size:24px!important;font-weight:800!important}" +
  ".stat-lbl{font-size:10px!important;color:#666!important}" +
  /* Table */
  "table{background:#fff!important;border:1px solid #dee2e6!important;border-radius:6px!important;font-size:10px!important}" +
  "th{background:#1a237e!important;color:#fff!important;font-size:9px!important;padding:8px 10px!important}" +
  "td{border-bottom:1px solid #eee!important;padding:8px 10px!important;color:#333!important;font-size:10px!important}" +
  "td div,td span{color:#333!important}" +
  /* Liens cliquables */
  "a{color:#1a237e!important;text-decoration:underline!important}" +
  /* Statut badges */
  ".pass-text{color:#15803d!important}" +
  ".fail-text{color:#dc2626!important}" +
  /* Ticket context */
  ".ticket-context{background:#f8f9fa!important;border:1px solid #dee2e6!important;border-radius:6px!important;padding:16px!important;margin-bottom:16px!important;page-break-inside:avoid}" +
  ".ticket-context h2{color:#1a237e!important;font-size:13px!important}" +
  ".ticket-context p{color:#666!important}" +
  ".ctx-section{background:#f0f4ff!important;border-color:inherit!important}" +
  ".ctx-section div{color:#333!important}" +
  ".ctx-section strong{color:#1a1a2e!important}" +
  /* Anomalies */
  ".anomalies-section{background:#fff5f5!important;border:1px solid #feb2b2!important;border-radius:6px!important;padding:14px!important;page-break-before:always}" +
  ".anomalies-section h2{color:#c53030!important;font-size:12px!important}" +
  ".anomaly-card{background:#fff!important;border:1px solid #eee!important;border-left:3px solid #e53e3e!important;border-radius:4px!important;padding:12px!important;margin-bottom:10px!important;page-break-inside:avoid}" +
  ".anomaly-card div,.anomaly-card span,.anomaly-card pre{color:#333!important}" +
  /* Scenario cards */
  ".scenario-card{background:#f8f9fa!important;border:1px solid #dee2e6!important;border-radius:6px!important;padding:12px!important;margin-bottom:10px!important;page-break-inside:avoid}" +
  ".scenario-card div,.scenario-card span{color:#333!important}" +
  /* Screenshots — miniatures dans le tableau */
  "table img{max-width:100px!important;border:1px solid #ccc!important;border-radius:4px!important}" +
  /* Screenshots plein format dans la section dédiée */
  "#shots-section img,.shot-full img{max-width:100%!important;border:1px solid #ccc!important;border-radius:4px!important}" +
  /* Page breaks */
  "tr{page-break-inside:avoid}" +
  ".report-footer{color:#999!important;font-size:9px!important;margin-top:20px!important;border-top:1px solid #eee!important;padding-top:8px!important}" +
  "}";

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

/**
 * Construit la section SCÉNARIOS EXÉCUTÉS dans le rapport.
 * Utilise les vrais résultats d'exécution de SCENARIO_RESULTS.
 */
function buildScenariosHtml(scenarioResults) {
  if (!scenarioResults || scenarioResults.length === 0) return "";

  function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  var autoResults = scenarioResults.filter(function(s) { return s.type === "AUTO"; });
  var manuelResults = scenarioResults.filter(function(s) { return s.type === "MANUEL"; });
  var autoPass = autoResults.filter(function(s) { return s.pass === true; }).length;
  var autoTotal = autoResults.length;
  var scoreColor = autoTotal === 0 ? "#8892a4" : (autoPass === autoTotal ? "#00e87a" : autoPass >= autoTotal/2 ? "#f59e0b" : "#ff3b5c");

  var html = "<div style='margin-bottom:24px'>" +
    "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:14px'>" +
    "<h2 style='font-size:14px;margin:0;color:#8892a4'>SCÉNARIOS EXÉCUTÉS</h2>" +
    "<div style='font-family:monospace;font-size:13px;font-weight:700;color:" + scoreColor + "'>" +
    (autoTotal > 0 ? "Score : " + autoPass + "/" + autoTotal + " AUTO" : "Aucun scénario AUTO") +
    (manuelResults.length > 0 ? " + " + manuelResults.length + " MANUEL" : "") +
    "</div></div>";

  // Scénarios AUTO
  scenarioResults.forEach(function(sr) {
    var isAuto = sr.type === "AUTO";
    var badgeColor = isAuto ? "#00e87a" : "#f59e0b";
    var badgeLabel = isAuto ? "AUTO" : "MANUEL";
    var badgeBg = isAuto ? "rgba(0,232,122,.15)" : "rgba(245,158,11,.15)";

    var statusHtml = "";
    if (isAuto && sr.pass === true) {
      statusHtml = "<span style='font-weight:700;color:#00e87a;font-size:12px'>✅ PASS</span>";
    } else if (isAuto && sr.pass === false) {
      statusHtml = "<span style='font-weight:700;color:#ff3b5c;font-size:12px'>❌ FAIL</span>";
    } else if (!isAuto) {
      statusHtml = "<span style='color:#f59e0b;font-size:11px;font-weight:600'>⚠️ Vérification manuelle requise</span>";
    }

    // Bordure couleur selon résultat
    var borderColor = !isAuto ? "#f59e0b" : (sr.pass ? "#00e87a" : "#ff3b5c");

    html += "<div class='scenario-card' style='margin-bottom:12px;padding:14px;background:#111520;border:1px solid #1e2536;border-radius:8px;border-left:3px solid " + borderColor + ";page-break-inside:avoid'>" +
      "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'>" +
      "<div style='display:flex;align-items:center;gap:10px'>" +
      "<span style='font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700;font-family:monospace;background:" + badgeBg + ";color:" + badgeColor + "'>" + badgeLabel + "</span>" +
      "<span style='font-family:monospace;font-size:12px;color:#e2e8f0;font-weight:600'>" + esc(sr.titre) + "</span>" +
      "</div>" +
      statusHtml +
      "</div>";

    // Downgrade reason
    if (sr.downgradeReason) {
      html += "<div style='font-size:10px;color:#f59e0b;margin-bottom:6px;font-family:monospace'>⚠️ Scénario non couvert automatiquement — " + esc(sr.downgradeReason) + "</div>";
    }

    // Actions exécutées (pour AUTO)
    if (isAuto && sr.actionsExecuted && sr.actionsExecuted.length > 0) {
      html += "<div style='margin-bottom:6px'>";
      sr.actionsExecuted.forEach(function(a, ai) {
        var aColor = a.pass ? "#94a3b8" : "#ff3b5c";
        var aIcon = a.pass ? "✓" : "✗";
        html += "<div style='font-size:11px;color:" + aColor + ";padding:2px 0 2px 12px;font-family:monospace'>" +
          aIcon + " " + (ai+1) + ". " + esc(a.type) + " — " + esc(a.detail || a.error || "") + "</div>";
      });
      html += "</div>";
    }

    // Assertions vérifiées (pour AUTO)
    if (isAuto && sr.assertionsChecked && sr.assertionsChecked.length > 0) {
      html += "<div style='margin-bottom:6px;padding:8px 12px;background:rgba(100,116,139,.06);border-radius:4px'>" +
        "<div style='font-size:10px;color:#64748b;font-weight:700;margin-bottom:4px;font-family:monospace'>ASSERTIONS</div>";
      sr.assertionsChecked.forEach(function(a) {
        var aColor = a.pass ? "#00e87a" : "#ff3b5c";
        var aIcon = a.pass ? "✅" : "❌";
        html += "<div style='font-size:11px;color:" + aColor + ";padding:1px 0;font-family:monospace'>" +
          aIcon + " " + esc(a.type) + " " + esc(a.operator || "") + " " + esc(a.expected || "") +
          (!a.pass && a.error ? " <span style='color:#8892a4;font-size:10px'>— " + esc(a.error.substring(0, 80)) + "</span>" : "") +
          "</div>";
      });
      html += "</div>";
    }

    // Erreur globale
    if (sr.error && isAuto) {
      html += "<div style='font-size:11px;color:#ff3b5c;font-family:monospace;margin-top:4px'>Erreur : " + esc(sr.error.substring(0, 120)) + "</div>";
    }

    // Screenshot
    if (sr.screenshot) {
      html += "<div style='margin-top:8px'>" + reporterUtils.buildScreenshotHtml(sr.screenshot, null, SCREENSHOTS_DIR, { maxWidth:"180px", clickToZoom:true }) + "</div>";
    }

    html += "</div>";
  });

  html += "</div>";
  return html;
}

/**
 * Construit le HTML "Contexte du ticket" pour le rapport.
 * Parse la description Jira (wiki/texte) pour extraire les sections structurées.
 */
function buildTicketContextHtml(ticketInfo) {
  if (!ticketInfo) return "";
  // Pour un ticket Test, utiliser la description du parent (Bug/US) qui contient le vrai cas de test
  var contextKey, contextSummary, desc, contextType;
  if (ticketInfo.parentKey && ticketInfo.parentDescription) {
    contextKey = ticketInfo.parentKey;
    contextSummary = ticketInfo.parentSummary;
    contextType = ticketInfo.parentType || "Parent";
    desc = ticketInfo.parentDescription;
  } else {
    contextKey = ticketInfo.key;
    contextSummary = ticketInfo.summary;
    contextType = ticketInfo.type || "";
    desc = ticketInfo.description || "";
  }
  if (!desc) return "";
  // Essayer de charger le ticket enrichi (enrichedMarkdown plus lisible)
  var enrichedPath = path.join(BASE_DIR, "inbox", "enriched", contextKey + ".json");
  if (fs.existsSync(enrichedPath)) {
    try {
      var enriched = JSON.parse(fs.readFileSync(enrichedPath, "utf8"));
      if (enriched.enrichedMarkdown) desc = enriched.enrichedMarkdown;
      else if (enriched.originalMarkdown) desc = enriched.originalMarkdown;
    } catch(e) { /* fallback sur description Jira brute */ }
  }

  // Sections connues à extraire (titres Jira / markdown)
  var sections = [];
  var headingRe = /^#{1,3}\s+(.+)$/gm;
  var match;
  var lastIdx = 0, lastTitle = null;
  while ((match = headingRe.exec(desc)) !== null) {
    if (lastTitle !== null) {
      sections.push({ title: lastTitle, body: desc.substring(lastIdx, match.index).trim() });
    }
    lastTitle = match[1].trim();
    lastIdx = match.index + match[0].length;
  }
  if (lastTitle !== null) {
    sections.push({ title: lastTitle, body: desc.substring(lastIdx).trim() });
  }
  // Si pas de headings markdown, tenter le format wiki Jira (h3. Titre)
  if (sections.length === 0) {
    var wikiRe = /^h[1-3]\.\s+(.+)$/gm;
    lastIdx = 0; lastTitle = null;
    while ((match = wikiRe.exec(desc)) !== null) {
      if (lastTitle !== null) {
        sections.push({ title: lastTitle, body: desc.substring(lastIdx, match.index).trim() });
      }
      lastTitle = match[1].trim();
      lastIdx = match.index + match[0].length;
    }
    if (lastTitle !== null) {
      sections.push({ title: lastTitle, body: desc.substring(lastIdx).trim() });
    }
  }
  // Si toujours rien, afficher la description brute
  if (sections.length === 0) {
    sections.push({ title: "Description", body: desc });
  }

  // Filtrer les sections vides
  sections = sections.filter(function(s) { return s.body.trim().length > 0; });
  if (sections.length === 0) return "";

  // Fonction d'échappement HTML
  function esc(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Convertir markdown basique en HTML
  function mdToHtml(text) {
    return text.split("\n").map(function(line) {
      line = line.trim();
      if (!line) return "";
      // Listes à puces
      if (/^[-*]\s+/.test(line)) {
        return "<div style='padding:2px 0 2px 16px;font-size:12px;color:#cbd5e1'>• " + esc(line.replace(/^[-*]\s+/, "")) + "</div>";
      }
      // Listes numérotées
      if (/^\d+[.)]\s+/.test(line)) {
        return "<div style='padding:2px 0 2px 16px;font-size:12px;color:#cbd5e1'>" + esc(line) + "</div>";
      }
      // Gras **text** + liens https://
      var html = esc(line)
        .replace(/\*\*(.+?)\*\*/g, "<strong style='color:#e2e8f0'>$1</strong>")
        .replace(/(https?:\/\/[^\s&lt;]+)/g, "<a href='$1' style='color:#3b82f6;text-decoration:underline' target='_blank'>$1</a>");
      return "<div style='font-size:12px;color:#94a3b8;padding:1px 0'>" + html + "</div>";
    }).filter(Boolean).join("");
  }

  // Couleurs par type de section
  function sectionColor(title) {
    var t = title.toLowerCase();
    if (t.includes("reproduction") || t.includes("étape")) return { border: "#3b82f6", bg: "rgba(59,130,246,.06)", icon: "📋" };
    if (t.includes("attendu")) return { border: "#10b981", bg: "rgba(16,185,129,.06)", icon: "✅" };
    if (t.includes("obtenu") || t.includes("actuel")) return { border: "#ef4444", bg: "rgba(239,68,68,.06)", icon: "❌" };
    if (t.includes("correction") || t.includes("fix")) return { border: "#f59e0b", bg: "rgba(245,158,11,.06)", icon: "🔧" };
    if (t.includes("dépendance") || t.includes("link")) return { border: "#8b5cf6", bg: "rgba(139,92,246,.06)", icon: "🔗" };
    return { border: "#64748b", bg: "rgba(100,116,139,.06)", icon: "📄" };
  }

  var sectionsHtml = sections.map(function(s) {
    var c = sectionColor(s.title);
    return "<div class='ctx-section' style='margin-bottom:10px;padding:12px 16px;background:" + c.bg + ";border:1px solid " + c.border + "30;border-left:3px solid " + c.border + ";border-radius:6px'>" +
      "<div style='font-family:monospace;font-size:11px;font-weight:700;color:" + c.border + ";margin-bottom:6px;text-transform:uppercase'>" + c.icon + " " + esc(s.title) + "</div>" +
      mdToHtml(s.body) +
      "</div>";
  }).join("");

  // Sous-titre adapté : Bug direct vs Test → parent
  var subtitle = ticketInfo.parentKey
    ? "Cas de test du ticket parent " + esc(contextType) + " (source : " + esc(ticketInfo.key) + " " + esc(ticketInfo.type) + ")"
    : "Cas de test source du ticket " + esc(contextType);

  return "<div class='ticket-context' style='margin-bottom:28px;padding:20px;background:#111520;border:1px solid #1e2536;border-radius:10px'>" +
    "<h2 style='font-size:14px;margin:0 0 6px;color:#00d4ff;font-family:monospace'>" + esc(contextKey) + " — " + esc(contextSummary) + "</h2>" +
    "<p style='font-size:11px;color:#4a5568;margin:0 0 14px;font-family:monospace'>" + subtitle + "</p>" +
    sectionsHtml +
    "</div>";
}

function generateHTMLReport(allResults, mode, sourceLabel) {
  var pass=allResults.filter(function(r){return r.status==="PASS";}).length;
  var fail=allResults.filter(function(r){return r.status==="FAIL";}).length;
  var total=allResults.length;
  var pct=total>0?Math.round(pass/total*100):0;
  var date=new Date().toLocaleDateString("fr-FR");
  var pctColor=pct>=80?"#00e87a":pct>=50?"#ff9500":"#ff3b5c";

  var rows = allResults.map(function(r, idx) {
    var stepsDetail = (r.steps||[]).map(function(s) {
      var ico = s.status === "PASS" ? "✅" : "❌";
      var col = s.status === "PASS" ? "#00e87a" : "#ff3b5c";
      return "<div style='font-size:11px;padding:3px 0;color:" + col + ";font-family:monospace'>" + ico + " " +
        (s.label || "—") + (s.detail && s.status !== "PASS" ? " <span style='color:#8892a4;font-size:10px'>— " + (s.detail||"").substring(0,60) + "</span>" : "") + "</div>";
    }).join("");
    if (!stepsDetail) stepsDetail = "<span style='color:#4a5568;font-size:10px'>—</span>";
    // Miniature cliquable → ancre vers le screenshot en plein format
    var shotThumb = r.screenshot
      ? "<a href='#shot-" + idx + "' style='display:block'>" + reporterUtils.buildScreenshotHtml(r.screenshot, null, SCREENSHOTS_DIR, { maxWidth:"120px", clickToZoom:false }) + "</a>"
      : "<span style='color:#4a5568;font-size:10px'>—</span>";
    var urlLink = r.url ? "<a href='" + r.url + "' style='color:#00d4ff;text-decoration:none;font-size:10px' target='_blank'>" + (r.url||"").substring(0,60) + "</a>" : "";
    return "<tr style='border-bottom:1px solid #1e2536'>" +
      "<td style='padding:10px 14px;font-family:monospace;font-size:12px;color:#00d4ff;vertical-align:top'>"+((r.label||r.url).substring(0,50))+"<div style='margin-top:2px'>"+urlLink+"</div></td>" +
      "<td style='padding:10px 14px;font-size:11px;color:#8892a4;vertical-align:top'>"+(r.device||"—")+" / "+(r.browser||"—")+"</td>" +
      "<td style='padding:10px 14px;text-align:center;font-family:monospace;font-weight:700;color:"+(r.status==="PASS"?"#00e87a":"#ff3b5c")+";vertical-align:top'>"+(r.status==="PASS"?"✅ PASS":"❌ FAIL")+"</td>" +
      "<td style='padding:10px 14px;text-align:center;vertical-align:top'>"+(r.failType ? failTypeBadge(r.failType) : "<span style='color:#00e87a;font-size:11px'>—</span>")+"</td>" +
      "<td style='padding:10px 14px;vertical-align:top'>"+stepsDetail+"</td>" +
      "<td style='padding:10px 14px;font-size:11px;color:#8892a4;vertical-align:top'>"+(r.issues&&r.issues[0]?r.issues[0].substring(0,60):"—")+"</td>" +
      "<td style='padding:6px 10px;text-align:center;vertical-align:top'>"+shotThumb+"</td>" +
      "</tr>";
  }).join("");

  var failsSection = "";
  if (fail > 0) {
    failsSection = "<div class='anomalies-section' style='margin-top:24px;padding:16px 20px;background:rgba(255,59,92,.08);border:1px solid rgba(255,59,92,.25);border-radius:10px'>" +
      "<h2 style='font-size:13px;color:#ff3b5c;margin:0 0 12px'>❌ ANOMALIES (" + fail + ")</h2>" +
      allResults.filter(function(r){return r.status==="FAIL";}).map(function(r) {
        // ── Blocs diagnostics dev ───────────────────────────────────────────
        var devHtml = "";

        if (r.jsExceptions && r.jsExceptions.length) {
          devHtml += "<div style='margin-top:12px;padding:10px 12px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.25);border-radius:6px'>" +
            "<div style='font-family:monospace;font-size:10px;color:#ef4444;font-weight:700;margin-bottom:6px'>⚡ EXCEPTIONS JS (" + r.jsExceptions.length + ")</div>" +
            r.jsExceptions.map(function(ex) {
              return "<div style='font-size:11px;color:#fca5a5;margin-bottom:4px;font-weight:600'>" + ex.message + "</div>" +
                (ex.stack ? "<pre style='margin:2px 0 8px;font-size:10px;color:#8892a4;overflow-x:auto;white-space:pre-wrap;line-height:1.4'>" + ex.stack + "</pre>" : "");
            }).join("") +
          "</div>";
        }

        if (r.consoleErrors && r.consoleErrors.length) {
          devHtml += "<div style='margin-top:10px;padding:10px 12px;background:rgba(249,115,22,.07);border:1px solid rgba(249,115,22,.25);border-radius:6px'>" +
            "<div style='font-family:monospace;font-size:10px;color:#f97316;font-weight:700;margin-bottom:6px'>🖥️ ERREURS CONSOLE (" + r.consoleErrors.length + ")</div>" +
            r.consoleErrors.map(function(ce) {
              var loc = ce.file ? "<span style='color:#60a5fa;font-size:10px'>" + ce.file + (ce.line != null ? ":" + ce.line : "") + (ce.col != null ? ":" + ce.col : "") + "</span>  " : "";
              return "<div style='font-size:11px;color:#fdba74;margin-bottom:3px;font-family:monospace'>" + loc + ce.text + "</div>";
            }).join("") +
          "</div>";
        }

        if (r.networkFails && r.networkFails.length) {
          devHtml += "<div style='margin-top:10px;padding:10px 12px;background:rgba(139,92,246,.07);border:1px solid rgba(139,92,246,.25);border-radius:6px'>" +
            "<div style='font-family:monospace;font-size:10px;color:#a78bfa;font-weight:700;margin-bottom:6px'>🌐 REQUÊTES KO (" + r.networkFails.length + ")</div>" +
            r.networkFails.map(function(nf) {
              var sc = nf.status >= 500 ? "#ef4444" : "#f97316";
              return "<div style='font-size:11px;font-family:monospace;margin-bottom:2px'>" +
                "<span style='color:#8892a4'>" + nf.method + "</span>  " +
                "<span style='color:" + sc + ";font-weight:700'>" + nf.status + "</span>  " +
                "<span style='color:#94a3b8'>" + nf.url + "</span></div>";
            }).join("") +
          "</div>";
        }

        if (r.domSnippets && r.domSnippets.length) {
          devHtml += "<div style='margin-top:10px;padding:10px 12px;background:rgba(6,182,212,.07);border:1px solid rgba(6,182,212,.25);border-radius:6px'>" +
            "<div style='font-family:monospace;font-size:10px;color:#22d3ee;font-weight:700;margin-bottom:6px'>🔍 CONTEXTE DOM</div>" +
            r.domSnippets.map(function(ds) {
              return "<div style='margin-bottom:8px'>" +
                "<div style='font-size:11px;color:#94a3b8;margin-bottom:3px'><span style='color:#60a5fa'>" + ds.label + "</span>  <code style='color:#8892a4;font-size:10px'>" + ds.selector + "</code>" +
                (!ds.snippet.visible ? "  <span style='color:#ef4444;font-size:10px;font-weight:700'>⚠ ABSENT/CACHÉ</span>" : "") + "</div>" +
                "<pre style='margin:0;font-size:10px;color:#64748b;overflow-x:auto;white-space:pre-wrap;max-height:80px;line-height:1.3'>" + ds.snippet.outerHTML + "</pre>" +
              "</div>";
            }).join("") +
          "</div>";
        }

        return "<div class='anomaly-card' style='margin-bottom:16px;padding:14px;background:#111520;border-radius:8px;border-left:3px solid #ff3b5c'>" +
          "<div style='display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start'>" +
          "<div>" +
          "<div style='font-family:monospace;font-size:12px;font-weight:700;color:#ff3b5c;margin-bottom:6px'>"+(r.label||r.url)+"</div>" +
          (r.url ? "<div style='margin-bottom:6px'><a href='" + r.url + "' style='color:#00d4ff;font-size:10px;font-family:monospace;text-decoration:none' target='_blank'>" + r.url.substring(0,70) + "</a></div>" : "") +
          (r.issues||[]).map(function(i){return "<div style='font-size:12px;color:#8892a4;margin-bottom:3px'>• "+i+"</div>";}).join("") +
          "<div style='margin-top:8px'>" +
          (r.steps||[]).filter(function(s){return s.status==="FAIL";}).map(function(s){
            return "<div style='font-size:11px;color:#ff9500;font-family:monospace'>❌ "+s.label+" : "+s.detail+"</div>";
          }).join("") +
          "</div>" +
          devHtml +
          "</div>" +
          reporterUtils.buildScreenshotHtml(r.screenshot, null, SCREENSHOTS_DIR, { maxWidth:"220px", zoomWidth:"600px" }) +
          "</div></div>";
      }).join("") + "</div>";
  }

  // Lien Jira cliquable si KEY disponible
  var sourceLabelHtml = (KEY && /^[A-Z]+-\d+$/i.test(sourceLabel))
    ? "<a href='https://" + CFG.jira.host + "/browse/" + sourceLabel + "' style='color:#00d4ff;text-decoration:none' target='_blank'>" + sourceLabel + "</a>"
    : sourceLabel;

  var html = "<!DOCTYPE html><html lang='fr'><head><meta charset='UTF-8'><title>Rapport PW Direct — "+mode.toUpperCase()+"</title>" +
    "<link href='https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@400;600&display=swap' rel='stylesheet'>" +
    "<style>body{background:#0a0d14;color:#e2e8f0;font-family:'DM Sans',sans-serif;margin:0;padding:32px} h1,h2{font-family:'Space Mono',monospace} " +
    "table{width:100%;border-collapse:collapse;background:#111520;border:1px solid #1e2536;border-radius:10px;overflow:hidden} " +
    "th{padding:10px 14px;font-family:'Space Mono',monospace;font-size:10px;color:#4a5568;text-align:left;background:#171c2b;text-transform:uppercase} " +
    PRINT_CSS + "</style></head>" +
    "<body><div style='max-width:1100px;margin:0 auto'>" +
    "<div class='report-header' style='display:flex;align-items:center;gap:16px;margin-bottom:32px'>" +
    "<div class='aq-logo' style='background:linear-gradient(135deg,#3b6fff,#00d4ff);border-radius:10px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-weight:700;font-size:14px;color:#fff'>QA</div>" +
    "<div><h1 style='font-size:20px;margin:0'>Rapport Playwright Direct — <span style='color:#00d4ff'>"+mode.toUpperCase()+"</span></h1>" +
    "<p style='margin:4px 0 0;font-size:12px;color:#8892a4;font-family:monospace'>"+sourceLabelHtml+" · "+ENV_NAME+" · "+date+(DRY_RUN?" · <span style='color:#ff9500'>DRY RUN</span>":"")+"</p></div></div>" +
    "<div class='stats-grid' style='display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px'>" +
    "<div class='stat-card' style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid #00d4ff'><div class='stat-num' style='font-family:monospace;font-size:28px;font-weight:700;color:#00d4ff'>"+total+"</div><div class='stat-lbl' style='font-size:12px;color:#8892a4'>Total</div></div>" +
    "<div class='stat-card' style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid #00e87a'><div class='stat-num pass-text' style='font-family:monospace;font-size:28px;font-weight:700;color:#00e87a'>"+pass+"</div><div class='stat-lbl' style='font-size:12px;color:#8892a4'>PASS</div></div>" +
    "<div class='stat-card' style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid "+(fail>0?"#ff3b5c":"#00e87a")+"'><div class='stat-num fail-text' style='font-family:monospace;font-size:28px;font-weight:700;color:"+(fail>0?"#ff3b5c":"#00e87a")+"'>"+fail+"</div><div class='stat-lbl' style='font-size:12px;color:#8892a4'>FAIL</div></div>" +
    "<div class='stat-card' style='background:#111520;border:1px solid #1e2536;border-radius:10px;padding:18px;text-align:center;border-top:2px solid "+pctColor+"'><div class='stat-num' style='font-family:monospace;font-size:28px;font-weight:700;color:"+pctColor+"'>"+pct+"%</div><div class='stat-lbl' style='font-size:12px;color:#8892a4'>Qualité</div></div>" +
    "</div>" +
    buildTicketContextHtml(TICKET_INFO) +
    buildScenariosHtml(SCENARIO_RESULTS) +
    "<h2 style='font-size:14px;margin:0 0 12px;color:#8892a4'>RÉSULTATS PAR TEST</h2>" +
    "<table><thead><tr><th>Page / URL</th><th>Device / Browser</th><th>Statut</th><th>Catégorie</th><th>Étapes de contrôle</th><th>Problème</th><th>📸</th></tr></thead><tbody>"+rows+"</tbody></table>" +
    failsSection +
    // Section screenshots plein format
    (function() {
      var shots = allResults.filter(function(r) { return r.screenshot; });
      if (shots.length === 0) return "";
      return "<div style='margin-top:28px;page-break-before:always'>" +
        "<h2 style='font-size:14px;margin:0 0 16px;color:#8892a4'>📸 CAPTURES D'ÉCRAN</h2>" +
        shots.map(function(r, idx) {
          var realIdx = allResults.indexOf(r);
          var statusBadge = r.status === "PASS"
            ? "<span style='color:#00e87a;font-weight:700'>✅ PASS</span>"
            : "<span style='color:#ff3b5c;font-weight:700'>❌ FAIL</span>";
          var shotFull = reporterUtils.buildScreenshotHtml(r.screenshot, null, SCREENSHOTS_DIR, { maxWidth:"100%", clickToZoom:false });
          return "<div id='shot-" + realIdx + "' style='margin-bottom:24px;padding:16px;background:#111520;border:1px solid #1e2536;border-radius:10px;page-break-inside:avoid'>" +
            "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:10px'>" +
            "<div><span style='font-family:monospace;font-size:13px;color:#00d4ff;font-weight:700'>" + (r.label || r.url || "").substring(0, 60) + "</span>" +
            " <span style='font-size:11px;color:#4a5568;margin-left:8px'>" + (r.device || "") + " / " + (r.browser || "") + "</span></div>" +
            statusBadge + "</div>" +
            (r.url ? "<div style='margin-bottom:8px'><a href='" + r.url + "' style='color:#3b82f6;font-size:11px;font-family:monospace' target='_blank'>" + r.url + "</a></div>" : "") +
            "<div style='text-align:center'>" + shotFull + "</div>" +
            "</div>";
        }).join("") +
        "</div>";
    })() +
    "<p class='report-footer' style='font-size:11px;color:#4a5568;margin-top:24px;font-family:monospace'>Rapport généré automatiquement — test Playwright</p>" +
    "</div></body></html>";

  var prefix = fail===0 ? "RAPPORT-OK-PW-DIRECT-" : "RAPPORT-FAIL-PW-DIRECT-";
  var keySuffix = (KEY && /^[A-Z]+-\d+$/i.test(KEY)) ? "-" + KEY.toUpperCase() : "";
  var ts = Date.now();
  var reportPath = path.join(REPORTS_DIR, prefix + mode.toUpperCase() + "-" + ts + keySuffix + ".html");
  fs.writeFileSync(reportPath, html, "utf8");
  return reportPath;
}

/**
 * Convertit un rapport HTML en PDF via Playwright.
 * @param {string} htmlPath — chemin absolu du fichier HTML
 * @returns {string|null} chemin du PDF généré, ou null en cas d'erreur
 */
async function convertHtmlToPdf(htmlPath) {
  var pdfPath = htmlPath.replace(/\.html$/, ".pdf");
  try {
    console.log("[PDF] Conversion du rapport en PDF...");
    var browser = await chromium.launch();
    var page = await browser.newPage();
    // Émuler le media print pour activer le thème clair
    await page.emulateMedia({ media: "print" });
    await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "networkidle" });

    var headerHtml = "<div style='width:100%;font-family:Arial,sans-serif;font-size:8px;color:#999;display:flex;justify-content:space-between;padding:0 12px'>" +
      "<span style='font-weight:700;color:#1a237e'>Rapport de test</span>" +
      "<span>" + new Date().toLocaleDateString("fr-FR") + "</span>" +
      "</div>";
    var footerHtml = "<div style='width:100%;font-family:Arial,sans-serif;font-size:8px;color:#999;display:flex;justify-content:space-between;padding:0 12px'>" +
      "<span>Rapport généré automatiquement</span>" +
      "<span>Page <span class='pageNumber'></span> / <span class='totalPages'></span></span>" +
      "</div>";

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerHtml,
      footerTemplate: footerHtml,
      margin: { top: "40px", bottom: "40px", left: "24px", right: "24px" }
    });
    await browser.close();
    console.log("[PDF] " + path.basename(pdfPath));
    return pdfPath;
  } catch(e) {
    console.log("[PDF] Erreur conversion : " + e.message.substring(0, 80));
    return null;
  }
}

function generateComparisonReport(allEnvResults, mode) {
  var envNames = allEnvResults.map(function(e) { return e.envName; });
  var date = new Date().toLocaleDateString("fr-FR");

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
      var shotHtml = failR && failR.screenshot ? "<br>" + reporterUtils.buildScreenshotHtml(failR.screenshot, null, SCREENSHOTS_DIR, { maxWidth:"90px", zoomWidth:"500px" }) : "";
      return "<td style='padding:10px 14px;color:" + color + ";font-family:monospace;font-weight:700;font-size:12px;vertical-align:top'>" + label + badge + issue + shotHtml + "</td>";
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
    "th{padding:10px 14px;font-family:'Space Mono',monospace;font-size:10px;color:#4a5568;text-align:left;background:#171c2b;text-transform:uppercase} " +
    PRINT_CSS + "</style></head>" +
    "<body><div style='max-width:1200px;margin:0 auto'>" +
    "<div class='report-header' style='display:flex;align-items:center;gap:16px;margin-bottom:28px'>" +
    "<div class='aq-logo' style='background:linear-gradient(135deg,#3b6fff,#00d4ff);border-radius:10px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-family:monospace;font-weight:700;font-size:14px;color:#fff'>QA</div>" +
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
    "<p style='font-size:11px;color:#4a5568;margin-top:24px;font-family:monospace'>Rapport généré automatiquement — test Playwright (comparaison multi-env)</p>" +
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
  console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "resolve", message: "Résolution des cibles...", pct: 5 }));
  var targets = MODE === "tnr" ? getTNRPages() : await resolveTargets();
  console.log("[CIBLES] " + targets.length + " URL(s)");
  console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "targets", message: targets.length + " URL(s) à tester", pct: 10, targets: targets.map(function(t) { return t.label || t.url; }) }));

  // ── EXÉCUTION DES SCÉNARIOS (si ticket Jira) ──────────────────────────────
  if (KEY && SOURCE === "jira-key" && MODE !== "tnr") {
    console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "scenarios", message: "Chargement des scénarios...", pct: 15 }));
    try {
      SCENARIO_RESULTS = await runScenarios(targets, ENV_NAME);
      if (SCENARIO_RESULTS.length > 0) {
        var autoR = SCENARIO_RESULTS.filter(function(s) { return s.type === "AUTO"; });
        var autoP = autoR.filter(function(s) { return s.pass === true; }).length;
        var manR = SCENARIO_RESULTS.filter(function(s) { return s.type === "MANUEL"; });
        console.log("[SCENARIOS] " + autoP + "/" + autoR.length + " AUTO PASS" + (manR.length > 0 ? " + " + manR.length + " MANUEL" : ""));
        console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "scenarios-done", message: autoP + "/" + autoR.length + " scénarios PASS", pct: 25 }));
      }
    } catch(e) {
      console.log("[SCENARIOS] Erreur : " + e.message.substring(0, 80));
    }
  }

  var allResults = [];
  var totalTests = BROWSERS.length * DEVICES.length * targets.length;
  var testIdx = 0;
  for (var bi = 0; bi < BROWSERS.length; bi++) {
    for (var di = 0; di < DEVICES.length; di++) {
      var bn = BROWSERS[bi]; var dev = DEVICES[di];
      var BT = BROWSER_MAP[bn] || chromium;
      console.log("\n[" + bn + " | " + dev.name + "] — " + targets.length + " cible(s)");
      for (var ti = 0; ti < targets.length; ti++) {
        var tgt = targets[ti];
        testIdx++;
        var testPct = Math.round(25 + (testIdx / totalTests) * 60);
        console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "test", current: testIdx, total: totalTests, pct: testPct, label: (tgt.label||tgt.url).substring(0,60), browser: bn, device: dev.name }));
        process.stdout.write("  [" + (ti+1) + "/" + targets.length + "] " + (tgt.label||tgt.url).substring(0,40) + "... ");
        var r = await runTest(tgt, BT, dev, bn, MODE);
        console.log(r.status + (r.issues.length ? " — " + r.issues[0].substring(0,50) : ""));
        console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "test-done", current: testIdx, total: totalTests, pct: testPct, status: r.status, label: (tgt.label||tgt.url).substring(0,60) }));
        allResults.push(r);
      }
    }
  }

  var pass=allResults.filter(function(r){return r.status==="PASS";}).length;
  var fail=allResults.filter(function(r){return r.status==="FAIL";}).length;
  var total=allResults.length;
  var pct=total>0?Math.round(pass/total*100):0;

  console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "report", message: "Génération du rapport...", pct: 90 }));
  var sourceLabel = SOURCE==="jira-key"&&KEY?KEY : SOURCE==="xml"?(XML_FILE||"xml") : SOURCE==="text"?"texte libre" : (URLS_RAW||"url");
  var reportPath = generateHTMLReport(allResults, MODE, sourceLabel);
  console.log("\n[RAPPORT HTML] " + path.basename(reportPath));

  // Conversion HTML → PDF
  var pdfPath = await convertHtmlToPdf(reportPath);
  console.log("PLAYWRIGHT_PROGRESS:" + JSON.stringify({ step: "done", message: pass + "/" + total + " PASS (" + pct + "%)", pct: 100, pass: pass, fail: fail, total: total, reportPath: path.basename(reportPath), pdfPath: pdfPath ? path.basename(pdfPath) : null }));

  var bugKeys = [];
  var fails = allResults.filter(function(r){return r.status==="FAIL";});
  if (fails.length > 0 && NO_JIRA_PUSH) {
    console.log("\n[INFO] " + fails.length + " FAIL(s) — pas de création de bugs Jira (--no-jira-push)");
  }
  if (fails.length > 0 && !NO_JIRA_PUSH) {
    console.log("\n[BUGS] " + fails.length + " FAIL(s)...");
    for (var i = 0; i < fails.length; i++) {
      var k = await createBugJira(fails[i], MODE);
      if (k) bugKeys.push(k);
      // Émettre le log de test pour chaque FAIL (capturé par agent-server.js)
      if (fails[i].status === "FAIL") {
        console.log("PLAYWRIGHT_TEST_LOG:" + JSON.stringify({
          ticketKey:    KEY || null,
          testLabel:    fails[i].label,
          url:          fails[i].url,
          env:          fails[i].env,
          mode:         MODE,
          browser:      fails[i].browser,
          device:       fails[i].device,
          issues:       fails[i].issues || [],
          steps:        (fails[i].steps||[]).filter(function(s){return s.status==="FAIL";}).map(function(s){ return { label:s.label, detail:s.detail, selector:s.selector||null }; }),
          jsExceptions: fails[i].jsExceptions  || [],
          consoleErrors:fails[i].consoleErrors || [],
          networkFails: fails[i].networkFails  || [],
          domSnippets:  (fails[i].domSnippets||[]).map(function(ds){ return { selector:ds.selector, label:ds.label, visible:ds.snippet.visible, outerHTML:ds.snippet.outerHTML }; }),
          screenshot:   fails[i].screenshot ? require("path").basename(fails[i].screenshot) : null,
          timestamp:    new Date().toISOString()
        }));
      }
    }
  }

  // Résumé scénarios pour le JSON
  var scenarioSummary = null;
  if (SCENARIO_RESULTS.length > 0) {
    var sAuto = SCENARIO_RESULTS.filter(function(s) { return s.type === "AUTO"; });
    var sAutoPass = sAuto.filter(function(s) { return s.pass === true; }).length;
    var sManuel = SCENARIO_RESULTS.filter(function(s) { return s.type === "MANUEL"; });
    scenarioSummary = { autoPass: sAutoPass, autoTotal: sAuto.length, manuelTotal: sManuel.length, total: SCENARIO_RESULTS.length };
  }
  console.log("PLAYWRIGHT_DIRECT_RESULT:" + JSON.stringify({ pass:pass, fail:fail, total:total, pct:pct, mode:MODE, env:ENV_NAME, reportPath:path.basename(reportPath), pdfPath: pdfPath ? path.basename(pdfPath) : null, bugs:bugKeys, dryRun:DRY_RUN, ticketKey: KEY || null, ticketType: (TICKET_INFO && TICKET_INFO.type) || null, scenarios: scenarioSummary }));
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
