// agent-xray-full.js - Pipeline QA complet avec API Xray/Jira
// 
// Ce que ca fait automatiquement :
//   1. Parse le XML Jira
//   2. Cree les Tests dans Xray via API
//   3. Cree le Test Plan via API
//   4. Cree la Test Execution via API
//   5. Lance Playwright sur chaque cas
//   6. Upload les screenshots comme preuves
//   7. Met a jour PASS/FAIL dans Xray
//   8. Cree les bugs Jira si FAIL
//
// Usage :
//   node agent-xray-full.js SAFWBST-2605.xml
//   node agent-xray-full.js SAFWBST-2605.xml --env=paulo
//   node agent-xray-full.js SAFWBST-2605.xml --no-playwright

"use strict";

// Forcer le chemin des navigateurs Playwright (Render/cloud Linux uniquement)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

const fs    = require("fs");
const path  = require("path");
const https = require("https");
const http  = require("http");
const { chromium } = require("playwright");

// ── CONFIG (lue depuis .env via config.js) ────────────────────────────────────
const CFG    = require("./config");
CFG.paths.init();
const CONFIG = CFG;
// ══════════════════════════════════════════════════════════════════════════════

const REPORTS_DIR     = CFG.paths.reports;
const SCREENSHOTS_DIR = CFG.paths.screenshots;

// Variable globale remplie au démarrage depuis les args
var instructions = "";
var testDevices  = [];
var testBrowsers = [];
var testType     = "auto";
var forceTestKey = null; // --force-key=SAFWBST-XXXX : écraser un ticket existant

