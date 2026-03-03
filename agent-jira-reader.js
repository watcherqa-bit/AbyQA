// agent-jira-reader.js - Lit un export XML Jira et genere automatiquement :
//   1. Un rapport d'analyse du ticket
//   2. Les cas de test CSV (import Xray)
//   3. Un ticket Test Jira (.md)
//   4. Lance Playwright sur les URLs KO detectees
//
// Usage :
//   node agent-jira-reader.js mon-ticket.xml
//   node agent-jira-reader.js mon-ticket.xml --no-playwright
//   node agent-jira-reader.js mon-ticket.xml --env sophie

"use strict";

// Forcer le chemin des navigateurs Playwright (Render/cloud Linux uniquement)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

const fs       = require("fs");
const path     = require("path");
const http     = require("http");
const { chromium } = require("playwright");
const CFG = require("./config"); CFG.paths.init();

// ── CONFIG ────────────────────────────────────────────────────────────────────
const REPORTS_DIR     = CFG.paths.reports;
const SCREENSHOTS_DIR = CFG.paths.screenshots;
const OLLAMA_MODEL    = CFG.ollama.model;

const ENVS = {
  sophie: CFG.envs.sophie,
  paulo:  CFG.envs.paulo,
  prod:   CFG.envs.prod
};

[REPORTS_DIR, SCREENSHOTS_DIR].forEach(function(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── PARSER XML JIRA ───────────────────────────────────────────────────────────
function parseXML(xmlContent) {
  var ticket = {
    key:         "",
    summary:     "",
    type:        "",
    status:      "",
    priority:    "",
    assignee:    "",
    reporter:    "",
    description: "",
    labels:      [],
    comments:    [],
    testsField:  "",
    urls:        [],
    koItems:     [],
    okItems:     []
  };

  // Extraction par regex (pas de dependance externe)
  function extract(tag, content) {
    var re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
    var m  = content.match(re);
    return m ? m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : "";
  }

  function extractRaw(tag, content) {
    var re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
    var m  = content.match(re);
    return m ? m[1] : "";
  }

  ticket.key         = extract("key", xmlContent);
  ticket.summary     = extract("summary", xmlContent);
  ticket.type        = extract("type", xmlContent);
  ticket.status      = extract("status", xmlContent);
  ticket.priority    = extract("priority", xmlContent);
  ticket.assignee    = extract("assignee", xmlContent);
  ticket.reporter    = extract("reporter", xmlContent);
  ticket.description = extract("description", xmlContent);

  // Labels
  var labelMatches = xmlContent.match(/<label>([^<]+)<\/label>/g) || [];
  ticket.labels = labelMatches.map(function(l) { return l.replace(/<\/?label>/g, ""); });

  // Commentaires
  var commentMatches = xmlContent.match(/<comment[^>]*>([\s\S]*?)<\/comment>/g) || [];
  ticket.comments = commentMatches.map(function(c) {
    var author  = (c.match(/author="([^"]+)"/) || [])[1] || "unknown";
    var created = (c.match(/created="([^"]+)"/) || [])[1] || "";
    var text    = c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { author: author, created: created, text: text };
  });

  // Champ Tests (customfield_10077)
  var testsFieldRaw = "";
  var cfMatch = xmlContent.match(/customfield_10077[\s\S]*?<customfieldvalue>([\s\S]*?)<\/customfieldvalue>/);
  if (cfMatch) testsFieldRaw = cfMatch[1];
  ticket.testsField = testsFieldRaw;

  // Extraire URLs depuis le champ Tests
  var urlMatches = testsFieldRaw.match(/href="(https?:\/\/[^"]+)"/g) || [];
  var seenUrls   = {};
  urlMatches.forEach(function(u) {
    var url = u.replace(/href="/, "").replace(/"$/, "");
    // Filtrer les URLs valides (pas les profils Jira)
    if (!url.includes("atlassian.net") && !url.includes("jira/people") && !seenUrls[url]) {
      seenUrls[url] = true;
      ticket.urls.push(url);
    }
  });

  // Detecter les KO et OK dans le champ Tests
  // Patterns : KO apres un lien, OK apres un lien
  var lines = testsFieldRaw.split(/<li>|<\/li>/);
  lines.forEach(function(line) {
    var cleanLine = line.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!cleanLine) return;

    // Extraire l'URL de la ligne
    var lineUrl = "";
    var urlM = line.match(/href="(https?:\/\/[^"]+)"/);
    if (urlM && !urlM[1].includes("atlassian.net")) lineUrl = urlM[1];

    if (cleanLine.includes("KO")) {
      // Extraire le nom de la page (avant le KO)
      var pageName = cleanLine.split("KO")[0].trim().replace(/[^a-zA-Z0-9\s\-]/g, "").trim();
      // Extraire la raison (apres le KO)
      var reason = cleanLine.split("KO")[1] || "";
      // Sous-items (raisons detaillees)
      var subReasons = [];
      var subMatches = line.match(/<li>([\s\S]*?)<\/li>/g) || [];
      subMatches.forEach(function(sub) {
        var subText = sub.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (subText && subText.length > 3) subReasons.push(subText);
      });

      ticket.koItems.push({
        page:    pageName,
        url:     lineUrl,
        reason:  reason.trim(),
        details: subReasons.length > 0 ? subReasons : [reason.trim()]
      });
    } else if (cleanLine.includes("OK") && !cleanLine.includes("KO")) {
      var pageNameOk = cleanLine.split("OK")[0].trim().replace(/[^a-zA-Z0-9\s\-]/g, "").trim();
      ticket.okItems.push({ page: pageNameOk, url: lineUrl });
    }
  });

  return ticket;
}

