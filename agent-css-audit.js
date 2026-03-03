// agent-css-audit.js - Audit CSS complet sur Sophie, Paulo et Prod
// Compare les 3 environnements et detecte les regressions visuelles
//
// Usage :
//   node agent-css-audit.js            <- audit les 3 envs
//   node agent-css-audit.js sophie     <- audit sophie uniquement
//   node agent-css-audit.js sophie paulo <- audit 2 envs

"use strict";

// Forcer le chemin des navigateurs Playwright (Render/cloud Linux uniquement)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

const fs   = require("fs");
const path = require("path");
const { chromium, firefox, webkit } = require("playwright");
const CFG  = require("./config");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SCREENSHOTS_DIR = CFG.paths.screenshots;
const REPORTS_DIR     = path.join(__dirname, "reports");

const ENVS = {
  sophie: { url: CFG.envs.sophie, name: "sophie" },
  paulo:  { url: CFG.envs.paulo,  name: "paulo"  },
  prod:   { url: CFG.envs.prod,   name: "prod"   }
};

// Pages a auditer sur chaque environnement (peut etre remplace par --urls=)
var PAGES_TO_AUDIT = [
  { name: "Homepage",       path: "/"                          },
  { name: "News & Media",   path: "/en/news-media"             },
  { name: "Group",          path: "/en/group"                  },
  { name: "Careers",        path: "/en/careers"                },
  { name: "Finance",        path: "/en/finance"                },
  { name: "Sustainability", path: "/en/group/our-commitments"  }
];

// Elements CSS critiques a verifier sur chaque page
// selMobile / domCheckMobile : utilisés quand viewport < 1200px
const CSS_CHECKS = [
  // Header - verifie par presence dans le DOM (pas isVisible)
  { name: "Header present",        sel: "header, .header, #header, [class*='header'], [class*='site-header'], [class*='page-header']", critical: true,  domCheck: true  },

  // Logo — sélecteur précis extrait du DOM réel safran-group.com (valable tous devices)
  { name: "Logo Safran",           sel: 'img[alt="Safran"]',                                                                          critical: true,  domCheck: true  },

  // Navigation — desktop : nav visible / mobile : bouton hamburger (viewport < 1200px)
  { name: "Navigation principale",
    sel:       "nav.c-header-main",
    selMobile: "button.c-header-main__toggle-button",
    critical: true,  domCheck: true  },

  // Menu links — desktop : liens visibles / mobile : présence de la menubar suffit (fermée aria-expanded=false)
  { name: "Menu links",
    sel:           "ul.c-header-main__navigation-menubar a",
    selMobile:     "ul.c-header-main__navigation-menubar",
    domCheckMobile: true,
    critical: true,  domCheck: false },

  // Footer - verifie par presence dans le DOM
  { name: "Footer present",        sel: "footer, .footer, #footer, [class*='footer'], [class*='site-footer'], [class*='page-footer']", critical: true,  domCheck: true  },
  { name: "Footer links",          sel: "footer a, [class*='footer'] a",                                                               critical: false, domCheck: false },

  // Contenu
  { name: "Titre H1",              sel: "h1",                                                                                          critical: true,  domCheck: false },
  { name: "Images chargees",       sel: "img",                                                                                         critical: false, domCheck: false },
  { name: "Boutons CTA",           sel: ".btn, .button, [class*='cta'], [class*='btn'], a[class*='link']",                             critical: false, domCheck: false },

  // Meta viewport - toujours dans le DOM, jamais "visible"
  { name: "Meta viewport",         sel: "meta[name='viewport']",                                                                       critical: true,  domCheck: true  },

  // Fonts
  { name: "Police Barlow chargee", sel: "link[href*='barlow'], link[href*='font'], link[rel='stylesheet']",                            critical: false, domCheck: true  },

  // Cookies
  { name: "Bandeau cookies",       sel: "[class*='cookie'], [id*='cookie'], [class*='consent'], [class*='privacy'], [class*='rgpd']",  critical: false, domCheck: false }
];