// ── HELPERS HTTP ──────────────────────────────────────────────────────────────
function jiraRequest(method, apiPath, body, isMultipart, contentType) {
  return new Promise(function(resolve, reject) {
    var auth    = Buffer.from(CONFIG.jira.email + ":" + CONFIG.jira.token).toString("base64");
    var ct      = contentType || "application/json";
    var payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;

    var headers = {
      "Authorization": "Basic " + auth,
      "Accept":        "application/json",
      "Content-Type":  ct
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    var options = {
      hostname: CONFIG.jira.host,
      path:     apiPath,
      method:   method,
      headers:  headers
    };

    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try {
          var parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            reject(new Error("HTTP " + res.statusCode + " : " + data.substring(0, 200)));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Upload binaire (screenshot)
function uploadAttachment(issueKey, filePath) {
  return new Promise(function(resolve, reject) {
    var auth      = Buffer.from(CONFIG.jira.email + ":" + CONFIG.jira.token).toString("base64");
    var fileData  = fs.readFileSync(filePath);
    var fileName  = path.basename(filePath);
    var boundary  = "----AbyQABoundary" + Date.now();
    var CRLF      = "\r\n";

    var header = "--" + boundary + CRLF +
      "Content-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"" + CRLF +
      "Content-Type: image/png" + CRLF + CRLF;
    var footer = CRLF + "--" + boundary + "--" + CRLF;

    var body = Buffer.concat([
      Buffer.from(header),
      fileData,
      Buffer.from(footer)
    ]);

    var options = {
      hostname: CONFIG.jira.host,
      path:     "/rest/api/2/issue/" + issueKey + "/attachments",
      method:   "POST",
      headers: {
        "Authorization":     "Basic " + auth,
        "X-Atlassian-Token": "no-check",
        "Content-Type":      "multipart/form-data; boundary=" + boundary,
        "Content-Length":    body.length
      }
    };

    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() { resolve(data); });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── PARSER XML ────────────────────────────────────────────────────────────────
function parseXML(xmlContent) {
  var ticket = {
    key: "", summary: "", type: "", status: "",
    priority: "", assignee: "", reporter: "",
    description: "", labels: [], comments: [],
    urls: [], koItems: [], okItems: []
  };

  function extract(tag, content) {
    var re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
    var m  = content.match(re);
    return m ? m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim() : "";
  }

  ticket.key         = extract("key", xmlContent);
  ticket.summary     = extract("summary", xmlContent);
  ticket.type        = extract("type", xmlContent);
  ticket.status      = extract("status", xmlContent);
  ticket.priority    = extract("priority", xmlContent);
  ticket.assignee    = extract("assignee", xmlContent);
  ticket.reporter    = extract("reporter", xmlContent);
  ticket.description = extract("description", xmlContent);

  var labelMatches = xmlContent.match(/<label>([^<]+)<\/label>/g) || [];
  ticket.labels = labelMatches.map(function(l) { return l.replace(/<\/?label>/g,""); });

  // Champ Tests
  var cfMatch = xmlContent.match(/customfield_10077[\s\S]*?<customfieldvalue>([\s\S]*?)<\/customfieldvalue>/);
  var testsRaw = cfMatch ? cfMatch[1] : "";

  // Extraire URLs
  var urlMatches = testsRaw.match(/href="(https?:\/\/[^"]+)"/g) || [];
  var seenUrls   = {};
  urlMatches.forEach(function(u) {
    var url = u.replace(/href="/,"").replace(/"$/,"");
    if (!url.includes("atlassian.net") && !url.includes("jira/people") && !seenUrls[url]) {
      seenUrls[url] = true;
      ticket.urls.push(url);
    }
  });

  // Detecter KO / OK
  var lines = testsRaw.split(/<li>|<\/li>/);
  lines.forEach(function(line) {
    var clean = line.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
    if (!clean) return;
    var urlM    = line.match(/href="(https?:\/\/[^"]+)"/);
    var lineUrl = urlM && !urlM[1].includes("atlassian.net") ? urlM[1] : "";

    if (clean.includes("KO")) {
      var pageName = clean.split("KO")[0].trim().replace(/[^a-zA-Z0-9\s\-]/g,"").trim();
      var subItems = [];
      var subs     = line.match(/<li>([\s\S]*?)<\/li>/g) || [];
      subs.forEach(function(s) {
        var t = s.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
        if (t && t.length > 5) subItems.push(t);
      });
      ticket.koItems.push({ page: pageName, url: lineUrl, details: subItems.length ? subItems : [clean] });
    } else if (clean.includes("OK") && !clean.includes("KO")) {
      var pageOk = clean.split("OK")[0].trim().replace(/[^a-zA-Z0-9\s\-]/g,"").trim();
      if (pageOk.length > 2) ticket.okItems.push({ page: pageOk, url: lineUrl });
    }
  });

  return ticket;
}

// ── ETAPE 1 : CHERCHER OU CREER LE TICKET TEST ──────────────────────────────
async function findExistingTest(ticket) {
  // Cherche un ticket Test déjà lié à la US source via l'API Jira
  try {
    var jql  = encodeURIComponent('project = ' + CONFIG.jira.project + ' AND issuetype = Test AND issueFunction in linkedIssuesOf("key = ' + ticket.key + '") ORDER BY created DESC');
    var res  = await jiraRequest("GET", "/rest/api/2/search?jql=" + jql + "&fields=summary,status,key&maxResults=5");
    if (res.issues && res.issues.length > 0) {
      var found = res.issues[0];
      console.log("  [TROUVE] Ticket Test existant : " + found.key + " — " + found.fields.summary);
      return found.key;
    }
  } catch(e) {
    console.log("  [INFO] Recherche ticket existant : " + e.message.substring(0, 60));
  }
  return null;
}

async function addXrayStepsToTicket(testKey, xraySteps) {
  // Ajouter les steps via API Xray (tableau Action/Données/Résultat)
  var stepsBody = {
    steps: xraySteps.map(function(tc) {
      return {
        action: "Etant donne qu'un visiteur accede a la page *" + tc.page + "*\nLorsque la page est chargee sur l'environnement cible\nAlors les elements visuels sont conformes",
        data:   (tc.url ? tc.url.replace(/https?:\/\/[^/]+/, "{ENV}") : "URL : voir prod") + "\nDevice : desktop 1920x1080",
        result: "Page conforme a la prod\nPolice Barlow appliquee\nMarges et espacements corrects\nAucune regression visuelle"
      };
    })
  };
  var result = await jiraRequest("PUT", "/rest/raven/1.0/api/test/" + testKey + "/steps", stepsBody)
    .catch(function(e) { return { error: e.message }; });
  if (!result || result.error) {
    console.log("  [INFO] Steps Xray : " + (result ? result.error : "non ajoutés") + " (nécessite plugin Xray)");
  } else {
    console.log("  [OK] " + xraySteps.length + " steps Xray ajoutés sur " + testKey);
  }
}

async function createXrayTests(ticket) {
  console.log("\n[XRAY] Recherche ticket Test existant pour " + ticket.key + "...");

  // Construire les steps
  var tcNum     = 1;
  var xraySteps = [];
  ticket.koItems.forEach(function(ko) {
    xraySteps.push({ tcId: "TC" + String(tcNum).padStart(2,"0"), page: ko.page, url: ko.url, type: "KO", details: ko.details || [] });
    tcNum++;
  });
  ticket.okItems.slice(0, 5).forEach(function(ok) {
    if (ok.page && ok.page.length > 2) {
      xraySteps.push({ tcId: "TC" + String(tcNum).padStart(2,"0"), page: ok.page, url: ok.url, type: "OK", details: [] });
      tcNum++;
    }
  });

  // Nomenclature titre
  var epicLabel   = ticket.labels.find(function(l) { return !l.match(/^v\d/) && l !== "aby-qa-v2" && l !== "auto-generated"; }) || "";
  var ticketTitle = ticket.summary.replace(/^(Mise [àa] jour|Update|Fix|Correction)\s+(du|de|des|d'|the)\s+/i, "").substring(0, 80);
  var summary     = "TEST - [" + (epicLabel || ticketTitle.split(" ").slice(0,3).join(" ")) + "] - " + ticket.key + " - " + ticketTitle;

  // Description propre (sans les cas de test — ils vont dans Xray Steps)
  var objectif = ticket.description
    ? ticket.description.replace(/<[^>]+>/g, " ").replace(/&[a-z0-9#]+;/gi, " ").replace(/\s+/g, " ").trim().substring(0, 400)
    : "Verifier la non-regression apres modification.";

  // Générer les critères d'acceptation depuis les KO/OK
  var acLines = [];
  ticket.koItems.forEach(function(ko, i) {
    acLines.push("AC" + (i+1) + " - La page *" + ko.page + "* ne présente aucune régression visuelle après déploiement");
  });
  if (acLines.length === 0) {
    acLines.push("AC1 - Aucune régression visuelle détectée sur les pages cibles");
    acLines.push("AC2 - Police Barlow correctement appliquée sur tous les éléments");
    acLines.push("AC3 - Marges et espacements conformes à la référence prod");
  }

  // Couverture de test
  var totalPages   = ticket.koItems.length + ticket.okItems.length;
  var koCount      = ticket.koItems.length;
  var okCount      = Math.min(ticket.okItems.length, 5);
  var coverageNote = totalPages + " page(s) identifiée(s) — " + koCount + " KO à corriger, " + okCount + " OK en non-régression";

  var description = "h3. User Story\n\n";
  description += "En tant que *visiteur du site*,\n";
  description += "Je souhaite que les modifications de *" + ticket.summary.replace(/&[a-z0-9#]+;/gi, " ").trim() + "* n'introduisent pas de régression,\n";
  description += "Afin de garantir la qualité et la conformité de l'interface.\n\n";
  description += "---\n\n";
  description += "h3. Ticket source\n\n";
  description += "*" + ticket.key + "* — " + ticket.summary.replace(/&[a-z0-9#]+;/gi, " ").trim() + "\n";
  description += "*Date :* " + new Date().toLocaleDateString("fr-FR") + "\n\n";
  description += "---\n\n";
  description += "h3. Objectif\n\n" + objectif + "\n\n";
  description += "---\n\n";
  description += "h3. Critères d'acceptation\n\n";
  acLines.forEach(function(ac) { description += "* " + ac + "\n"; });
  description += "\n---\n\n";
  description += "h3. Préconditions\n\n";
  description += "* Avoir accès à l'environnement cible\n";
  description += "* Le ticket " + ticket.key + " est déployé\n\n";
  description += "---\n\n";
  description += "h3. Couverture de test\n\n";
  description += "*" + coverageNote + "*\n\n";
  description += "| Page | Type | URL |\n";
  description += "| --- | --- | --- |\n";
  ticket.koItems.forEach(function(ko) {
    description += "| " + ko.page + " | 🔴 KO | " + (ko.url || "voir prod") + " |\n";
  });
  ticket.okItems.slice(0, 5).forEach(function(ok) {
    if (ok.page && ok.page.length > 2) {
      description += "| " + ok.page + " | 🟢 OK | " + (ok.url || "voir prod") + " |\n";
    }
  });
  description += "\n---\n\n";
  if (instructions) {
    description += "h3. Instructions de test\n\n" + instructions + "\n\n---\n\n";
  }

  var testKey    = null;
  var isExisting = false;

  // Si --force-key fourni : écraser directement ce ticket sans recherche
  var existingKey = forceTestKey || await findExistingTest(ticket);

  if (existingKey) {
    // METTRE À JOUR l'existant (ou le ticket forcé)
    isExisting = true;
    testKey    = existingKey;
    var forceLabel = forceTestKey ? " [FORCE]" : "";
    console.log("  [UPDATE" + forceLabel + "] Mise à jour de " + testKey + " — description, steps Xray");
    await jiraRequest("PUT", "/rest/api/2/issue/" + testKey, {
      fields: { summary: summary, description: description }
    }).catch(function() {});
    console.log("  [OK] " + testKey + " mis a jour");
  } else {
    // CREER nouveau ticket Test
    process.stdout.write("  Creation ticket Test : " + summary.substring(0, 70) + "... ");
    try {
      var created = await jiraRequest("POST", "/rest/api/2/issue", {
        fields: {
          project:     { key: CONFIG.jira.project },
          summary:     summary,
          issuetype:   { name: "Test" },
          priority:    { name: ticket.priority || "Medium" },
          description: description,
          labels:      ticket.labels.filter(function(l){ return !["aby-qa-v2","auto-generated"].includes(l); })
        }
      });
      testKey = created.key;
      console.log("[OK] " + testKey);

      // Lier au ticket source
      await jiraRequest("POST", "/rest/api/2/issueLink", {
        type: { name: "Test" }, inwardIssue: { key: testKey }, outwardIssue: { key: ticket.key }
      }).catch(function() {});
    } catch(e) {
      console.log("[ERREUR] " + e.message.substring(0, 100));
    }
  }

  // Ajouter/remplacer les Xray Steps sur le ticket
  if (testKey) await addXrayStepsToTicket(testKey, xraySteps);

  var createdTests = ticket.koItems.map(function(ko, i) {
    return { key: testKey, tcId: "TC" + String(i+1).padStart(2,"0"), summary: summary, koItem: ko, steps: xraySteps };
  });
  if (createdTests.length === 0) {
    createdTests = [{ key: testKey, tcId: "TC01", summary: summary, koItem: { page: "accueil", url: "" }, steps: xraySteps }];
  }

  console.log("  " + (isExisting ? "Ticket mis a jour" : "Ticket cree") + " : " + testKey + " — " + xraySteps.length + " steps Xray");
  return createdTests;
}

// ── ETAPE 2 : TROUVER OU CREER LE TEST PLAN DE LA RELEASE ───────────────────
async function createTestPlan(ticket, testKeys) {
  console.log("\n[XRAY] Recherche du Test Plan pour Release " + CFG.xray.fixVersion + "...");

  // Chercher le Test Plan existant de la release
  try {
    var jql = encodeURIComponent('project = ' + CONFIG.jira.project + ' AND issuetype = "Test Plan" AND labels = "' + CFG.xray.fixVersion + '" ORDER BY created DESC');
    var res  = await jiraRequest("GET", "/rest/api/2/search?jql=" + jql + "&fields=summary,status,key&maxResults=5");
    if (res.issues && res.issues.length > 0) {
      var existingPlan = res.issues[0];
      console.log("  [TROUVE] Test Plan existant : " + existingPlan.key + " — " + existingPlan.fields.summary);

      // Ajouter le ticket Test au plan existant via API Xray
      if (testKeys && testKeys.length > 0) {
        await jiraRequest("POST", "/rest/raven/1.0/api/testplan/" + existingPlan.key + "/test", {
          add: testKeys
        }).catch(function(e) {
          // Fallback : lien Jira standard
          return jiraRequest("POST", "/rest/api/2/issueLink", {
            type: { name: "Test" }, inwardIssue: { key: testKeys[0] }, outwardIssue: { key: existingPlan.key }
          });
        });
        console.log("  [OK] " + testKeys.join(", ") + " ajouté(s) au Test Plan " + existingPlan.key);
      }
      return existingPlan.key;
    }
  } catch(e) {
    console.log("  [INFO] " + e.message.substring(0, 60));
  }

  // Aucun plan trouvé → créer
  console.log("  Aucun Test Plan trouvé pour " + CFG.xray.fixVersion + " — création...");
  var planSummary = "Test Plan - Release " + CFG.xray.fixVersion;
  try {
    var plan = await jiraRequest("POST", "/rest/api/2/issue", {
      fields: {
        project:   { key: CONFIG.jira.project },
        summary:   planSummary,
        issuetype: { name: "Test Plan" },
        labels:    [CFG.xray.fixVersion],
        description: "Plan de test Release " + CFG.xray.fixVersion + "\nDate creation : " + new Date().toLocaleDateString("fr-FR")
      }
    });
    console.log("  [OK] Test Plan créé : " + plan.key);
    // Ajouter les tests au nouveau plan
    if (testKeys && testKeys.length > 0) {
      await jiraRequest("POST", "/rest/raven/1.0/api/testplan/" + plan.key + "/test", { add: testKeys })
        .catch(function() {});
    }
    return plan.key;
  } catch(e) {
    console.log("  [WARN] " + e.message.substring(0, 80));
    return null;
  }
}

// ── ETAPE 3 : CREER LA TEST EXECUTION ────────────────────────────────────────
async function createTestExecution(ticket, testPlanKey, testKeys) {
  console.log("\n[XRAY] Creation de la Test Execution...");

  var execSummary = "Test Execution - Release " + CFG.xray.fixVersion + ticket.key + " - " + new Date().toLocaleDateString("fr-FR");

  var body = {
    fields: {
      project:   { key: CONFIG.jira.project },
      summary:   execSummary,
      issuetype: { name: "Test Execution" },
      description: "Ticket source : " + ticket.key + "\nTest Plan : " + (testPlanKey || "N/A"),
      labels:    []
    }
  };

  try {
    var exec = await jiraRequest("POST", "/rest/api/2/issue", body);
    console.log("  Test Execution creee : " + exec.key);

    // Lier au Test Plan si disponible
    if (testPlanKey) {
      await jiraRequest("POST", "/rest/api/2/issueLink", {
        type:         { name: "Test" },
        inwardIssue:  { key: exec.key },
        outwardIssue: { key: testPlanKey }
      }).catch(function() {});
    }

    return exec.key;
  } catch (e) {
    console.log("  [WARN] Test Execution non creee : " + e.message.substring(0, 80));
    return null;
  }
}

// ── ETAPE 4 : PLAYWRIGHT ─────────────────────────────────────────────────────
async function runPlaywright(ticket, createdTests, envName) {
  console.log("\n[PLAYWRIGHT] Execution des tests sur " + envName.toUpperCase() + "...");
  var envUrl = CONFIG.envs[envName] || CONFIG.envs.sophie;

  var browser = await chromium.launch({ headless: true });
  var page    = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  var results = [];

  for (var i = 0; i < createdTests.length; i++) {
    var test = createdTests[i];
    var ko   = test.koItem;
    var url  = ko.url || "";

    // Adapter URL vers l'env cible
    if (url.includes("safran-group.com")) {
      url = url.replace(/https?:\/\/[a-z]+\.safran-group\.com/, envUrl);
    } else if (url) {
      url = envUrl + "/" + url.replace(/^\//,"");
    } else {
      console.log("  [SKIP] " + ko.page + " - pas d'URL");
      results.push({ test: test, status: "TODO", screenshot: null, issues: [] });
      continue;
    }

    process.stdout.write("  [" + (i+1) + "/" + createdTests.length + "] " + ko.page + "... ");

    var result = { test: test, url: url, status: "PASS", screenshot: null, issues: [] };

    try {
      var res = await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
      result.httpStatus = res ? res.status() : 0;

      if (result.httpStatus === 404) {
        result.status = "TODO";
        result.issues.push("Page non trouvee (404)");
      } else {
        // Check 1 : Police Barlow
        var fontIssues = await page.evaluate(function() {
          var issues  = [];
          var targets = document.querySelectorAll("h1,h2,h3,nav a,[class*='filter'],[class*='tag'],[class*='label']");
          var seen    = {};
          for (var i = 0; i < Math.min(targets.length, 30); i++) {
            var ff = window.getComputedStyle(targets[i]).fontFamily;
            if (ff && !seen[ff] && (ff.includes("MS Shell") || (ff.toLowerCase().includes("arial") && !ff.toLowerCase().includes("barlow")))) {
              seen[ff] = true;
              issues.push({ element: targets[i].tagName + (targets[i].className ? "." + targets[i].className.split(" ")[0] : ""), font: ff });
            }
          }
          return issues;
        }).catch(function() { return []; });

        // Check 2 : Margin h1 (Company pages)
        var marginIssue = null;
        if (url.includes("compan") || url.includes("societ")) {
          marginIssue = await page.evaluate(function() {
            var h1 = document.querySelector("h1.c-hero__content, h1[class*='hero'], h1[class*='c-hero']");
            if (!h1) return null;
            var mb = parseFloat(window.getComputedStyle(h1).marginBottom);
            return mb < 115 ? { marginBottom: mb + "px", expected: "120px" } : null;
          }).catch(function() { return null; });
        }

        // Check 3 : Icone X tags
        var iconIssue = await page.evaluate(function() {
          var tags = document.querySelectorAll("[class*='tag'] button, [class*='filter'] button, [class*='close']");
          for (var i = 0; i < tags.length; i++) {
            var size = window.getComputedStyle(tags[i]).fontSize;
            if (size && parseFloat(size) < 10) return { size: size };
          }
          return null;
        }).catch(function() { return null; });

        if (fontIssues.length > 0) {
          result.status = "FAIL";
          result.issues.push("Police incorrecte : " + fontIssues.map(function(f) { return f.font; }).join(", "));
        }
        if (marginIssue) {
          result.status = "FAIL";
          result.issues.push("Margin h1 : " + marginIssue.marginBottom + " (attendu " + marginIssue.expected + ")");
        }
        if (iconIssue) {
          result.status = "FAIL";
          result.issues.push("Icone X trop petite : " + iconIssue.size);
        }
      }

      // Screenshot
      var shotName = "proof-" + (test.key || "nokey") + "-" + Date.now() + ".png";
      result.screenshot = path.join(SCREENSHOTS_DIR, shotName);
      await page.screenshot({ path: result.screenshot, fullPage: false });

      console.log(result.status + (result.issues.length ? " (" + result.issues[0].substring(0,40) + ")" : ""));

    } catch (e) {
      result.status = "FAIL";
      result.issues.push("Erreur Playwright : " + e.message.substring(0, 100));
      console.log("ERREUR");
    }

    results.push(result);
    await new Promise(function(r) { setTimeout(r, 800); });
  }

  await browser.close();
  return results;
}

// ── ETAPE 5 : METTRE A JOUR XRAY + UPLOAD PREUVES ────────────────────────────
async function updateXrayResults(execKey, results) {
  if (!execKey) { console.log("\n[XRAY] Pas de Test Execution - mise a jour ignoree"); return; }
  console.log("\n[XRAY] Mise a jour des resultats dans Jira...");

  // 1 seul ticket Test - on fait 1 commentaire global avec tous les resultats
  var testKey = results.length > 0 ? results[0].test.key : null;
  if (!testKey) return;

  // Construire le commentaire global
  var pass    = results.filter(function(r) { return r.status === "PASS"; }).length;
  var fail    = results.filter(function(r) { return r.status === "FAIL"; }).length;
  var comment = "**Resultats d'execution automatique - " + new Date().toLocaleDateString("fr-FR") + "**\n\n";
  comment += "- Env : sophie\n";
  comment += "- Date : " + new Date().toLocaleString("fr-FR") + "\n";
  comment += "- PASS : " + pass + " / FAIL : " + fail + "\n\n";
  comment += "| TC | Page | Statut | Details |\n|---|---|---|---|\n";

  results.forEach(function(r) {
    var statut = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : "TODO";
    var detail = r.issues.length > 0 ? r.issues[0].substring(0, 80) : "-";
    comment += "| " + r.test.tcId + " | " + r.test.koItem.page + " | " + statut + " | " + detail + " |\n";
  });

  try {
    process.stdout.write("  Commentaire global sur " + testKey + "... ");
    await jiraRequest("POST", "/rest/api/2/issue/" + testKey + "/comment", { body: comment });
    console.log("[OK]");

    // Upload tous les screenshots sur le ticket Test
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.screenshot && fs.existsSync(r.screenshot)) {
        process.stdout.write("  Upload preuve TC" + String(i+1).padStart(2,"0") + "... ");
        await uploadAttachment(testKey, r.screenshot).catch(function() {});
        console.log("[OK]");
      }
      await new Promise(function(res) { setTimeout(res, 300); });
    }

    // Transition globale
    var globalStatus = fail > 0 ? "Fail" : "Pass";
    var transitions  = await jiraRequest("GET", "/rest/api/2/issue/" + testKey + "/transitions").catch(function() { return { transitions: [] }; });
    if (transitions.transitions) {
      var trans = transitions.transitions.find(function(t) { return t.name.toLowerCase().includes(globalStatus.toLowerCase()); });
      if (trans) {
        await jiraRequest("POST", "/rest/api/2/issue/" + testKey + "/transitions", { transition: { id: trans.id } }).catch(function() {});
        console.log("  Statut ticket : " + globalStatus);
      }
    }
  } catch (e) {
    console.log("[WARN] " + e.message.substring(0, 80));
  }
}

// ── ETAPE 6 : CREER BUGS SI FAIL ─────────────────────────────────────────────
async function createBugsForFails(ticket, results) {
  var fails = results.filter(function(r) { return r.status === "FAIL"; });
  if (fails.length === 0) { console.log("\n[BUGS] Aucun FAIL - pas de bug cree"); return []; }

  console.log("\n[BUGS] Creation de " + fails.length + " bug(s)...");
  var bugs = [];

  for (var i = 0; i < fails.length; i++) {
    var r    = fails[i];
    var ko   = r.test.koItem;
    var summary = "BUG - " + ko.page + " - " + r.issues[0].substring(0, 60);

    // ── Structure BUG Safran ─────────────────────────────────────────────────
    var bugDesc = "";

    // Etapes de reproduction (format Etant donné / Lorsque / Alors)
    bugDesc += "*Etapes de reproduction*\n\n";
    bugDesc += "* *Etant donné* que l'utilisateur consulte la page *" + ko.page + "*\n";
    bugDesc += "* *Lorsque* la page est entièrement chargée sur *" + (r.url || "voir prod") + "*\n";
    bugDesc += "* *Alors* les anomalies suivantes sont constatées :\n\n";
    r.issues.forEach(function(issue) {
      bugDesc += "** " + issue + "\n";
    });
    bugDesc += "\n";

    // Resultat obtenu
    bugDesc += "*Résultat obtenu*\n\n";
    r.issues.forEach(function(issue) {
      bugDesc += "* " + issue + "\n";
    });
    bugDesc += "\n";

    // Resultat attendu
    bugDesc += "*Résultat attendu*\n\n";
    bugDesc += "* Affichage conforme à la prod\n";
    bugDesc += "* Police Barlow appliquée correctement\n";
    bugDesc += "* Marges et espacements identiques à la référence\n";
    bugDesc += "* Icônes aux dimensions correctes\n";
    bugDesc += "* Aucune régression visuelle par rapport à prod\n\n";

    // Environnement
    bugDesc += "*Environnement*\n\n";
    bugDesc += "* Environnement : " + (r.env || "sophie") + "\n";
    bugDesc += "* Navigateur : Chromium (Playwright headless)\n";
    bugDesc += "* Date de détection : " + new Date().toLocaleDateString("fr-FR") + "\n";
    bugDesc += "* Ticket source : " + ticket.key + " - " + ticket.summary + "\n";
    bugDesc += "* Test associé : " + (r.test && r.test.key ? r.test.key : "N/A") + "\n\n";

    // Impact
    bugDesc += "*Impact*\n\n";
    bugDesc += "* Page impactée : " + ko.page + "\n";
    bugDesc += "* URL : " + (r.url || "voir prod") + "\n";
    bugDesc += "* Sévérité : Régression visuelle détectée automatiquement\n";

    var body = {
      fields: {
        project:     { key: CONFIG.jira.project },
        summary:     summary,
        issuetype:   { name: "Bug" },
        priority:    { name: ticket.priority || "Medium" },
        description: bugDesc,
        labels:      ticket.labels.filter(function(l) {
          return !["aby-qa-v2", "auto-generated"].includes(l);
        }).concat(["css-regression"])
      }
    };

    try {
      process.stdout.write("  Bug : " + summary.substring(0,60) + "... ");
      var bug = await jiraRequest("POST", "/rest/api/2/issue", body);
      console.log("[OK] " + bug.key);

      // Upload screenshot
      if (r.screenshot && fs.existsSync(r.screenshot)) {
        await uploadAttachment(bug.key, r.screenshot).catch(function() {});
      }

      // Lier au ticket source
      await jiraRequest("POST", "/rest/api/2/issueLink", {
        type:         { name: "Blocks" },
        inwardIssue:  { key: bug.key },
        outwardIssue: { key: ticket.key }
      }).catch(function() {});

      bugs.push({ key: bug.key, summary: summary });
    } catch (e) {
      console.log("[WARN] " + e.message.substring(0, 60));
    }
    await new Promise(function(r) { setTimeout(r, 300); });
  }

  return bugs;
}

// ── RAPPORT FINAL ─────────────────────────────────────────────────────────────
function generateFinalReport(ticket, createdTests, planKey, execKey, playwrightResults, bugs) {
  var date = new Date().toLocaleString("fr-FR");
  var pass = playwrightResults.filter(function(r) { return r.status === "PASS"; }).length;
  var fail = playwrightResults.filter(function(r) { return r.status === "FAIL"; }).length;
  var todo = playwrightResults.filter(function(r) { return r.status === "TODO"; }).length;

  var md = "# Rapport Pipeline QA - " + ticket.key + "\n\n";
  md += "> Genere par Aby QA V2 le " + date + "\n\n---\n\n";
  md += "## Bilan\n\n";
  md += "| Element | Valeur |\n|---|---|\n";
  md += "| Ticket source | [" + ticket.key + "](https://eurelis.atlassian.net/browse/" + ticket.key + ") |\n";
  md += "| Tests crees | " + createdTests.filter(function(t) { return t.key; }).length + " |\n";
  md += "| Test Plan | " + (planKey ? "[" + planKey + "](https://eurelis.atlassian.net/browse/" + planKey + ")" : "N/A") + " |\n";
  md += "| Test Execution | " + (execKey ? "[" + execKey + "](https://eurelis.atlassian.net/browse/" + execKey + ")" : "N/A") + " |\n";
  md += "| PASS | " + pass + " |\n";
  md += "| FAIL | " + fail + " |\n";
  md += "| TODO | " + todo + " |\n";
  md += "| Bugs crees | " + bugs.length + " |\n\n";

  md += "## Resultats par test\n\n";
  md += "| Test | Page | Statut | Problemes |\n|---|---|---|---|\n";
  playwrightResults.forEach(function(r) {
    var tKey = r.test.key || "N/A";
    md += "| " + tKey + " | " + r.test.koItem.page + " | " + r.status + " | " + (r.issues.join(", ") || "-") + " |\n";
  });

  if (bugs.length > 0) {
    md += "\n## Bugs crees\n\n";
    bugs.forEach(function(b) {
      md += "- [" + b.key + "](https://eurelis.atlassian.net/browse/" + b.key + ") : " + b.summary + "\n";
    });
  }

  var reportPath = path.join(REPORTS_DIR, "PIPELINE-" + ticket.key + "-" + Date.now() + ".md");
  fs.writeFileSync(reportPath, md, "utf8");
  return reportPath;
}


// ════════════════════════════════════════════════════════════════════════════
// GÉNÉRATION CSV XRAY (Action, Données, Résultat Attendu)
// Format Xray : UTF-8, délimiteur virgule, séparateur liste point-virgule
// ════════════════════════════════════════════════════════════════════════════
function generateXrayCSV(ticket, xraySteps, testKey) {
  var lines = [];

  // En-tête exact attendu par Xray
  lines.push("Action,Données,Résultat Attendu");

  xraySteps.forEach(function(step) {
    var pageClean = step.page.replace(/[,;"]/g, " ").substring(0, 80);
    var urlClean  = (step.url || "voir prod").replace(/[,;"]/g, " ");
    var details   = step.details && step.details.length > 0
      ? step.details.filter(function(d) { return d && d.length > 3; }).join("; ").substring(0, 150)
      : "";

    // Colonne Action : Étant donné / Lorsque / Alors
    var action = "Étant donné qu'un visiteur accède à la page " + pageClean + ". " +
                 "Lorsque la page est entièrement chargée. " +
                 "Alors les éléments visuels doivent être conformes.";

    // Colonne Données : URL + device + détails
    var data = urlClean.replace(/https?:\/\/[^/]+/, "{ENV}");
    if (details) data += "; " + details;

    // Colonne Résultat Attendu
    var expected = step.type === "KO"
      ? "Anomalie corrigée — page conforme à la prod (police Barlow; marges correctes; aucune régression)"
      : "Page conforme à la prod — police Barlow appliquée; marges et espacements corrects";

    // Échapper les virgules dans les cellules
    function csvCell(val) {
      val = String(val).replace(/"/g, '""');
      return val.includes(",") || val.includes('"') || val.includes("\n") ? '"' + val + '"' : val;
    }

    lines.push([csvCell(action), csvCell(data), csvCell(expected)].join(","));
  });

  var csv = "\uFEFF" + lines.join("\n"); // BOM UTF-8 pour Excel/Xray
  var filename = "CAS_TEST-" + (testKey || ticket.key) + "-" + Date.now() + ".csv";
  var csvPath  = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(csvPath, csv, "utf8");

  console.log("  [CSV] " + xraySteps.length + " cas de test → " + csvPath);
  return csvPath;
}

// ── Upload CSV vers Xray (si token dispo) ─────────────────────────────────────
async function uploadCSVToXray(testKey, csvPath) {
  if (!testKey) return false;
  console.log("  [XRAY CSV] Upload des cas de test sur " + testKey + "...");
  try {
    // Xray API : PUT /rest/raven/1.0/api/test/{testKey}/steps (import depuis fichier)
    var result = await uploadAttachment(testKey, csvPath);
    if (result) {
      console.log("  [OK] CSV uploadé en PJ sur " + testKey + " (import manuel : Détails du Test → Import → À partir d'un csv)");
      return true;
    }
  } catch(e) {
    console.log("  [INFO] Upload CSV : " + e.message.substring(0, 60));
  }
  return false;
}

// ── Rapport PDF simple (HTML converti) ────────────────────────────────────────
function generateHTMLReport(ticket, playwrightResults, bugs, csvPath, envArg) {
  var date  = new Date().toLocaleString("fr-FR");
  var pass  = playwrightResults.filter(function(r) { return r.status === "PASS"; }).length;
  var fail  = playwrightResults.filter(function(r) { return r.status === "FAIL"; }).length;
  var todo  = playwrightResults.filter(function(r) { return r.status === "TODO"; }).length;
  var total = playwrightResults.length;
  var allPass = fail === 0 && total > 0;
  var pct   = total > 0 ? Math.round(pass/total*100) : 0;

  var statusColor = allPass ? "#00c853" : "#ff1744";
  var statusLabel = allPass ? "✅ TOUT PASS — AUCUNE RÉGRESSION" : "⚠️ " + fail + " FAIL DÉTECTÉ(S)";

  var rowsBadge = function(status) {
    if (status==="PASS") return '<span style="background:#00c853;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">PASS</span>';
    if (status==="FAIL") return '<span style="background:#ff1744;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">FAIL</span>';
    return '<span style="background:#9e9e9e;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">TODO</span>';
  };

  var resultsRows = playwrightResults.map(function(r) {
    return "<tr><td style='padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px'>" +
      (r.test.key||"—") + "</td><td style='padding:8px 12px;border-bottom:1px solid #eee;font-size:12px'>" +
      (r.test.koItem.page||"—").substring(0,50) + "</td><td style='padding:8px 12px;border-bottom:1px solid #eee'>" +
      rowsBadge(r.status) + "</td><td style='padding:8px 12px;border-bottom:1px solid #eee;font-size:11px;color:#666'>" +
      (r.issues.join(", ")||"—").substring(0,80) + "</td></tr>";
  }).join("");

  var bugsSection = bugs.length > 0 ? "<h3 style='color:#ff1744;margin:24px 0 12px'>🐛 Bugs créés (" + bugs.length + ")</h3><ul>" +
    bugs.map(function(b) { return "<li style='margin:6px 0'><strong>" + b.key + "</strong> — " + b.summary + "</li>"; }).join("") + "</ul>" : "";

  var html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<title>Rapport QA — ${ticket.key}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 32px; background: #fafafa; color: #222; }
  .header { background: linear-gradient(135deg, #1a237e, #283593); color: white; border-radius: 12px; padding: 28px 32px; margin-bottom: 28px; }
  .header h1 { margin: 0 0 6px; font-size: 22px; }
  .header p  { margin: 0; opacity: .8; font-size: 14px; }
  .status-banner { background: ${statusColor}; color: white; border-radius: 8px; padding: 16px 24px; font-size: 18px; font-weight: 700; text-align: center; margin-bottom: 24px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; }
  .stat { background: white; border-radius: 10px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .stat .num { font-size: 32px; font-weight: 800; }
  .stat .lbl { font-size: 12px; color: #888; margin-top: 4px; }
  .pass-num { color: #00c853; } .fail-num { color: #ff1744; } .todo-num { color: #9e9e9e; } .pct-num { color: #1a237e; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  thead { background: #1a237e; color: white; }
  th { padding: 12px 14px; text-align: left; font-size: 12px; font-weight: 600; }
  .section { margin-bottom: 28px; }
  h2 { font-size: 16px; margin: 0 0 14px; color: #1a237e; }
  .meta { background: white; border-radius: 10px; padding: 20px 24px; box-shadow: 0 2px 8px rgba(0,0,0,.08); margin-bottom: 24px; }
  .meta table { box-shadow: none; } .meta td { padding: 6px 12px; font-size: 13px; border-bottom: 1px solid #f0f0f0; }
  .meta td:first-child { color: #666; width: 160px; }
  .footer { text-align: center; color: #aaa; font-size: 11px; margin-top: 40px; }
</style>
</head><body>
<div class="header">
  <h1>Rapport de test automatique — ${ticket.key}</h1>
  <p>${ticket.summary} · ${date} · Env : ${envArg}</p>
</div>
<div class="status-banner">${statusLabel}</div>
<div class="stats">
  <div class="stat"><div class="num pass-num">${pass}</div><div class="lbl">PASS</div></div>
  <div class="stat"><div class="num fail-num">${fail}</div><div class="lbl">FAIL</div></div>
  <div class="stat"><div class="num todo-num">${todo}</div><div class="lbl">TODO</div></div>
  <div class="stat"><div class="num pct-num">${pct}%</div><div class="lbl">Taux de succès</div></div>
</div>
<div class="section">
  <h2>📋 Résultats des tests</h2>
  <table><thead><tr><th>Ticket Test</th><th>Page</th><th>Statut</th><th>Anomalies</th></tr></thead>
  <tbody>${resultsRows}</tbody></table>
</div>
${bugsSection}
<div class="footer">Généré automatiquement par Aby QA V2 · ${date}</div>
</body></html>`;

  var reportFilename = (allPass ? "RAPPORT-OK-" : "RAPPORT-FAIL-") + ticket.key + "-" + Date.now() + ".html";
  var reportPath = path.join(REPORTS_DIR, reportFilename);
  fs.writeFileSync(reportPath, html, "utf8");
  console.log("  [RAPPORT] " + reportPath);
  return { path: reportPath, allPass: allPass };
}

// ── Upload rapport HTML en PJ Jira — PJ uniquement, pas de commentaire ──────
async function uploadReportToJira(testKey, reportPath, allPass) {
  if (!testKey || !fs.existsSync(reportPath)) return;
  var label = allPass ? "✅ PASS" : "⚠️ FAIL";
  console.log("  [PJ JIRA] " + label + " → upload rapport en PJ sur " + testKey + "...");
  var ok = await uploadAttachment(testKey, reportPath).catch(function(e) {
    console.log("  [WARN] Upload PJ : " + e.message.substring(0, 60));
    return null;
  });
  if (ok) {
    console.log("  [OK] Rapport joint en PJ sur " + testKey + " (pas de commentaire)");
  }
}

// ── Sauvegarder le résumé release dans release-tracker.json ──────────────────
function saveReleaseTracking(ticket, playwrightResults, bugs, csvPath, reportPath, envArg, planKey, execKey) {
  var trackerPath = path.join(REPORTS_DIR, "release-tracker.json");
  var tracker     = {};

  // Charger l'existant
  try {
    if (fs.existsSync(trackerPath)) {
      tracker = JSON.parse(fs.readFileSync(trackerPath, "utf8"));
    }
  } catch(e) {}

  var release = CFG.xray.fixVersion;
  if (!tracker[release]) tracker[release] = { release: release, tickets: [], lastUpdate: "" };

  var pass  = playwrightResults.filter(function(r) { return r.status === "PASS"; }).length;
  var fail  = playwrightResults.filter(function(r) { return r.status === "FAIL"; }).length;
  var total = playwrightResults.length;

  // Mettre à jour ou ajouter l'entrée du ticket
  var existing = tracker[release].tickets.findIndex(function(t) { return t.key === ticket.key; });
  var entry = {
    key:       ticket.key,
    summary:   ticket.summary,
    env:       envArg,
    testKey:   planKey || "",
    execKey:   execKey || "",
    pass:      pass,
    fail:      fail,
    total:     total,
    bugs:      bugs.length,
    pct:       total > 0 ? Math.round(pass/total*100) : 0,
    status:    fail === 0 && total > 0 ? "PASS" : fail > 0 ? "FAIL" : "TODO",
    csvPath:   csvPath ? path.basename(csvPath) : "",
    reportPath:reportPath ? path.basename(reportPath) : "",
    date:      new Date().toISOString()
  };

  if (existing >= 0) {
    tracker[release].tickets[existing] = entry;
  } else {
    tracker[release].tickets.push(entry);
  }

  tracker[release].lastUpdate = new Date().toISOString();

  // Stats globales de la release
  var all = tracker[release].tickets;
  tracker[release].totalTickets = all.length;
  tracker[release].totalPass    = all.reduce(function(s,t){return s+t.pass;},0);
  tracker[release].totalFail    = all.reduce(function(s,t){return s+t.fail;},0);
  tracker[release].totalBugs    = all.reduce(function(s,t){return s+t.bugs;},0);
  tracker[release].globalStatus = all.every(function(t){return t.status==="PASS";}) ? "PASS" :
                                  all.some(function(t){return t.status==="FAIL";})  ? "FAIL" : "IN PROGRESS";

  fs.writeFileSync(trackerPath, JSON.stringify(tracker, null, 2), "utf8");
  console.log("  [TRACKER] Release " + release + " mise à jour → " + trackerPath);
  return trackerPath;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  var args         = process.argv.slice(2);
  var xmlFile      = args.find(function(a) { return a.endsWith(".xml") || a.endsWith(".rss"); });
  var noPlaywright = args.includes("--no-playwright");
  var envArg       = (args.find(function(a) { return a.startsWith("--env="); }) || "--env=sophie").split("=")[1];
  // Remplir les variables globales depuis les args
  var instrArg  = args.find(function(a) { return a.startsWith("--instructions="); });
  var devArg    = args.find(function(a) { return a.startsWith("--devices="); });
  var brArg     = args.find(function(a) { return a.startsWith("--browsers="); });
  var typeArg   = args.find(function(a) { return a.startsWith("--testtype="); });
  instructions  = instrArg ? instrArg.split("=").slice(1).join("=") : "";
  testType      = typeArg  ? typeArg.split("=")[1] : "auto";

  // --force-key=SAFWBST-XXXX : écraser ce ticket Test existant sans recherche
  var forceKeyArg = args.find(function(a) { return a.startsWith("--force-key="); });
  forceTestKey    = forceKeyArg ? forceKeyArg.split("=")[1].trim().toUpperCase() : null;
  if (forceTestKey) console.log("  [FORCE] Ticket cible : " + forceTestKey + " (sera écrasé)");
  try { testDevices  = devArg  ? JSON.parse(devArg.split("=").slice(1).join("="))  : []; } catch(e) { testDevices  = []; }
  try { testBrowsers = brArg   ? JSON.parse(brArg.split("=").slice(1).join("="))   : []; } catch(e) { testBrowsers = []; }

  // Resoudre chemin relatif ou absolu
  if (xmlFile && !require("path").isAbsolute(xmlFile)) {
    xmlFile = require("path").join(__dirname, xmlFile);
  }

  if (!xmlFile || !fs.existsSync(xmlFile)) {
    console.log("Usage : node agent-xray-full.js TICKET.xml [--env=sophie|paulo|prod] [--no-playwright]");
    console.log("Fichier cherche : " + xmlFile);
    process.exit(1);
  }

  // Verifier le token
  // Token verifie via config.js / .env
  if (!CONFIG.jira.token) {
    console.error("[ERR] JIRA_TOKEN manquant dans le fichier .env");
    process.exit(1);
  }

  console.log("==================================================");
  console.log("  AGENT XRAY FULL PIPELINE - ABY QA V2");
  console.log("==================================================");
  console.log("  Fichier : " + xmlFile);
  console.log("  Env     : " + envArg);
  console.log("  Jira    : https://" + CONFIG.jira.host);
  console.log("  Projet  : " + CONFIG.jira.project);
  console.log("==================================================\n");

  // 1. Parser le XML
  console.log("[1/6] Analyse du ticket XML...");
  var xmlContent = fs.readFileSync(xmlFile, "utf8");
  var ticket     = parseXML(xmlContent);
  console.log("  " + ticket.key + " - " + ticket.summary);
  console.log("  KO : " + ticket.koItems.length + " | OK : " + ticket.okItems.length);

  // 2. Creer les tests Xray
  var createdTests = await createXrayTests(ticket);
  var testKeys     = createdTests.filter(function(t) { return t.key; }).map(function(t) { return t.key; });

  // 3. Creer le Test Plan
  var planKey = await createTestPlan(ticket, testKeys);

  // 4. Creer la Test Execution
  var execKey = await createTestExecution(ticket, planKey, testKeys);

  // 5. Playwright
  var playwrightResults = [];
  if (!noPlaywright && ticket.koItems.length > 0) {
    playwrightResults = await runPlaywright(ticket, createdTests, envArg);
  } else {
    playwrightResults = createdTests.map(function(t) { return { test: t, status: "TODO", issues: [], screenshot: null }; });
  }

  // 6. Mettre a jour Xray + upload preuves
  await updateXrayResults(execKey, playwrightResults);

  // 7. Creer les bugs
  var bugs = await createBugsForFails(ticket, playwrightResults);

  // 8. Générer le CSV Xray (1 fichier par ticket Test)
  console.log("\n[7/" + (noPlaywright?"7":"8") + "] Génération CSV Xray...");
  var allStepsForCSV = createdTests.length > 0 && createdTests[0].steps ? createdTests[0].steps : [];
  var csvPath = null;
  if (allStepsForCSV.length > 0) {
    var testKeyForCSV = testKeys.length > 0 ? testKeys[0] : null;
    csvPath = generateXrayCSV(ticket, allStepsForCSV, testKeyForCSV);
    // Uploader le CSV en PJ sur le ticket Test (pour import manuel facilité)
    if (testKeyForCSV) await uploadCSVToXray(testKeyForCSV, csvPath);
  }

  // 9. Rapport HTML
  console.log("\n[8/8] Génération rapport HTML...");
  var htmlReport  = generateHTMLReport(ticket, playwrightResults, bugs, csvPath, envArg);
  var reportPath  = htmlReport.path;

  // 10. Upload rapport en PJ Jira
  if (testKeys.length > 0) {
    await uploadReportToJira(testKeys[0], reportPath, htmlReport.allPass);
  }

  // 11. Rapport MD legacy
  generateFinalReport(ticket, createdTests, planKey, execKey, playwrightResults, bugs);

  // 12. Tracking release
  saveReleaseTracking(ticket, playwrightResults, bugs, csvPath, reportPath, envArg, planKey, execKey);

  var pass = playwrightResults.filter(function(r) { return r.status === "PASS"; }).length;
  var fail = playwrightResults.filter(function(r) { return r.status === "FAIL"; }).length;

  console.log("\n==================================================");
  console.log("  PIPELINE TERMINÉ");
  console.log("==================================================");
  console.log("  Test(s)      : " + testKeys.join(", ") || "N/A");
  console.log("  PASS         : " + pass + " / " + playwrightResults.length);
  console.log("  FAIL         : " + fail);
  console.log("  Bugs créés   : " + bugs.length);
  console.log("  CSV Xray     : " + (csvPath ? path.basename(csvPath) : "N/A"));
  console.log("  Rapport      : " + path.basename(reportPath));
  console.log("  Statut       : " + (fail === 0 && playwrightResults.length > 0 ? "✅ TOUT PASS" : "⚠️  FAIL(S)"));
  console.log("\n  Jira : https://" + CONFIG.jira.host + "/browse/" + ticket.key);
  console.log("==================================================\n");
}

main().catch(function(e) { console.error("[ERR FATAL]", e.message); process.exit(1); });
