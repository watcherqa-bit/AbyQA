// agent-drupal.js - Creation de jeux de donnees dans le BO Drupal Safran
// Base sur l'audit du 24/02/2026 - 32 types completement automatisables
//
// Usage :
//   node agent-drupal.js "Creer 3 news sur l'aeronautique" sophie
//   node agent-drupal.js "Creer 5 events sur le salon du bourget" sophie
//   node agent-drupal.js "Creer 2 interviews sur l'innovation" paulo
//   node agent-drupal.js list   <- afficher tous les types disponibles

"use strict";


const fs       = require("fs");
const path     = require("path");
const http     = require("http");
const readline = require("readline");
const { chromium } = require("playwright");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CFG             = require("./config");
CFG.paths.init();
const SCREENSHOTS_DIR = CFG.paths.screenshots;
const REPORTS_DIR     = CFG.paths.reports;
const OLLAMA_MODEL    = CFG.ollama.model;

const ENVS = {
  sophie: {
    url:      CFG.envs.sophie,
    login:    "ismaila.traore.ext@safrangroup.com",
    password: CFG.drupal.pass
  },
  paulo: {
    url:      CFG.envs.paulo,
    login:    "ismaila.traore.ext@safrangroup.com",
    password: CFG.drupal.pass
  }
};