[SCREENSHOTS_DIR, REPORTS_DIR].forEach(function(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── AUDIT D'UNE PAGE ─────────────────────────────────────────────────────────
async function auditPage(page, env, pageConfig, browserName, device) {
  var result = {
    env:         env.name,
    page:        pageConfig.name,
    url:         env.url + pageConfig.path,
    browser:     browserName || "chromium",
    device:      device ? device.name : "desktop-hd",
    viewport:    device ? (device.w + "×" + device.h) : "1440×900",
    status:      null,
    loadTime:    0,
    checks:      [],
    cssErrors:   [],
    brokenImages:[],
    consoleLogs: [],
    screenshot:  null,
    score:       0
  };

  // Capturer les erreurs console
  // Note : fonctions nommées pour pouvoir les retirer avec page.off() en fin d'audit
  // (évite l'accumulation de listeners quand la même page est réutilisée pour N URLs)
  var consoleMsgs = [];
  var _consoleHandler = function(msg) {
    if (msg.type() === "error") consoleMsgs.push(msg.text());
  };
  page.on("console", _consoleHandler);

  // Capturer les erreurs reseau
  var networkErrors = [];
  var _failedHandler = function(req) {
    var url = req.url();
    if (url.includes(".css") || url.includes(".js") || url.includes(".woff") || url.includes(".ttf")) {
      networkErrors.push({ url: url, error: req.failure() ? req.failure().errorText : "unknown" });
    }
  };
  page.on("requestfailed", _failedHandler);

  try {
    var start = Date.now();
    var response = await page.goto(result.url, { waitUntil: "networkidle", timeout: 30000 });
    result.loadTime = Date.now() - start;
    result.status   = response ? response.status() : 0;

    await page.waitForTimeout(1500);

    // Screenshot — fullPage avec fallback partiel si la page dépasse 32767px (ex: /locations sur Firefox)
    var shotName = "css-" + env.name + "-" + pageConfig.name.replace(/[^a-z0-9]/gi, "-") + "-" + Date.now() + ".png";
    result.screenshot     = path.join(SCREENSHOTS_DIR, shotName);
    result.screenshotFile = shotName;
    try {
      await page.screenshot({ path: result.screenshot, fullPage: true });
    } catch (shotErr) {
      if (shotErr.message && shotErr.message.includes("32767")) {
        // Page trop longue pour un screenshot complet — capturer uniquement le viewport
        try {
          await page.screenshot({ path: result.screenshot, fullPage: false });
          result.screenshotPartial = true;
          process.stdout.write("[screenshot partiel] ");
        } catch (e2) {
          result.screenshotFile = null;
          result.screenshot     = null;
        }
      } else {
        // Autre erreur screenshot : ignorer sans bloquer l'audit
        result.screenshotFile = null;
        result.screenshot     = null;
      }
    }

    // Verifier chaque element CSS — sélecteur adapté au viewport (responsive)
    var viewportWidth = device ? device.w : 1440;
    var isMobile      = viewportWidth < 1200;

    for (var i = 0; i < CSS_CHECKS.length; i++) {
      var check    = CSS_CHECKS[i];
      var exists   = false;
      var count    = 0;
      // Choisir le sélecteur selon le viewport
      var activeSel     = (isMobile && check.selMobile)     ? check.selMobile     : check.sel;
      var activeDomChk  = (isMobile && check.domCheckMobile !== undefined) ? check.domCheckMobile : check.domCheck;

      try {
        var elements = await page.$$(activeSel);
        count  = elements.length;
        exists = count > 0;

        if (exists && check.critical && !activeDomChk) {
          // Pour les elements critiques non-domCheck : verifier la visibilite
          var visible = await page.isVisible(activeSel).catch(function() { return false; });
          exists = visible;
        }
        // Pour domCheck=true : presence dans DOM suffit
      } catch (e) {
        exists = false;
      }

      result.checks.push({
        name:     check.name,
        sel:      activeSel,
        found:    exists,
        count:    count,
        critical: check.critical,
        status:   exists ? "OK" : (check.critical ? "FAIL" : "WARN")
      });
    }

    // Verifier les images cassees
    var brokenImgs = await page.evaluate(function() {
      var imgs = Array.from(document.querySelectorAll("img"));
      return imgs
        .filter(function(img) { return !img.complete || img.naturalWidth === 0; })
        .map(function(img) { return img.src || img.getAttribute("data-src") || "unknown"; })
        .filter(function(src) { return src && src !== "unknown" && !src.includes("data:"); })
        .slice(0, 10); // max 10
    }).catch(function() { return []; });
    result.brokenImages = brokenImgs;

    // Audit CSS avance : verifier les proprietes critiques
    // Seulement si la page a repondu 200 — sinon les erreurs sont des faux positifs
    var cssAudit = { issues: [], fonts: [], hasStyles: false, styleCount: 0, totalNodes: 0, bodyBg: "" };

    if (result.status === 200) {
      cssAudit = await page.evaluate(function() {
        var issues = [];
        var body   = document.body;

        // Verifier que le body n'est pas vide
        if (body.innerHTML.trim().length < 100) {
          issues.push("Body vide ou presque vide");
        }

        // Verifier la couleur de fond — vérifier body ET html avant de signaler
        // body transparent avec html non-transparent = normal (CSS sur <html>)
        var bodyBg = window.getComputedStyle(body).backgroundColor;
        var htmlBg = window.getComputedStyle(document.documentElement).backgroundColor;
        if (bodyBg === "rgba(0, 0, 0, 0)" && htmlBg === "rgba(0, 0, 0, 0)") {
          issues.push("Background transparent sur body et html (CSS potentiellement absent)");
        }

        // Verifier les polices chargees
        var fonts = [];
        try {
          document.fonts.forEach(function(f) { fonts.push(f.family); });
        } catch (e) {}
        if (fonts.length === 0) {
          issues.push("Aucune police personnalisee detectee");
        }

        // Verifier les elements avec overflow hidden problematique
        var overflows = Array.from(document.querySelectorAll("*")).filter(function(el) {
          var style = window.getComputedStyle(el);
          return style.overflow === "hidden" && el.scrollHeight > el.clientHeight + 50;
        }).length;
        if (overflows > 5) {
          issues.push("Nombreux elements avec overflow:hidden potentiellement problematiques (" + overflows + ")");
        }

        return {
          issues:     issues,
          fonts:      fonts.slice(0, 5),
          bodyBg:     bodyBg,
          totalNodes: document.querySelectorAll("*").length,
          hasStyles:  document.styleSheets.length > 0,
          styleCount: document.styleSheets.length
        };
      }).catch(function() { return { issues: [], fonts: [], hasStyles: false, styleCount: 0, totalNodes: 0 }; });
    } else {
      // Page non accessible : noter le statut HTTP comme cause, pas comme erreur CSS
      cssAudit.skipped = true;
      cssAudit.reason  = "Page inaccessible (HTTP " + result.status + ") — audit CSS ignoré";
    }

    result.cssDetails = cssAudit;

    // ── Correction 1 : pages inaccessibles → SKIP, non comptabilisées ─────────
    if (result.status !== 200) {
      result.skipped     = true;
      result.score       = null;
      result.cssSkipped  = "Page inaccessible (HTTP " + result.status + ") — audit CSS ignoré";
      result.cssErrors   = [];
      result.brokenImages = []; // images de la page d'erreur = non pertinentes
      // Correction 7 : filtrer erreurs de polices sur pages d'erreur (faux positifs)
      result.consoleLogs = consoleMsgs.filter(function(m) {
        return !m.includes("rejected by sanitizer") && !m.includes("downloadable font");
      }).slice(0, 5);
      // Marquer tous les checks comme SKIP (la page d'erreur a header/footer mais ≠ contenu réel)
      result.checks.forEach(function(c) { c.status = "SKIP"; });
      console.log("    SKIP (HTTP " + result.status + ") — non comptabilisée");

    } else {
      // ── Page accessible : calcul du score ────────────────────────────────────
      result.cssErrors   = cssAudit.issues.concat(networkErrors.map(function(e) { return "Ressource echouee : " + e.url; }));
      result.consoleLogs = consoleMsgs.slice(0, 5);

      // Correction 6 : erreur Barlow rejetée par Firefox → warning explicite
      var barlowErrors = consoleMsgs.filter(function(m) { return m.includes("rejected by sanitizer"); });
      if (barlowErrors.length > 0) {
        result.cssErrors.push("[Firefox] Police principale rejetée par le navigateur (" +
          barlowErrors.length + " erreur(s)) — vérifier format woff2 et headers CORS");
        result.browserFontWarning = true;
      }

      var criticalFails = result.checks.filter(function(c) { return c.critical && c.status === "FAIL"; }).length;
      var warns         = result.checks.filter(function(c) { return c.status === "WARN"; }).length;
      var total         = result.checks.length;
      var passed        = result.checks.filter(function(c) { return c.status === "OK"; }).length;
      var baseScore     = total > 0 ? Math.round((passed / total) * 100) : 0;

      // Correction 4 : images cassées → pénalité 5% par image (max -30%)
      var imgPenalty  = Math.min(result.brokenImages.length * 5, 30);
      // Correction 6 : police rejetée → -10% (Firefox uniquement)
      var fontPenalty = result.browserFontWarning ? 10 : 0;

      result.score = Math.max(0, baseScore - imgPenalty - fontPenalty);
      result.scoreDetails = { base: baseScore, imgPenalty: imgPenalty, fontPenalty: fontPenalty };

      console.log("    Score : " + result.score + "% (base " + baseScore + "%" +
        (imgPenalty  ? ", -" + imgPenalty  + "% images"  : "") +
        (fontPenalty ? ", -" + fontPenalty + "% police"  : "") +
        ") | " + passed + " OK, " + warns + " WARN, " + criticalFails + " FAIL | " + result.loadTime + "ms");
    }

  } catch (e) {
    result.status    = "ERROR";
    result.skipped   = true;
    result.score     = null;
    result.cssErrors = ["Erreur de chargement : " + e.message];
    result.checks.forEach(function(c) { c.status = "SKIP"; });
    console.log("    ERREUR : " + e.message);
  } finally {
    // Retirer les listeners pour éviter l'accumulation sur un objet page réutilisé
    try { page.off("console",       _consoleHandler); } catch(e) {}
    try { page.off("requestfailed", _failedHandler);  } catch(e) {}
  }

  return result;
}

// ── RAPPORT MARKDOWN ──────────────────────────────────────────────────────────
function generateReport(allResults) {
  var date    = new Date().toLocaleString("fr-FR");
  var envList = Object.keys(allResults);

  var report = "# Audit CSS - Safran (" + envList.join(", ") + ")\n";
  report += "> Genere par Aby QA V2 le " + date + "\n\n---\n\n";

  // Calculer le statut global — pages HTTP 200 uniquement (Correction 2)
  var allScores  = [];
  var allSkipped = 0;
  for (var eg = 0; eg < envList.length; eg++) {
    allResults[envList[eg]].forEach(function(r) {
      if (r.score !== null && r.score !== undefined) allScores.push(r.score);
      else allSkipped++;
    });
  }
  var globalAvg    = allScores.length ? Math.round(allScores.reduce(function(a, b) { return a + b; }, 0) / allScores.length) : 0;
  var globalStatus = globalAvg >= 80 ? "✅ PASS" : globalAvg >= 50 ? "⚠️ WARN" : "❌ FAIL";
  var globalNote   = allScores.length + " page(s) testée(s)" +
    (allSkipped ? ", " + allSkipped + " ignorée(s) (inaccessibles — HTTP 401/403/404)" : "");
  report += "## STATUT FINAL : " + globalStatus + " — Score global : " + globalAvg + "% (" + globalNote + ")\n\n";
  report += "---\n\n";

  // ── Anomalies systémiques : problèmes présents sur la majorité des pages ─────
  // (ne doivent pas être traités page par page mais au niveau infrastructure)
  var allTestedResults = [];
  for (var as = 0; as < envList.length; as++) {
    allResults[envList[as]].forEach(function(r) { if (!r.skipped) allTestedResults.push(r); });
  }

  if (allTestedResults.length > 0) {
    var sysThreshold = Math.max(2, Math.round(allTestedResults.length * 0.4)); // 40% des pages testées

    // Images cassées systémiques
    var imgUrlCount = {};
    allTestedResults.forEach(function(r) {
      (r.brokenImages || []).forEach(function(url) {
        imgUrlCount[url] = (imgUrlCount[url] || 0) + 1;
      });
    });
    var systemicImgs = Object.keys(imgUrlCount)
      .filter(function(url) { return imgUrlCount[url] >= sysThreshold; })
      .sort(function(a, b) { return imgUrlCount[b] - imgUrlCount[a]; });

    // Police rejetée systémique (Firefox)
    var fontWarnPages = allTestedResults.filter(function(r) { return r.browserFontWarning; });
    var systemicFont  = fontWarnPages.length >= sysThreshold;

    if (systemicImgs.length > 0 || systemicFont) {
      report += "## ⚠️ ANOMALIES SYSTÉMIQUES\n\n";
      report += "> Ces problèmes affectent la majorité des pages testées.\n";
      report += "> Ils doivent être traités au niveau infrastructure, pas page par page.\n\n";

      if (systemicFont) {
        report += "### 🔠 Police principale rejetée par Firefox\n";
        report += "- Présente sur **" + fontWarnPages.length + "/" + allTestedResults.length + " pages testées**\n";
        report += "- Erreur : `downloadable font: rejected by sanitizer` (Barlow)\n";
        report += "- Cause probable : format woff2 invalide ou header `Access-Control-Allow-Origin` manquant sur le CDN\n";
        report += "- Impact score : -10% sur chaque page Firefox concernée\n";
        report += "- **Action** : Vérifier les headers CORS du CDN de polices et valider le fichier woff2\n\n";
      }

      if (systemicImgs.length > 0) {
        report += "### 🖼️ Image(s) cassée(s) présente(s) sur toutes les pages\n";
        systemicImgs.forEach(function(url) {
          report += "- Présente sur **" + imgUrlCount[url] + "/" + allTestedResults.length + " pages** : `" + url.substring(0, 120) + "`\n";
        });
        report += "- Impact score : -" + Math.min(systemicImgs.length * 5, 30) + "% sur chaque page concernée\n";
        report += "- **Action** : Corriger ou supprimer ces images dans le CMS (crop manuel manquant ?)\n\n";
      }

      report += "---\n\n";
    }
  }

  // Tableau de synthese
  report += "## SYNTHESE GLOBALE\n\n";
  report += "| Environnement | Page | Navigateur | Device | Viewport | Score | Load | Statut HTTP | Images cassees | Erreurs CSS |\n";
  report += "|---|---|---|---|---|---|---|---|---|---|\n";

  for (var e = 0; e < envList.length; e++) {
    var envResults = allResults[envList[e]];
    for (var p = 0; p < envResults.length; p++) {
      var r         = envResults[p];
      var scoreIcon = r.skipped ? "⏭" : (r.score >= 80 ? "✅" : r.score >= 50 ? "⚠️" : "❌");
      var scoreStr  = r.skipped ? "N/A" : (r.score + "%");
      var imgCount  = (r.brokenImages || []).length;
      report += "| " + r.env + " | " + r.page + " | " + (r.browser||"chromium") + " | " +
                (r.device||"desktop-hd") + " | " + (r.viewport||"") + " | " +
                scoreIcon + " " + scoreStr + " | " + (r.loadTime||0) + "ms | " + r.status + " | " +
                imgCount + " | " + (r.cssErrors||[]).length + " |\n";
    }
  }

  // Comparaison inter-environnements
  if (envList.length > 1) {
    report += "\n---\n\n## COMPARAISON INTER-ENVIRONNEMENTS\n\n";

    var pageNames = PAGES_TO_AUDIT.map(function(p) { return p.name; });
    for (var pg = 0; pg < pageNames.length; pg++) {
      var pageName = pageNames[pg];
      report += "### " + pageName + "\n\n";
      report += "| Check | " + envList.join(" | ") + " |\n";
      report += "|---" + envList.map(function() { return "|---"; }).join("") + "|\n";

      // Ligne Statut HTTP (premier résultat trouvé par env pour ce nom de page)
      var httpRow = "| Statut HTTP |";
      for (var ev = 0; ev < envList.length; ev++) {
        var envRes0  = allResults[envList[ev]];
        var pageRes0 = envRes0 ? envRes0.find(function(r) { return r.page === pageName; }) : null;
        httpRow += " " + (pageRes0 ? pageRes0.status : "N/A") + " |";
      }
      report += httpRow + "\n";

      for (var c = 0; c < CSS_CHECKS.length; c++) {
        var checkName = CSS_CHECKS[c].name;
        var row       = "| " + checkName + " |";
        for (var ev = 0; ev < envList.length; ev++) {
          var envRes  = allResults[envList[ev]];
          var pageRes = envRes ? envRes.find(function(r) { return r.page === pageName; }) : null;
          var chk     = pageRes ? pageRes.checks.find(function(ch) { return ch.name === checkName; }) : null;
          var chkVal  = chk ? chk.status : "N/A";
          row += " " + (chkVal === "OK" ? "OK" : chkVal === "FAIL" ? "FAIL" : chkVal === "SKIP" ? "SKIP" : "WARN") + " |";
        }
        report += row + "\n";
      }
      report += "\n";
    }
  }

  // Correction 3 — Anomalies inter-navigateurs : pages avec écart de statut HTTP
  var httpAnomalies = [];
  for (var an = 0; an < envList.length; an++) {
    var anEnvKey  = envList[an];
    var anResults = allResults[anEnvKey];
    // Grouper par nom de page
    var byPage = {};
    anResults.forEach(function(r) {
      if (!byPage[r.page]) byPage[r.page] = [];
      byPage[r.page].push(r);
    });
    Object.keys(byPage).forEach(function(pName) {
      var pageGroup = byPage[pName];
      if (pageGroup.length <= 1) return;
      var statuses = pageGroup.map(function(r) { return r.status; });
      var unique   = statuses.filter(function(s, i, a) { return a.indexOf(s) === i; });
      if (unique.length > 1) {
        var detail = pageGroup.map(function(r) { return r.browser + "=" + r.status; }).join(", ");
        httpAnomalies.push("[" + anEnvKey + "] " + pName + " : " + detail);
      }
    });
  }
  if (httpAnomalies.length > 0) {
    report += "\n---\n\n## ANOMALIES INTER-NAVIGATEURS\n\n";
    report += "> Pages où le statut HTTP diffère selon le navigateur (même environnement).\n";
    report += "> Indique un problème d'authentification ou de compatibilité navigateur.\n\n";
    httpAnomalies.forEach(function(a) { report += "- ⚠️ ÉCART HTTP : " + a + "\n"; });
    report += "\n";
  }

  // Detail par environnement
  report += "\n---\n\n## DETAIL PAR ENVIRONNEMENT\n\n";
  for (var ei = 0; ei < envList.length; ei++) {
    var envName    = envList[ei];
    var envResults = allResults[envName];
    // Correction 2c — score env : seulement les pages HTTP 200
    var testedRes  = envResults.filter(function(r) { return r.score !== null && r.score !== undefined; });
    var skippedRes = envResults.filter(function(r) { return r.skipped; });
    var avgScore   = testedRes.length ? Math.round(testedRes.reduce(function(s, r) { return s + r.score; }, 0) / testedRes.length) : 0;
    var envSumLine = testedRes.length + " page(s) testée(s)" +
      (skippedRes.length ? ", " + skippedRes.length + " ignorée(s) (inaccessibles)" : "");

    report += "### " + envName.toUpperCase() + " (Score moyen : " + (testedRes.length ? avgScore + "%" : "N/A") + " — " + envSumLine + ")\n\n";
    // Avertissement si toutes les pages sont inaccessibles sur cet env
    if (testedRes.length === 0 && skippedRes.length > 0) {
      report += "> ⚠️ Toutes les pages de cet environnement sont inaccessibles (HTTP 4xx ou timeout).\n";
      report += "> Vérifiez que les URLs testées existent sur **" + envName.toUpperCase() + "** ou que l'environnement est accessible.\n\n";
    }

    for (var pi = 0; pi < envResults.length; pi++) {
      var res = envResults[pi];
      // Correction 2d — label SKIP pour pages inaccessibles
      var scoreLabel2 = res.skipped ? "⏭ SKIP" : (res.score >= 80 ? "✅ PASS" : res.score >= 50 ? "⚠️ WARN" : "❌ FAIL");
      var scoreStr2   = res.skipped ? "N/A" : (res.score + "%");
      report += "#### " + res.page + " — " + scoreLabel2 + " (" + scoreStr2 + ")\n";
      report += "- URL : " + res.url + "\n";
      report += "- Navigateur : " + (res.browser || "chromium") + "\n";
      report += "- Device : " + (res.device || "desktop-hd") + " (" + (res.viewport || "") + ")\n";
      report += "- Temps de chargement : " + res.loadTime + "ms\n";
      report += "- Statut HTTP : " + res.status + "\n";
      report += "- Feuilles de style : " + (res.cssDetails ? res.cssDetails.styleCount : "N/A") + "\n";
      report += "- Polices : " + (res.cssDetails && res.cssDetails.fonts.length ? res.cssDetails.fonts.join(", ") : "N/A") + "\n";

      // Checks
      var fails = res.checks.filter(function(c) { return c.status === "FAIL"; });
      var warns = res.checks.filter(function(c) { return c.status === "WARN"; });
      if (fails.length > 0) {
        report += "- Echecs critiques :\n";
        for (var f = 0; f < fails.length; f++) {
          report += "  - [FAIL] " + fails[f].name + "\n";
        }
      }
      if (warns.length > 0) {
        report += "- Avertissements :\n";
        for (var w = 0; w < warns.length; w++) {
          report += "  - [WARN] " + warns[w].name + "\n";
        }
      }
      if (res.brokenImages.length > 0) {
        report += "- Images cassees :\n";
        for (var bi = 0; bi < res.brokenImages.length; bi++) {
          report += "  - " + res.brokenImages[bi] + "\n";
        }
      }
      if (res.cssSkipped) {
        report += "- Audit CSS : " + res.cssSkipped + "\n";
      } else if (res.cssErrors.length > 0) {
        report += "- Erreurs CSS/Ressources :\n";
        for (var ce = 0; ce < res.cssErrors.length; ce++) {
          report += "  - " + res.cssErrors[ce] + "\n";
        }
      }
      if (res.consoleLogs.length > 0) {
        report += "- Erreurs console :\n";
        for (var cl = 0; cl < res.consoleLogs.length; cl++) {
          report += "  - " + res.consoleLogs[cl].substring(0, 100) + "\n";
        }
      }
      report += "- Screenshot : " + (res.screenshotFile || res.screenshot) + "\n\n";
    }
  }

  // Recommandations — dédupliquées (même env+page+check, quel que soit le device/navigateur)
  report += "---\n\n## RECOMMANDATIONS\n\n";
  var issuesSeen = {};
  var allIssues  = [];
  for (var ri = 0; ri < envList.length; ri++) {
    var rEnvResults = allResults[envList[ri]];
    for (var rp = 0; rp < rEnvResults.length; rp++) {
      var rRes   = rEnvResults[rp];
      var rFails = rRes.checks.filter(function(c) { return c.critical && c.status === "FAIL"; });
      for (var rf = 0; rf < rFails.length; rf++) {
        var deduKey = rRes.env + "|" + rRes.page + "|" + rFails[rf].name;
        if (!issuesSeen[deduKey]) {
          issuesSeen[deduKey] = true;
          allIssues.push("[" + rRes.env + "] " + rRes.page + " - " + rFails[rf].name);
        }
      }
    }
  }

  if (allIssues.length === 0) {
    report += "Aucun probleme critique detecte. Tous les elements CSS critiques sont presents.\n";
  } else {
    report += "Problemes critiques a corriger :\n\n";
    for (var ai = 0; ai < allIssues.length; ai++) {
      report += "- " + allIssues[ai] + "\n";
    }
  }

  report += "\n---\n\n## SCREENSHOTS\n\nDossier : " + SCREENSHOTS_DIR + "\n";

  var filename = "AUDIT-CSS-Safran-" + envList.join("-") + "-" + Date.now() + ".md";
  var filepath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filepath, report, "utf8");
  return filepath;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  var args    = process.argv.slice(2);
  var envKeys = [];

  // ── URLs personnalisées (--urls=/news,/careers,/group) ─────────────────────
  // Fonction utilitaire : nettoyer une chaîne d'URLs brute
  function cleanRawUrls(raw) {
    return raw
      // Décoder TOUTES les entités HTML (avec ou sans point-virgule final)
      .replace(/&[a-z0-9]+;?/gi, function(e) {
        var map = { "&amp;":"&","&lt;":"","&gt;":"","&quot;":"","&#39;":"","&apos;":"" };
        var key = e.replace(/;$/, "").toLowerCase() + ";";
        return map[key] !== undefined ? map[key] : "";
      })
      // Supprimer les caractères non valides dans les paths
      .replace(/['"[\]<>]/g, "")
      // Supprimer les & résiduels (dangereux en shell Windows)
      .replace(/&/g, "");
  }

  // Support --urls-file= (fichier temporaire, évite les problèmes shell Windows)
  var urlsFileArg = args.find(function(a) { return a.startsWith("--urls-file="); });
  var urlsArg     = args.find(function(a) { return a.startsWith("--urls="); });
  var rawUrlsSource = "";

  if (urlsFileArg) {
    var tmpFile = urlsFileArg.replace("--urls-file=", "").trim();
    try {
      rawUrlsSource = require("fs").readFileSync(tmpFile, "utf8").trim();
      // Nettoyer le fichier temp après lecture
      try { require("fs").unlinkSync(tmpFile); } catch(e) {}
    } catch(e) {
      console.log("[URLs] Erreur lecture fichier temporaire : " + e.message);
    }
  } else if (urlsArg) {
    rawUrlsSource = urlsArg.replace("--urls=", "");
  }

  if (rawUrlsSource) {
    var rawUrls = cleanRawUrls(rawUrlsSource);

    // 3. Séparer sur virgule et découper les URLs concaténées (https://a.comhttps://b.com)
    var splitUrls = rawUrls
      .split(",")
      .map(function(u) { return u.trim(); })
      .filter(Boolean)
      .reduce(function(acc, chunk) {
        var parts = chunk.split(/(?=https?:\/\/)/);
        return acc.concat(parts.map(function(p) { return p.trim(); }).filter(Boolean));
      }, []);

    // 4. Dédupliquer et extraire le path de chaque URL
    var seen = {};
    var customPaths = [];
    splitUrls.forEach(function(u) {
      // Ignorer les fragments qui ne ressemblent pas à un chemin valide
      if (u.length < 2) return;
      var p;
      if (u.startsWith("http")) {
        var m = u.match(/^https?:\/\/[^\/]+(\/[^?#]*)?/);
        p = (m && m[1]) ? m[1] : "/";
      } else {
        // Nettoyer et normaliser le chemin
        p = u.startsWith("/") ? u : "/" + u;
        // Tronquer à la première séquence suspecte (balise HTML résiduelle)
        p = p.replace(/\].*$/, "").replace(/<.*$/, "").trim();
      }
      if (!p || p === "/" || seen[p]) return;
      seen[p] = true;
      customPaths.push(p);
    });

    if (customPaths.length > 0) {
      PAGES_TO_AUDIT = customPaths.map(function(p) {
        var seg   = p.replace(/^\//, "").split("/").filter(Boolean);
        var label = seg.length ? seg[seg.length - 1] : "Homepage";
        label = label.charAt(0).toUpperCase() + label.slice(1).replace(/-/g, " ").substring(0, 40);
        return { name: label, path: p };
      });
      console.log("[URLs] " + PAGES_TO_AUDIT.length + " URL(s) — paths : " +
        PAGES_TO_AUDIT.slice(0, 5).map(function(p) { return p.path; }).join(", ") +
        (PAGES_TO_AUDIT.length > 5 ? " (+" + (PAGES_TO_AUDIT.length - 5) + " autres)" : ""));
    }
  }

  // Chercher les noms d'env parmi les args non-flags (ignore --browsers=, --devices-file=, etc.)
  for (var i = 0; i < args.length; i++) {
    var a = args[i].toLowerCase();
    if (a.startsWith("--")) continue;
    if (ENVS[a]) envKeys.push(a);
    else console.log("[WARN] Argument inconnu : " + a);
  }
  // Aucun env explicite → tous par défaut (fonctionne même si seuls des flags sont passés)
  if (envKeys.length === 0) {
    envKeys = ["sophie", "paulo", "prod"];
    console.log("[ENV] Aucun environnement spécifié — audit sur : " + envKeys.join(", "));
  }

  // ── Navigateurs (--browsers=chromium,firefox,webkit) ──────────────────────
  var BROWSER_MAP = { chromium: chromium, firefox: firefox, webkit: webkit };
  var browsersArg = args.find(function(a) { return a.startsWith("--browsers="); });
  if (browsersArg) {
    var requestedBrowsers = browsersArg.replace("--browsers=", "").split(",").map(function(b) { return b.trim().toLowerCase(); });
    requestedBrowsers.forEach(function(b) {
      if (!BROWSER_MAP[b]) console.log("[WARN] Navigateur non supporté ignoré : \"" + b + "\" (supportés : chromium, firefox, webkit)");
    });
    var activeBrowsers = requestedBrowsers.filter(function(b) { return BROWSER_MAP[b]; });
  } else {
    var activeBrowsers = ["chromium"];
  }
  if (!activeBrowsers.length) activeBrowsers = ["chromium"];

  // ── Devices (--devices-file=path.json) ────────────────────────────────────
  var devicesFileArg = args.find(function(a) { return a.startsWith("--devices-file="); });
  var activeDevices = [{name:"desktop-hd", w:1440, h:900}]; // défaut
  if (devicesFileArg) {
    try {
      var devFile = devicesFileArg.replace("--devices-file=", "").trim();
      activeDevices = JSON.parse(fs.readFileSync(devFile, "utf8"));
      try { fs.unlinkSync(devFile); } catch(e) {}
    } catch(e) { console.log("[WARN] Devices file illisible : " + e.message); }
  }

  console.log("==================================================");
  console.log("  AGENT CSS AUDIT - ABY QA V2");
  console.log("  Environnements : " + envKeys.join(", "));
  console.log("  Navigateurs    : " + activeBrowsers.join(", "));
  console.log("  Devices        : " + activeDevices.map(function(d) { return d.name; }).join(", "));
  console.log("  Pages          : " + PAGES_TO_AUDIT.length + " par env");
  console.log("  Checks CSS     : " + CSS_CHECKS.length + " par page");
  console.log("  Total pages    : " + (envKeys.length * PAGES_TO_AUDIT.length * activeBrowsers.length * activeDevices.length));
  console.log("==================================================\n");

  var authDir    = path.join(__dirname, "auth");
  var allResults = {};

  // ── Boucle navigateurs ────────────────────────────────────────────────────
  for (var bi = 0; bi < activeBrowsers.length; bi++) {
    var browserName = activeBrowsers[bi];
    var browserEngine = BROWSER_MAP[browserName];
    if (activeBrowsers.length > 1) {
      console.log("\n▶ Navigateur : " + browserName.toUpperCase());
    }

    var browser = await browserEngine.launch({ headless: true });
    try {
      for (var ei = 0; ei < envKeys.length; ei++) {
        var envKey  = envKeys[ei];
        var env     = ENVS[envKey];
        console.log("[ENV] Audit de " + envKey.toUpperCase() + " (" + env.url + ") [" + browserName + "]");
        if (!allResults[envKey]) allResults[envKey] = [];

        // Charger la session sauvegardee si disponible (via login-save-state.js)
        var authFile    = path.join(authDir, envKey + ".json");
        var contextOpts = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" };

        // HTTP Basic auth par env (sophie/paulo ont un Basic Auth de staging)
        var httpAuthCfg = CFG.httpAuth && CFG.httpAuth[envKey];
        if (httpAuthCfg && httpAuthCfg.user && httpAuthCfg.pass) {
          contextOpts.httpCredentials = {
            username: httpAuthCfg.user,
            password: httpAuthCfg.pass,
            // Firefox ne renvoie pas systématiquement les credentials après un challenge 401 :
            // sendImmediately force l'envoi proactif (Authorization header dès la première requête)
            sendImmediately: (browserName === "firefox")
          };
          console.log("  [AUTH] HTTP Basic configuré pour " + envKey +
            " (user: " + httpAuthCfg.user + (browserName === "firefox" ? ", sendImmediately" : "") + ")");
        } else if (CFG.drupal.user && CFG.drupal.pass) {
          contextOpts.httpCredentials = {
            username: CFG.drupal.user,
            password: CFG.drupal.pass,
            sendImmediately: (browserName === "firefox")
          };
        }

        if (fs.existsSync(authFile)) {
          contextOpts.storageState = authFile;
          console.log("  [AUTH] Session chargee : auth/" + envKey + ".json");
        } else {
          console.log("  [AUTH] Aucune session trouvee pour " + envKey + " (lance login-save-state.js " + envKey + " pour la creer)");
        }

        // ── Boucle devices ────────────────────────────────────────────────────
        for (var di = 0; di < activeDevices.length; di++) {
          var vp = activeDevices[di] || {name:"desktop-hd", w:1440, h:900};
          if (activeDevices.length > 1) {
            console.log("  [DEVICE] " + vp.name + " (" + vp.w + "×" + vp.h + ")");
          }

          var context = await browser.newContext(contextOpts);
          var page    = await context.newPage();
          await page.setViewportSize({ width: vp.w, height: vp.h });

          // Accepter les cookies automatiquement si possible
          page.on("dialog", function(dialog) { dialog.dismiss().catch(function() {}); });

          for (var pi = 0; pi < PAGES_TO_AUDIT.length; pi++) {
            var pageConfig = PAGES_TO_AUDIT[pi];
            process.stdout.write("  [" + (pi + 1) + "/" + PAGES_TO_AUDIT.length + "] " + pageConfig.name +
              (activeDevices.length > 1 ? " [" + vp.name + "]" : "") + "... ");
            var result = await auditPage(page, env, pageConfig, browserName, vp);
            allResults[envKey].push(result);
          }

          await context.close();
          console.log("");
        } // fin boucle devices
      }

    } finally {
      await browser.close();
    }
  } // fin boucle navigateurs

  // Vérification : résultats collectés par env (aide au diagnostic)
  console.log("\n[RÉSULTATS] Résultats collectés :");
  Object.keys(allResults).forEach(function(k) {
    var tot  = allResults[k].length;
    var skip = allResults[k].filter(function(r) { return r.skipped; }).length;
    console.log("  " + k.toUpperCase() + " : " + tot + " résultat(s)" +
      (skip ? ", dont " + skip + " ignoré(s) (HTTP 4xx/timeout)" : ""));
  });

  var reportPath = generateReport(allResults);

  // Afficher le resume final
  console.log("==================================================");
  console.log("  AUDIT CSS TERMINE");
  console.log("==================================================");
  for (var si = 0; si < envKeys.length; si++) {
    var sEnv       = envKeys[si];
    var sResults   = allResults[sEnv] || [];
    var sTested    = sResults.filter(function(r) { return r.score !== null && r.score !== undefined; });
    var sSkipped   = sResults.filter(function(r) { return r.skipped; });
    var avgScore   = sTested.length ? Math.round(sTested.reduce(function(s, r) { return s + r.score; }, 0) / sTested.length) : null;
    var scoreLabel = avgScore === null ? "[?]" : (avgScore >= 80 ? "[OK]" : avgScore >= 50 ? "[~]" : "[X]");
    var skipNote   = sSkipped.length ? " (" + sSkipped.length + " ignorée(s) — HTTP 4xx)" : "";
    var scoreStr   = avgScore !== null ? avgScore + "% moyen" : "aucune page testée";
    console.log("  " + scoreLabel + " " + sEnv.toUpperCase() + " : " + scoreStr + skipNote);
  }
  console.log("\n  Rapport  : " + reportPath);
  console.log("  Screenshots : " + SCREENSHOTS_DIR);
  console.log("==================================================\n");
}

main().catch(function(e) { console.error("[ERR FATAL]", e.message); process.exit(1); });