// ── OLLAMA ────────────────────────────────────────────────────────────────────
function callOllama(prompt) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ model: OLLAMA_MODEL, prompt: prompt, stream: false });
    var req  = http.request({
      hostname: CFG.ollama.host, port: CFG.ollama.port, path: "/api/generate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data).response || ""); }
        catch (e) { resolve(""); }
      });
    });
    req.on("error", function() { resolve(""); });
    req.write(body); req.end();
  });
}

// ── GENERER CAS DE TEST CSV (format Xray) ────────────────────────────────────
function generateCSV(ticket) {
  var rows = [["Test Type", "Summary", "Action", "Data", "Expected Result"]];

  // Cas de test pour chaque item KO
  ticket.koItems.forEach(function(ko) {
    var page = ko.page || "Page inconnue";

    // Cas de test principal : verifier la correction du KO
    rows.push([
      "Manual",
      ticket.key + " - Verifier correction : " + page,
      "Naviguer sur la page " + page + " (sophie vs prod)",
      ko.url || "URL de la page",
      "La police est Barlow sur sophie comme en prod. Aucune regression CSS visible."
    ]);

    // Cas de test secondaires bases sur les details
    ko.details.forEach(function(detail, i) {
      if (detail && detail.length > 5) {
        rows.push([
          "Manual",
          ticket.key + " - " + page + " detail " + (i + 1),
          "Inspecter l'element concerne : " + detail.substring(0, 80),
          "Comparaison sophie / prod / paulo",
          "L'element est conforme entre les 3 environnements"
        ]);
      }
    });
  });

  // Cas de test de non-regression pour les OK
  ticket.okItems.slice(0, 5).forEach(function(ok) {
    if (ok.page && ok.page.length > 2) {
      rows.push([
        "Manual",
        ticket.key + " - Non-regression : " + ok.page,
        "Naviguer sur la page " + ok.page + " et verifier le rendu CSS global",
        ok.url || "URL de la page",
        "La page s'affiche correctement, police Barlow presente, aucune regression"
      ]);
    }
  });

  // Cas de test global compilation CSS
  rows.push([
    "Manual",
    ticket.key + " - Compilation CSS - Chargement global",
    "Ouvrir les DevTools > Network, recharger la page, verifier les fichiers CSS",
    "sophie.safran-group.com et paulo.safran-group.com",
    "Tous les fichiers CSS se chargent en 200, aucun 404, taille coherente avec prod"
  ]);

  rows.push([
    "Manual",
    ticket.key + " - Police Barlow - Verification globale",
    "Ouvrir DevTools > Elements, selectionner un titre ou un texte du menu, verifier font-family",
    "N'importe quelle page de sophie",
    "font-family contient Barlow en priorite (pas Arial, pas MS Shell Dlg)"
  ]);

  // Serialiser en CSV
  var csv = "\uFEFF"; // BOM UTF-8
  rows.forEach(function(row) {
    csv += row.map(function(cell) {
      return '"' + String(cell).replace(/"/g, '""') + '"';
    }).join(",") + "\r\n";
  });

  return csv;
}

// ── GENERER TICKET TEST (.md) ─────────────────────────────────────────────────
function generateTestTicket(ticket) {
  var date = new Date().toLocaleDateString("fr-FR");
  var md   = "";

  md += "# TEST - [SAFWBST] - " + ticket.summary + "\n\n";
  md += "**Ticket source :** [" + ticket.key + "](https://eurelis.atlassian.net/browse/" + ticket.key + ")\n";
  md += "**Type :** " + ticket.type + "\n";
  md += "**Statut :** " + ticket.status + "\n";
  md += "**Priorite :** " + ticket.priority + "\n";
  md += "**Labels :** " + (ticket.labels.join(", ") || "Aucun") + "\n";
  md += "**Date generation :** " + date + "\n\n";
  md += "---\n\n";

  md += "## Objectif\n\n";
  md += "Verifier que la mise a jour du process de compilation CSS (node-sass → sass moderne) ";
  md += "n'introduit aucune regression visuelle sur les " + ticket.okItems.length + " templates valides ";
  md += "et que les " + ticket.koItems.length + " anomalies identifiees sont corrigees.\n\n";

  md += "---\n\n";
  md += "## Anomalies a verifier (" + ticket.koItems.length + " KO)\n\n";

  ticket.koItems.forEach(function(ko, i) {
    md += "### KO " + (i + 1) + " - " + ko.page + "\n";
    if (ko.url) md += "- **URL :** " + ko.url + "\n";
    ko.details.forEach(function(d) {
      if (d && d.length > 3) md += "- " + d + "\n";
    });
    md += "\n";
  });

  md += "---\n\n";
  md += "## Cas de test\n\n";
  md += "### TC01 - Police Barlow sur les pages de liste avec filtres\n";
  md += "- **Precondition :** Acceder a sophie.safran-group.com\n";
  md += "- **Etapes :**\n";
  md += "  1. Naviguer sur /news\n";
  md += "  2. Ouvrir DevTools > Elements\n";
  md += "  3. Selectionner un filtre dans la liste\n";
  md += "  4. Verifier la propriete font-family\n";
  md += "- **Resultat attendu :** font-family: Barlow, Arial, sans-serif\n";
  md += "- **Resultat obtenu :** A renseigner\n\n";

  md += "### TC02 - Icone X fermeture des tags\n";
  md += "- **Precondition :** Acceder a sophie.safran-group.com/news\n";
  md += "- **Etapes :**\n";
  md += "  1. Selectionner un filtre pour afficher des tags actifs\n";
  md += "  2. Inspecter l'icone X de fermeture\n";
  md += "  3. Comparer la taille avec prod\n";
  md += "- **Resultat attendu :** Meme taille que sur prod\n";
  md += "- **Resultat obtenu :** A renseigner\n\n";

  md += "### TC03 - Company page h1 margin\n";
  md += "- **URL :** https://sophie.safran-group.com/companies/safran-engineering-services\n";
  md += "- **Etapes :**\n";
  md += "  1. Inspecter le h1.c-hero__content.w-separator\n";
  md += "  2. Verifier margin-bottom\n";
  md += "- **Resultat attendu :** margin-bottom = 120px (comme prod)\n";
  md += "- **Resultat obtenu :** 110px sur sophie (KO)\n\n";

  md += "### TC04 - Share price police\n";
  md += "- **URL :** https://sophie.safran-group.com/finance\n";
  md += "- **Etapes :**\n";
  md += "  1. Localiser le widget Share price\n";
  md += "  2. Inspecter font-family\n";
  md += "- **Resultat attendu :** Barlow, Arial, sans-serif\n";
  md += "- **Resultat obtenu :** MS Shell Dlg (KO)\n\n";

  md += "### TC05 - Non-regression globale (pages OK)\n";
  md += "- **Etapes :** Parcourir les " + ticket.okItems.length + " pages validees\n";
  md += "- **Resultat attendu :** Aucune regression introduite par la mise a jour\n\n";

  md += "---\n\n";
  md += "## Pages validees (" + ticket.okItems.length + " OK)\n\n";
  ticket.okItems.forEach(function(ok) {
    if (ok.page && ok.page.length > 2) {
      md += "- [OK] " + ok.page + (ok.url ? " - " + ok.url : "") + "\n";
    }
  });

  md += "\n---\n\n";
  md += "## Instructions Jira\n\n";
  md += "1. Copier ce contenu dans un nouveau ticket Jira de type **Test**\n";
  md += "2. Lier au ticket parent : " + ticket.key + "\n";
  md += "3. Importer le CSV dans **Xray > Import Tests**\n";
  md += "4. Assigner a : " + ticket.assignee + "\n";

  return md;
}

// ── GENERER RAPPORT ANALYSE ───────────────────────────────────────────────────
function generateAnalysisReport(ticket, csvPath, testTicketPath) {
  var date = new Date().toLocaleString("fr-FR");
  var md   = "";

  md += "# Analyse ticket " + ticket.key + " - Aby QA V2\n\n";
  md += "> Genere le " + date + "\n\n---\n\n";

  md += "## Ticket\n\n";
  md += "- **Cle :** " + ticket.key + "\n";
  md += "- **Titre :** " + ticket.summary + "\n";
  md += "- **Type :** " + ticket.type + "\n";
  md += "- **Statut :** " + ticket.status + "\n";
  md += "- **Priorite :** " + ticket.priority + "\n";
  md += "- **Assignee :** " + ticket.assignee + "\n";
  md += "- **Labels :** " + ticket.labels.join(", ") + "\n\n";

  md += "## Analyse\n\n";
  md += "- URLs extraites : " + ticket.urls.length + "\n";
  md += "- Items KO : **" + ticket.koItems.length + "**\n";
  md += "- Items OK : " + ticket.okItems.length + "\n";
  md += "- Commentaires : " + ticket.comments.length + "\n\n";

  md += "## KO detectes\n\n";
  ticket.koItems.forEach(function(ko) {
    md += "- **" + ko.page + "**" + (ko.url ? " (" + ko.url + ")" : "") + "\n";
    ko.details.forEach(function(d) {
      if (d && d.length > 3) md += "  - " + d + "\n";
    });
  });

  md += "\n## Fichiers generes\n\n";
  md += "- CSV Xray : " + csvPath + "\n";
  md += "- Ticket Test : " + testTicketPath + "\n";

  return md;
}

// ── PLAYWRIGHT SUR LES KO ─────────────────────────────────────────────────────
async function runPlaywrightOnKO(ticket, envName) {
  var envUrl = ENVS[envName] || ENVS.sophie;
  console.log("\n[PLAYWRIGHT] Test automatique sur " + ticket.koItems.length + " pages KO...");

  var browser = await chromium.launch({ headless: true });
  var page    = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  var playwrightResults = [];

  for (var i = 0; i < ticket.koItems.length; i++) {
    var ko  = ticket.koItems[i];
    var url = ko.url;

    // Adapter l'URL vers l'environnement cible
    if (url && url.includes("safran-group.com")) {
      url = url.replace(/https?:\/\/[a-z]+\.safran-group\.com/, envUrl);
    } else if (url) {
      url = envUrl + "/" + url.replace(/^\//, "");
    } else {
      console.log("  [SKIP] " + ko.page + " - pas d'URL");
      continue;
    }

    process.stdout.write("  [" + (i+1) + "/" + ticket.koItems.length + "] " + ko.page + "... ");

    var result = { page: ko.page, url: url, checks: [], screenshot: null };

    try {
      var res = await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      result.httpStatus = res ? res.status() : 0;

      // Verifier la police Barlow (probleme principal du ticket)
      var fontCheck = await page.evaluate(function() {
        var elements = document.querySelectorAll("h1, h2, nav, .c-filter, [class*='filter'], [class*='tag']");
        var issues   = [];
        for (var i = 0; i < Math.min(elements.length, 20); i++) {
          var ff = window.getComputedStyle(elements[i]).fontFamily;
          if (ff && (ff.includes("MS Shell") || ff.includes("Arial") && !ff.includes("Barlow"))) {
            issues.push({
              element: elements[i].tagName + "." + (elements[i].className || "").split(" ")[0],
              font:    ff
            });
          }
        }
        return issues;
      }).catch(function() { return []; });

      // Verifier le margin du h1 company
      var marginCheck = null;
      if (url.includes("companies") || url.includes("company") || url.includes("society")) {
        marginCheck = await page.evaluate(function() {
          var h1 = document.querySelector("h1.c-hero__content, h1[class*='hero']");
          if (!h1) return null;
          return { marginBottom: window.getComputedStyle(h1).marginBottom };
        }).catch(function() { return null; });
      }

      result.fontIssues   = fontCheck;
      result.marginCheck  = marginCheck;
      result.fontOK       = fontCheck.length === 0;

      // Screenshot
      var shotPath = path.join(SCREENSHOTS_DIR, "playwright-ko-" + ko.page.replace(/[^a-z0-9]/gi, "-") + "-" + Date.now() + ".png");
      await page.screenshot({ path: shotPath, fullPage: false });
      result.screenshot = shotPath;

      var status = result.fontOK ? "OK" : "KO";
      console.log(status + " (font:" + (result.fontOK ? "Barlow" : "PROBLEME") + ", HTTP:" + result.httpStatus + ")");

    } catch (e) {
      result.error = e.message;
      console.log("ERREUR : " + e.message.substring(0, 50));
    }

    playwrightResults.push(result);
    await page.waitForTimeout(500);
  }

  await browser.close();
  return playwrightResults;
}

// ── RAPPORT PLAYWRIGHT ────────────────────────────────────────────────────────
function appendPlaywrightResults(reportPath, results, envName) {
  var md = "\n---\n\n## Resultats Playwright sur " + envName.toUpperCase() + "\n\n";
  md += "| Page | HTTP | Font | Margin | Statut |\n|---|---|---|---|---|\n";

  results.forEach(function(r) {
    var fontStatus   = r.fontIssues ? (r.fontOK ? "OK Barlow" : "KO " + r.fontIssues.length + " elements") : "N/A";
    var marginStatus = r.marginCheck ? r.marginCheck.marginBottom : "-";
    var statut       = r.error ? "ERREUR" : (r.fontOK ? "[OK]" : "[KO]");
    md += "| " + r.page + " | " + (r.httpStatus||"?") + " | " + fontStatus + " | " + marginStatus + " | " + statut + " |\n";
  });

  var nbOk = results.filter(function(r) { return r.fontOK && !r.error; }).length;
  var nbKo = results.filter(function(r) { return !r.fontOK || r.error; }).length;
  md += "\n**Bilan : " + nbOk + " OK / " + nbKo + " encore KO**\n";

  fs.appendFileSync(reportPath, md, "utf8");
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  var args       = process.argv.slice(2);
  var xmlFile    = args.find(function(a) { return a.endsWith(".xml") || a.endsWith(".rss"); });
  var noPlaywright = args.includes("--no-playwright");
  var envArg     = (args.find(function(a) { return a.startsWith("--env="); }) || "--env=sophie").split("=")[1];

  if (!xmlFile) {
    console.log("Usage : node agent-jira-reader.js mon-ticket.xml [--env=sophie|paulo|prod] [--no-playwright]");
    console.log("Exemple : node agent-jira-reader.js SAFWBST-2605.xml --env=sophie");
    process.exit(1);
  }

  // Resoudre chemin relatif ou absolu
  if (xmlFile && !require("path").isAbsolute(xmlFile)) {
    xmlFile = require("path").join(__dirname, xmlFile);
  }

  if (!xmlFile || !fs.existsSync(xmlFile)) {
    console.error("[ERR] Fichier non trouve : " + xmlFile);
    process.exit(1);
  }

  var xmlContent = fs.readFileSync(xmlFile, "utf8");

  console.log("==================================================");
  console.log("  AGENT JIRA READER - ABY QA V2");
  console.log("==================================================");
  console.log("  Fichier : " + xmlFile);
  console.log("  Env     : " + envArg);
  console.log("  Playwright : " + (noPlaywright ? "desactive" : "active"));
  console.log("==================================================\n");

  // 1. Parser le XML
  console.log("[1/4] Analyse du ticket XML...");
  var ticket = parseXML(xmlContent);
  console.log("  Ticket    : " + ticket.key + " - " + ticket.summary);
  console.log("  Statut    : " + ticket.status);
  console.log("  KO trouves: " + ticket.koItems.length);
  console.log("  OK trouves: " + ticket.okItems.length);
  console.log("  URLs      : " + ticket.urls.length);

  // 2. Generer le CSV Xray
  console.log("\n[2/4] Generation du CSV Xray...");
  var csv     = generateCSV(ticket);
  var csvName = "CAS_TEST-" + ticket.key + "-" + Date.now() + ".csv";
  var csvPath = path.join(REPORTS_DIR, csvName);
  fs.writeFileSync(csvPath, csv, "utf8");
  var csvLines = csv.split("\n").length - 2;
  console.log("  " + csvLines + " cas de test generes -> " + csvPath);

  // 3. Generer le ticket Test (.md)
  console.log("\n[3/4] Generation du ticket Test (.md)...");
  var testMd   = generateTestTicket(ticket);
  var testName = "TEST-" + ticket.key + "-" + Date.now() + ".md";
  var testPath = path.join(REPORTS_DIR, testName);
  fs.writeFileSync(testPath, testMd, "utf8");
  console.log("  Ticket test genere -> " + testPath);

  // 4. Rapport d'analyse
  var analysisReport = generateAnalysisReport(ticket, csvPath, testPath);
  var reportName     = "ANALYSE-" + ticket.key + "-" + Date.now() + ".md";
  var reportPath     = path.join(REPORTS_DIR, reportName);
  fs.writeFileSync(reportPath, analysisReport, "utf8");

  // 5. Playwright sur les KO
  if (!noPlaywright && ticket.koItems.length > 0) {
    console.log("\n[4/4] Lancement Playwright sur les " + ticket.koItems.length + " pages KO...");
    var playwrightResults = await runPlaywrightOnKO(ticket, envArg);
    appendPlaywrightResults(reportPath, playwrightResults, envArg);
  } else {
    console.log("\n[4/4] Playwright ignore (--no-playwright ou 0 KO)");
  }

  console.log("\n==================================================");
  console.log("  TERMINE");
  console.log("==================================================");
  console.log("  CSV Xray      : " + csvPath);
  console.log("  Ticket Test   : " + testPath);
  console.log("  Rapport       : " + reportPath);
  console.log("  Screenshots   : " + SCREENSHOTS_DIR);
  console.log("\n  PROCHAINES ETAPES :");
  console.log("  1. Importer " + csvName + " dans Xray (Importateur CSV)");
  console.log("  2. Copier " + testName + " dans un ticket Jira Test");
  console.log("  3. Lier au ticket parent : " + ticket.key);
  console.log("==================================================\n");
}

main().catch(function(e) { console.error("[ERR FATAL]", e.message); process.exit(1); });