// ── CATALOGUE DES TYPES (base sur l'audit) ───────────────────────────────────
// Priorite 1 : Contenu editorial
// Priorite 2 : Donnees structurees
// Priorite 3 : Agregateurs / listes
const CONTENT_TYPES = {

  // ── PRIORITE 1 : EDITORIAL ──────────────────────────────────────────────────
  "news": {
    label:    "News",
    url:      "/node/add/news",
    priority: 1,
    status:   "COMPLET",
    fields: {
      title:   { sel: "#edit-title-0-value",           type: "text"   },
      topic:   { sel: "select[name*='field_topic']",   type: "select" },
      company: { sel: "input[id*='field_societe']",    type: "autocomplete" }
    }
  },

  "press_release": {
    label:    "Press Release",
    url:      "/node/add/press_release",
    priority: 1,
    status:   "PARTIEL",
    note:     "Media a ajouter manuellement",
    fields: {
      title:   { sel: "#edit-title-0-value",         type: "text"   },
      topic:   { sel: "select[name*='field_topic']", type: "select" }
    }
  },

  "interview": {
    label:    "Interview",
    url:      "/node/add/interview",
    priority: 1,
    status:   "COMPLET",
    fields: {
      title:   { sel: "#edit-title-0-value",         type: "text"   },
      topic:   { sel: "select[name*='field_topic']", type: "select" }
    }
  },

  // ── PRIORITE 2 : DONNEES STRUCTUREES ───────────────────────────────────────
  "event": {
    label:    "Event",
    url:      "/node/add/event",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title:   { sel: "#edit-title-0-value",         type: "text"   },
      topic:   { sel: "select[name*='field_topic']", type: "select" }
    }
  },

  "company": {
    label:    "Company",
    url:      "/node/add/society_page",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "commercial_sheet": {
    label:    "Commercial Sheet",
    url:      "/node/add/product",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "contact": {
    label:    "Contact",
    url:      "/node/add/contact",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "country": {
    label:    "Country",
    url:      "/node/add/country_page",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "historical_event": {
    label:    "Historical Event",
    url:      "/node/add/historical_event",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "question": {
    label:    "Question",
    url:      "/node/add/question",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "newsletter": {
    label:    "Newsletter",
    url:      "/node/add/newsletter",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "barometer": {
    label:    "Barometer",
    url:      "/node/add/barometer",
    priority: 2,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  // ── PRIORITE 3 : LISTES AGREGATEURS ────────────────────────────────────────
  "list_news": {
    label:    "List - News and interviews",
    url:      "/node/add/list_news_and_interviews",
    priority: 3,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "list_events": {
    label:    "List - Events",
    url:      "/node/add/list_events",
    priority: 3,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "list_press": {
    label:    "List - Press releases & Press kits",
    url:      "/node/add/list_press_releases_and_press_kits",
    priority: 3,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "list_contacts": {
    label:    "List - Contacts",
    url:      "/node/add/list_contacts",
    priority: 3,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "list_commercial": {
    label:    "List - Commercial sheets",
    url:      "/node/add/list_commercial_sheets",
    priority: 3,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "list_jobs": {
    label:    "List - job offers",
    url:      "/node/add/list_job_offers",
    priority: 3,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  },

  "list_global": {
    label:    "List - Global",
    url:      "/node/add/list_global",
    priority: 3,
    status:   "COMPLET",
    fields: {
      title: { sel: "#edit-title-0-value", type: "text" }
    }
  }
};

// ── DETECTION DU TYPE DEPUIS LA DEMANDE ──────────────────────────────────────
function detectType(userRequest) {
  var req = userRequest.toLowerCase();

  if (req.includes("press release") || req.includes("communique") || req.includes("press_release")) return "press_release";
  if (req.includes("interview"))                          return "interview";
  if (req.includes("event") || req.includes("evenement")) return "event";
  if (req.includes("company") || req.includes("societe")) return "company";
  if (req.includes("commercial") || req.includes("produit")) return "commercial_sheet";
  if (req.includes("contact"))                            return "contact";
  if (req.includes("country") || req.includes("pays"))   return "country";
  if (req.includes("historical") || req.includes("histoire")) return "historical_event";
  if (req.includes("question") || req.includes("faq"))   return "question";
  if (req.includes("newsletter"))                         return "newsletter";
  if (req.includes("barometer") || req.includes("barometre")) return "barometer";
  if (req.includes("list") && req.includes("job"))        return "list_jobs";
  if (req.includes("list") && req.includes("event"))      return "list_events";
  if (req.includes("list") && req.includes("press"))      return "list_press";
  if (req.includes("list") && req.includes("contact"))    return "list_contacts";
  if (req.includes("list") && req.includes("commercial")) return "list_commercial";
  if (req.includes("list"))                               return "list_news";
  return "news"; // defaut
}

function detectCount(userRequest) {
  var match = userRequest.match(/(\d+)/);
  if (match) return Math.min(parseInt(match[1]), 10);
  return 1;
}

function extractTopic(userRequest) {
  return userRequest
    .replace(/\d+/g, "")
    .replace(/creer?|crée?r?|news|press release|interview|event|evenement|company|contact|articles?|contenus?/gi, "")
    .replace(/sophie|paulo/gi, "")
    .trim() || "Safran aeronautique";
}

// ── OLLAMA ────────────────────────────────────────────────────────────────────
function callOllama(prompt) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ model: OLLAMA_MODEL, prompt: prompt, stream: false, options: { temperature: 0.7 } });
    var req  = http.request({
      hostname: CFG.ollama.host, port: CFG.ollama.port, path: "/api/generate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data).response || ""); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function extractJSON(text) {
  var match = text.match(/```json\s*([\s\S]*?)```/) ||
              text.match(/```\s*([\s\S]*?)```/)     ||
              text.match(/(\{[\s\S]*\})/);
  if (!match) throw new Error("Aucun JSON");
  return JSON.parse(match[1].trim().replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
}

async function generateContent(typeConfig, topic, count) {
  var prompt = "You are a copywriter for Safran, international aeronautics and defense group.\n" +
    "Generate " + count + " content item(s) about: \"" + topic + "\"\n" +
    "Content type: " + typeConfig.label + "\n" +
    "Respond ONLY in English (website language).\n\n" +
    "Respond ONLY with this exact JSON:\n" +
    "```json\n" +
    "{\n" +
    "  \"items\": [\n" +
    "    {\n" +
    "      \"title\": \"catchy title in English (max 100 chars)\",\n" +
    "      \"baseline\": \"short summary (max 70 chars)\",\n" +
    "      \"body\": \"3-4 sentences professional Safran tone\"\n" +
    "    }\n" +
    "  ]\n" +
    "}\n" +
    "```\n" +
    "Generate exactly " + count + " item(s).";

  console.log("[INFO] Generation du contenu via Ollama...");
  try {
    var response = await callOllama(prompt);
    var data     = extractJSON(response);
    return data.items || [];
  } catch (e) {
    console.log("[WARN] Ollama indisponible - contenu par defaut");
    return Array.from({ length: count }, function(_, i) {
      return {
        title:    typeConfig.label + " test " + (i + 1) + " - " + new Date().toLocaleDateString("fr-FR"),
        baseline: "Test content generated by Aby QA V2",
        body:     "This is test content number " + (i + 1) + " of type " + typeConfig.label + " created automatically by Aby QA V2."
      };
    });
  }
}

// ── PAUSE TERMINALE ───────────────────────────────────────────────────────────
function waitForEnter(msg) {
  return new Promise(function(resolve) {
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, function() { rl.close(); resolve(); });
  });
}

// ── CONNEXION DRUPAL ──────────────────────────────────────────────────────────
async function login(page, env) {
  console.log("[LOGIN] " + env.url + "/user/login");
  await page.goto(env.url + "/user/login", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Email
  var emailSels = ["#edit-name", "input[name='name']", "input[type='email']"];
  for (var i = 0; i < emailSels.length; i++) {
    if (await page.isVisible(emailSels[i]).catch(function() { return false; })) {
      await page.fill(emailSels[i], env.login);
      console.log("  [OK] Email : " + env.login);
      break;
    }
  }

  // Password
  var passSels = ["#edit-pass", "input[name='pass']", "input[type='password']"];
  for (var j = 0; j < passSels.length; j++) {
    if (await page.isVisible(passSels[j]).catch(function() { return false; })) {
      await page.fill(passSels[j], env.password);
      console.log("  [OK] Password rempli");
      break;
    }
  }

  // Submit
  var submitSels = ["#edit-submit", "input[value='Log in']", "button[type='submit']", ".form-submit"];
  for (var k = 0; k < submitSels.length; k++) {
    if (await page.isVisible(submitSels[k]).catch(function() { return false; })) {
      await page.click(submitSels[k]);
      console.log("  [OK] Formulaire soumis");
      break;
    }
  }

  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(function() {});

  console.log("");
  console.log("==================================================");
  console.log("  ETAPE 2FA - ACTION REQUISE");
  console.log("==================================================");
  console.log("  Regarde le navigateur.");
  console.log("  Si page 2FA : entre ton code 6 chiffres + VERIFY");
  console.log("  Si deja dans le BO : appuie sur ENTREE");
  console.log("==================================================");
  await waitForEnter("\n  >> ENTREE quand tu es dans le BO...\n");

  await page.waitForTimeout(2000);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(function() {});
  console.log("  [OK] URL : " + page.url() + "\n");
}

// ── REMPLIR UN CHAMP ──────────────────────────────────────────────────────────
async function fillField(page, fieldConfig, value) {
  if (!value) return false;

  try {
    var visible = await page.isVisible(fieldConfig.sel).catch(function() { return false; });
    if (!visible) return false;

    if (fieldConfig.type === "text" || fieldConfig.type === "textarea") {
      await page.fill(fieldConfig.sel, value);
      return true;
    }

    if (fieldConfig.type === "select") {
      // Essayer de selectionner la premiere option valide
      await page.selectOption(fieldConfig.sel, { index: 1 }).catch(function() {});
      return true;
    }

    if (fieldConfig.type === "autocomplete") {
      await page.fill(fieldConfig.sel, value);
      await page.waitForTimeout(800);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      return true;
    }

  } catch (e) {
    // Silencieux - champ non trouve
  }
  return false;
}

// ── CLIQUER SUR UN ONGLET ────────────────────────────────────────────────────
async function clickTab(page, tabName) {
  var tabSels = [
    "a:has-text('" + tabName + "')",
    ".horizontal-tabs-list a:has-text('" + tabName + "')",
    "[role='tab']:has-text('" + tabName + "')",
    "li a:has-text('" + tabName + "')"
  ];
  for (var i = 0; i < tabSels.length; i++) {
    var vis = await page.isVisible(tabSels[i]).catch(function() { return false; });
    if (vis) {
      await page.click(tabSels[i]);
      await page.waitForTimeout(600);
      console.log("    [OK] Onglet '" + tabName + "' active");
      return true;
    }
  }
  return false;
}

// ── CREATION D'UN CONTENU ────────────────────────────────────────────────────
async function createContent(page, env, typeKey, typeConfig, item, index) {
  console.log("  [" + index + "] Creation : \"" + item.title + "\"");

  await page.goto(env.url + typeConfig.url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  var fieldsOK = 0;
  var shotPath = path.join(SCREENSHOTS_DIR, "drupal-" + typeKey + "-" + index + "-" + Date.now() + ".png");

  // ETAPE 1 : Onglet Settings - remplir Topic et Company (champs obligatoires)
  console.log("    [->] Onglet Settings...");

  // TOPIC : champ = field_unified_theme (select simple)
  var topicFilled = false;
  var topicSels = [
    "select[name='field_unified_theme']",
    "select[name*='unified_theme']",
    "select[name*='field_topic']",
    "#edit-field-unified-theme",
    "select[id*='unified-theme']",
    "select[id*='topic']"
  ];
  for (var t = 0; t < topicSels.length; t++) {
    var tvis = await page.isVisible(topicSels[t]).catch(function() { return false; });
    if (tvis) {
      var opts = await page.$$eval(topicSels[t] + " option", function(els) {
        return els.filter(function(o) { return o.value && o.value !== "_none" && o.value !== ""; }).map(function(o) { return o.value; });
      }).catch(function() { return []; });
      if (opts.length > 0) {
        await page.selectOption(topicSels[t], opts[0]);
        console.log("    [OK] Topic selectionne : " + opts[0]);
        fieldsOK++;
        topicFilled = true;
      }
      break;
    }
  }
  if (!topicFilled) console.log("    [!] Topic non rempli");

  // COMPANY : champ = field_m_unified_company[] (select multiple avec 94 options)
  // Selectionner TOUTES les options via JavaScript evaluate
  var companyDone = false;
  var companySels = [
    "select[name='field_m_unified_company[]']",
    "select[name*='unified_company']",
    "select[name*='field_m_unified_company']",
    "#edit-field-m-unified-company",
    "select[id*='unified-company']",
    "select[id*='company']"
  ];
  for (var ca = 0; ca < companySels.length; ca++) {
    var cavis = await page.isVisible(companySels[ca]).catch(function() { return false; });
    if (cavis) {
      // Selectionner toutes les options du select multiple via JS
      var companyCount = await page.evaluate(function(sel) {
        var el = document.querySelector(sel);
        if (!el) return 0;
        var count = 0;
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].value && el.options[i].value !== "") {
            el.options[i].selected = true;
            count++;
          }
        }
        // Declencher l'evenement change
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return count;
      }, companySels[ca]).catch(function() { return 0; });

      if (companyCount > 0) {
        console.log("    [OK] Company -> " + companyCount + " options selectionnees");
        fieldsOK++;
        companyDone = true;
      }
      break;
    }
  }
  if (!companyDone) {
    // Fallback : selectionner juste la premiere option company
    var firstCompOpt = await page.$$eval("select[name*='company'] option, select[id*='company'] option", function(els) {
      return els.filter(function(o) { return o.value && o.value !== ""; }).map(function(o) { return o.value; }).slice(0, 1);
    }).catch(function() { return []; });
    if (firstCompOpt.length > 0) {
      await page.selectOption("select[name*='company'], select[id*='company']", firstCompOpt[0]).catch(function() {});
      console.log("    [OK] Company -> premiere option : " + firstCompOpt[0]);
      fieldsOK++;
      companyDone = true;
    }
  }
  if (!companyDone) console.log("    [!] Company non rempli");

  // ETAPE 2 : Onglet General - remplir Titre et Corps
  console.log("    [->] Onglet General...");
  await clickTab(page, "General");
  await page.waitForTimeout(800);

  // Titre
  var titleSels = [
    "#edit-title-0-value",
    "input[name='title[0][value]']",
    "input[data-drupal-selector='edit-title-0-value']",
    "input[id*='title']"
  ];
  for (var ti = 0; ti < titleSels.length; ti++) {
    var tivis = await page.isVisible(titleSels[ti]).catch(function() { return false; });
    if (tivis) {
      await page.fill(titleSels[ti], item.title);
      console.log("    [OK] Titre : " + item.title.substring(0, 40) + "...");
      fieldsOK++;
      break;
    }
  }

  // Corps / Body - CKEditor ou textarea
  var bodySels = [
    ".ck-editor__editable[role='textbox']",
    ".ck-content[contenteditable='true']",
    "div.ck-editor__editable",
    "textarea[data-drupal-selector*='body']",
    "textarea[name*='body']",
    "#edit-body-0-value"
  ];
  for (var b = 0; b < bodySels.length; b++) {
    var bvis = await page.isVisible(bodySels[b]).catch(function() { return false; });
    if (bvis) {
      try {
        await page.click(bodySels[b]);
        await page.waitForTimeout(300);
        // Selectionner tout et remplacer (evite d'ajouter au texte existant)
        await page.keyboard.press("Control+a");
        await page.keyboard.type(item.body || item.baseline || "Test content by Aby QA V2");
        console.log("    [OK] Corps rempli");
        fieldsOK++;
      } catch (e) {
        console.log("    [!] Corps non rempli : " + e.message);
      }
      break;
    }
  }

  // Screenshot avant sauvegarde
  await page.screenshot({ path: shotPath, fullPage: false });

  // ETAPE 3 : Sauvegarder
  console.log("    [->] Sauvegarde...");
  var saved = false;

  // Chercher le bouton Save en bas de page
  var saveSels = [
    "input[id='edit-submit']",
    "input[value='Save']",
    "button[value='Save']",
    ".form-submit",
    "input[type='submit']"
  ];
  for (var s = 0; s < saveSels.length; s++) {
    var svis = await page.isVisible(saveSels[s]).catch(function() { return false; });
    if (svis) {
      await page.click(saveSels[s]);
      saved = true;
      console.log("    [OK] Bouton Save clique");
      break;
    }
  }

  // Si bouton pas trouve, scroller en bas et reessayer
  if (!saved) {
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(500);
    for (var s2 = 0; s2 < saveSels.length; s2++) {
      var s2vis = await page.isVisible(saveSels[s2]).catch(function() { return false; });
      if (s2vis) {
        await page.click(saveSels[s2]);
        saved = true;
        console.log("    [OK] Bouton Save clique (apres scroll)");
        break;
      }
    }
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(function() {});
  await page.waitForTimeout(1500);

  var finalUrl = page.url();
  var success  = finalUrl.includes("/node/") && !finalUrl.includes("/add/") && !finalUrl.includes("/node/add");

  // Si echec : screenshot pour voir les erreurs de validation Drupal
  if (!success) {
    var errorShot = path.join(SCREENSHOTS_DIR, "drupal-ERROR-" + index + "-" + Date.now() + ".png");
    await page.screenshot({ path: errorShot, fullPage: true });
    // Lire les messages d'erreur Drupal
    var errors = await page.$$eval(
      ".messages--error, .alert-danger, [class*='error'] li, .form-item--error-message",
      function(els) { return els.map(function(e) { return e.textContent.trim(); }); }
    ).catch(function() { return []; });
    if (errors.length > 0) {
      console.log("    [!] Erreurs Drupal : " + errors.join(" | ").substring(0, 200));
    }
    console.log("    [!] Screenshot erreur : " + errorShot);
  }

  console.log("    " + (success ? "[OK] Cree !" : "[!] A verifier") + " -> " + finalUrl);

  return { title: item.title, url: finalUrl, screenshot: shotPath, success: success, fieldsOK: fieldsOK };
}

// ── RAPPORT ───────────────────────────────────────────────────────────────────
function generateReport(env, typeKey, typeConfig, results) {
  var date    = new Date().toLocaleString("fr-FR");
  var success = results.filter(function(r) { return r.success; }).length;

  var report = "# Rapport Creation Drupal - " + typeConfig.label + "\n\n";
  report += "- Environnement : " + env.name + "\n";
  report += "- Type : " + typeConfig.label + "\n";
  report += "- Date : " + date + "\n";
  report += "- Resultat : " + success + "/" + results.length + " crees\n\n";
  report += "## Contenus\n\n";

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    report += "### " + (r.success ? "[OK]" : "[!]") + " " + r.title + "\n";
    report += "- URL : " + r.url + "\n";
    report += "- Screenshot : " + r.screenshot + "\n\n";
  }

  var filename = "drupal-" + typeKey + "-" + env.name + "-" + Date.now() + ".md";
  var filepath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filepath, report, "utf8");
  return filepath;
}

// ── AFFICHER LA LISTE DES TYPES ───────────────────────────────────────────────
function showList() {
  console.log("\n==================================================");
  console.log("  TYPES DE CONTENU DISPONIBLES");
  console.log("==================================================");
  console.log("\n  PRIORITE 1 - Editorial :");
  var types = Object.keys(CONTENT_TYPES);
  for (var i = 0; i < types.length; i++) {
    var t = CONTENT_TYPES[types[i]];
    var status = t.status === "COMPLET" ? "[OK]" : "[~]";
    var note   = t.note ? " (" + t.note + ")" : "";
    if (t.priority === 1) console.log("  " + status + " " + types[i] + " -> " + t.label + note);
  }
  console.log("\n  PRIORITE 2 - Donnees structurees :");
  for (var j = 0; j < types.length; j++) {
    var t2 = CONTENT_TYPES[types[j]];
    if (t2.priority === 2) console.log("  [OK] " + types[j] + " -> " + t2.label);
  }
  console.log("\n  PRIORITE 3 - Listes agregateurs :");
  for (var k = 0; k < types.length; k++) {
    var t3 = CONTENT_TYPES[types[k]];
    if (t3.priority === 3) console.log("  [OK] " + types[k] + " -> " + t3.label);
  }
  console.log("\n  Usage :");
  console.log("  node agent-drupal.js \"Creer 3 news sur l'aeronautique\" sophie");
  console.log("  node agent-drupal.js \"Creer 5 events sur le salon\" paulo");
  console.log("==================================================\n");
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  var userRequest = process.argv[2];
  var envArg      = (process.argv[3] || "sophie").toLowerCase();

  // Commande speciale : lister les types
  if (!userRequest || userRequest === "list") {
    showList();
    process.exit(0);
  }

  // Securite PROD
  if (envArg === "prod") {
    console.error("[SECURITE] Creation de contenu interdite sur PROD.");
    console.error("[SECURITE] Utilise sophie ou paulo.");
    process.exit(1);
  }

  var env = ENVS[envArg];
  if (!env) {
    console.error("[ERR] Environnement inconnu : " + envArg);
    process.exit(1);
  }
  env.name = envArg;

  var typeKey    = detectType(userRequest);
  var typeConfig = CONTENT_TYPES[typeKey];
  var count      = detectCount(userRequest);
  var topic      = extractTopic(userRequest);

  console.log("==================================================");
  console.log("  AGENT DRUPAL - ABY QA V2");
  console.log("==================================================");
  console.log("  Demande : " + userRequest);
  console.log("  Type    : " + typeConfig.label + " [" + typeConfig.status + "]");
  console.log("  Nombre  : " + count);
  console.log("  Sujet   : " + topic);
  console.log("  Env     : " + envArg + " -> " + env.url);
  if (typeConfig.note) console.log("  Note    : " + typeConfig.note);
  console.log("==================================================\n");

  [SCREENSHOTS_DIR, REPORTS_DIR].forEach(function(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // Generer le contenu
  var items = await generateContent(typeConfig, topic, count);
  console.log("[OK] " + items.length + " contenu(s) genere(s)\n");

  // Lancer le navigateur en mode visible
  var browser = await chromium.launch({ headless: false, slowMo: 100 });
  var page    = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  var results = [];

  try {
    await login(page, env);

    console.log("[CREATION] Debut de la creation...\n");
    for (var i = 0; i < items.length; i++) {
      var r = await createContent(page, env, typeKey, typeConfig, items[i], i + 1);
      results.push(r);
      await page.waitForTimeout(1500);
    }

  } catch (e) {
    console.error("[ERR] " + e.message);
  } finally {
    await page.waitForTimeout(2000);
    await browser.close();
  }

  var reportPath = generateReport(env, typeKey, typeConfig, results);
  var ok         = results.filter(function(r) { return r.success; }).length;

  console.log("\n==================================================");
  console.log("  RESULTAT : " + ok + "/" + results.length + " crees avec succes");
  for (var j = 0; j < results.length; j++) {
    console.log("  " + (results[j].success ? "[OK]" : "[!]") + " " + results[j].title);
  }
  console.log("  Rapport : " + reportPath);
  console.log("==================================================\n");

  process.exit(ok === results.length ? 0 : 1);
}

main().catch(function(e) { console.error("[ERR FATAL]", e.message); process.exit(1); });
