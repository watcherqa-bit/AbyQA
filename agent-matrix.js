// agent-matrix.js — Matrice de traçabilité QA par release (exceljs, pur Node.js)
// Fusionne données Jira + enriched AbyQA (stratégie IA, score, risque)
//
// Usage :
//   node agent-matrix.js v1.25.0
//   node agent-matrix.js v1.25.0 --output=matrice-v1.25.0.xlsx
//   Programmable : require("./agent-matrix").generate("v1.25.0")

"use strict";

var fs   = require("fs");
var path = require("path");
var https = require("https");
var CFG  = require("./config");
CFG.paths.init();

var REPORTS_DIR  = CFG.paths.reports;
var ENRICHED_DIR = path.join(__dirname, "inbox", "enriched");
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ── COULEURS ────────────────────────────────────────────────────────────────────
var COLORS = {
  safranBlue: "003580",
  white:      "FFFFFF",
  greyLight:  "F5F5F5",
  greyHeader: "DEE2E6",
  greenLight: "D4EDDA",
  greenDark:  "198754",
  redLight:   "F8D7DA",
  redDark:    "DC3545",
  orangeLight:"FFF3CD",
  orangeDark: "FD7E14",
  blueLight:  "EBF5FB",
  purpleLight:"F3E8FF",
  cyanLight:  "E0F7FA",
  cyanDark:   "0891B2"
};

// ── JIRA API ────────────────────────────────────────────────────────────────────
function jiraGet(apiPath) {
  return new Promise(function(resolve, reject) {
    var auth = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var options = {
      hostname: CFG.jira.host,
      path:     apiPath,
      method:   "GET",
      headers:  { "Authorization": "Basic " + auth, "Accept": "application/json" }
    };
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON parse error : " + data.substring(0, 200))); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── RECUPERER TICKETS JIRA ──────────────────────────────────────────────────────
async function fetchReleaseTickets(version) {
  console.log("[MATRIX] Récupération tickets Jira pour " + version + "...");
  var allIssues = [];
  var startAt = 0, total = 999;

  while (startAt < total) {
    var jql = encodeURIComponent(
      "project = " + CFG.jira.project +
      ' AND labels = "' + version + '"' +
      " ORDER BY issuetype ASC, status ASC"
    );
    var url = "/rest/api/3/search/jql?jql=" + jql +
      "&startAt=" + startAt + "&maxResults=50" +
      "&fields=summary,issuetype,status,priority,assignee,labels,issuelinks,comment,customfield_10077";

    var result = await jiraGet(url);
    total = result.total || 0;
    var issues = result.issues || [];
    allIssues = allIssues.concat(issues);
    startAt += issues.length;
    if (issues.length === 0) break;
    await new Promise(function(r) { setTimeout(r, 200); });
  }

  console.log("[MATRIX] " + allIssues.length + " tickets Jira récupérés");
  return allIssues;
}

// ── EXTRAIRE INFOS D'UN TICKET JIRA ─────────────────────────────────────────────
function extractTicketInfo(issue) {
  var fields = issue.fields || {};
  var links  = fields.issuelinks || [];

  var testLinks = links.filter(function(l) {
    var linked = l.inwardIssue || l.outwardIssue;
    return linked && linked.fields && linked.fields.issuetype &&
           (linked.fields.issuetype.name === "Test" || linked.fields.issuetype.name === "Test Case");
  }).map(function(l) { return (l.inwardIssue || l.outwardIssue).key; });

  var bugLinks = links.filter(function(l) {
    var linked = l.inwardIssue || l.outwardIssue;
    return linked && linked.fields && linked.fields.issuetype &&
           linked.fields.issuetype.name === "Bug";
  }).map(function(l) { return (l.inwardIssue || l.outwardIssue).key; });

  var testsField = fields.customfield_10077 || "";
  var tcList = [];
  if (testsField) {
    var tcMatches = testsField.match(/TC\d+[^:)}\n]*/g) || [];
    tcMatches.forEach(function(tc) {
      var clean = tc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 80);
      if (clean.length > 3) tcList.push(clean);
    });
  }

  var comments    = (fields.comment && fields.comment.comments) || [];
  var lastComment = comments.length > 0 ? comments[comments.length - 1].body : "";
  var testStatut  = "";
  if (/ok sur sophie|ok\n/i.test(lastComment)) testStatut = "PASS";
  else if (/ko|fail/i.test(lastComment)) testStatut = "FAIL";
  else if (fields.status && fields.status.name === "To Test UAT") testStatut = "A TESTER";
  else if (fields.status && /^(Done|Closed)$/.test(fields.status.name)) testStatut = "PASS";

  return {
    key:        issue.key,
    titre:      fields.summary || "",
    type:       fields.issuetype ? fields.issuetype.name : "",
    statut:     fields.status ? fields.status.name : "",
    priorite:   fields.priority ? fields.priority.name : "",
    assignee:   fields.assignee ? fields.assignee.displayName : "Non assigné",
    labels:     (fields.labels || []).join(", "),
    testsLies:  testLinks.join(", "),
    bugs:       bugLinks.join(", "),
    tcList:     tcList,
    testStatut: testStatut,
    nbComments: comments.length
  };
}

// ── CHARGER DONNÉES ENRICHIES AbyQA ─────────────────────────────────────────────
function loadEnrichedData() {
  var enriched = {};
  if (!fs.existsSync(ENRICHED_DIR)) return enriched;
  var files = fs.readdirSync(ENRICHED_DIR).filter(function(f) { return f.endsWith(".json"); });
  files.forEach(function(f) {
    try {
      var data = JSON.parse(fs.readFileSync(path.join(ENRICHED_DIR, f), "utf8"));
      if (data.key) enriched[data.key] = data;
    } catch(e) { console.error("  [WARN] Lecture enriched:", e.message); }
  });
  return enriched;
}

// ── CHARGER RELEASE TRACKER ─────────────────────────────────────────────────────
function loadReleaseTracker(version) {
  var trackerPath = path.join(REPORTS_DIR, "release-tracker.json");
  if (!fs.existsSync(trackerPath)) return null;
  try {
    var tracker = JSON.parse(fs.readFileSync(trackerPath, "utf8"));
    return tracker[version] || null;
  } catch(e) { return null; }
}

// ── FUSIONNER JIRA + ENRICHED + TRACKER ─────────────────────────────────────────
function mergeData(jiraTickets, enrichedMap, tracker) {
  var trackerMap = {};
  if (tracker && tracker.tickets) {
    tracker.tickets.forEach(function(t) { trackerMap[t.key] = t; });
  }

  return jiraTickets.map(function(t) {
    var e = enrichedMap[t.key] || {};
    var r = trackerMap[t.key] || {};

    // Enrichir avec données AbyQA
    t.strategy   = e.strategy || null;
    t.confidence = (e.analysis && e.analysis.confidence) || null;
    t.risk       = (e.analysis && e.analysis.risk) || null;
    t.complexity = (e.analysis && e.analysis.complexity) || null;
    t.score      = e.score || null;
    t.reasoning  = (e.analysis && e.analysis.reasoning) || null;
    t.enrichStatus = e.status || null;

    // Enrichir avec données tracker (résultats Playwright)
    if (r.status && !t.testStatut) t.testStatut = r.status;
    if (r.pass)  t.pwPass  = r.pass;
    if (r.fail)  t.pwFail  = r.fail;
    if (r.total) t.pwTotal = r.total;
    if (r.bugs)  t.pwBugs  = r.bugs;
    if (r.pct !== undefined) t.pwQuality = r.pct;

    return t;
  });
}

// ── GENERER EXCEL AVEC EXCELJS ──────────────────────────────────────────────────
async function generateExcel(version, tickets, outputPath) {
  var ExcelJS = require("exceljs");
  var wb = new ExcelJS.Workbook();
  wb.creator = "AbyQA";
  wb.created = new Date();

  var now = new Date().toLocaleDateString("fr-FR") + " " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  // ── Helper styles ──
  function headerFill(color) { return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + (color || COLORS.safranBlue) } }; }
  function lightFill(color) { return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + color } }; }
  var thinBorder = { top: { style: "thin", color: { argb: "FFCCCCCC" } }, bottom: { style: "thin", color: { argb: "FFCCCCCC" } }, left: { style: "thin", color: { argb: "FFCCCCCC" } }, right: { style: "thin", color: { argb: "FFCCCCCC" } } };
  var headerFont = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 9 };
  var bodyFont   = { name: "Arial", size: 9 };
  var monoFont   = { name: "Consolas", size: 9 };

  function statusFill(statut) {
    var s = (statut || "").toUpperCase();
    if (/PASS|DONE|CLOSED/.test(s)) return lightFill(COLORS.greenLight);
    if (/FAIL|KO/.test(s))          return lightFill(COLORS.redLight);
    if (/TESTER|UAT|TEST/.test(s))   return lightFill(COLORS.orangeLight);
    if (/BLOCKED/.test(s))           return lightFill(COLORS.orangeLight);
    return lightFill(COLORS.greyLight);
  }

  function strategyFill(strat) {
    if (!strat) return lightFill(COLORS.greyLight);
    var s = strat.toLowerCase();
    if (s === "e2e")    return lightFill(COLORS.blueLight);
    if (s === "api")    return lightFill(COLORS.orangeLight);
    if (s === "css")    return lightFill(COLORS.purpleLight);
    if (s === "drupal") return lightFill(COLORS.purpleLight);
    if (s === "manual") return lightFill(COLORS.redLight);
    if (s === "mix")    return lightFill(COLORS.cyanLight);
    return lightFill(COLORS.greyLight);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // FEUILLE 1 : MATRICE TRAÇABILITÉ
  // ══════════════════════════════════════════════════════════════════════════════
  var ws1 = wb.addWorksheet("Matrice " + version);

  // Titre
  ws1.mergeCells("A1:N1");
  var titleCell = ws1.getCell("A1");
  titleCell.value = "MATRICE DE TRAÇABILITÉ QA — Release " + version + " — " + CFG.jira.project;
  titleCell.font  = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 12 };
  titleCell.fill  = headerFill();
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws1.getRow(1).height = 30;

  // Sous-titre
  ws1.mergeCells("A2:N2");
  var subCell = ws1.getCell("A2");
  subCell.value = "Généré automatiquement par AbyQA — " + now;
  subCell.font  = { italic: true, color: { argb: "FF666666" }, name: "Arial", size: 8 };
  subCell.alignment = { horizontal: "center" };

  // En-têtes (14 colonnes : +4 colonnes IA)
  var headers = [
    { name: "Ticket",       width: 15 },
    { name: "Titre",        width: 40 },
    { name: "Type",         width: 13 },
    { name: "Assignee",     width: 18 },
    { name: "Statut Jira",  width: 15 },
    { name: "Ticket Test",  width: 14 },
    { name: "Cas de test",  width: 30 },
    { name: "Statut QA",    width: 12 },
    { name: "Bugs liés",    width: 14 },
    { name: "Preuves",      width: 20 },
    // Colonnes AbyQA (internes)
    { name: "Stratégie IA", width: 14 },
    { name: "Score US",     width: 10 },
    { name: "Risque",       width: 12 },
    { name: "Confiance IA", width: 12 }
  ];

  var headerRow = ws1.getRow(3);
  headerRow.height = 25;
  headers.forEach(function(h, i) {
    var cell = headerRow.getCell(i + 1);
    cell.value  = h.name;
    cell.font   = headerFont;
    cell.fill   = i < 10 ? headerFill() : headerFill(COLORS.cyanDark);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder;
    ws1.getColumn(i + 1).width = h.width;
  });

  // Données
  tickets.forEach(function(t, idx) {
    var row = ws1.getRow(idx + 4);
    var rowBg = /Story|User Story/.test(t.type) ? COLORS.blueLight :
                t.type === "Bug" ? COLORS.greyLight : COLORS.white;

    var tcText = (t.tcList || []).slice(0, 5).join("\n");
    if ((t.tcList || []).length > 5) tcText += "\n... +" + (t.tcList.length - 5) + " autres";

    var values = [
      t.key,
      t.titre,
      t.type,
      t.assignee,
      t.statut,
      t.testsLies || "-",
      tcText || "-",
      t.testStatut || "-",
      t.bugs || "-",
      "",
      t.strategy ? t.strategy.toUpperCase() : "-",
      t.score ? t.score + "/100" : "-",
      t.risk || "-",
      t.confidence ? t.confidence + "%" : "-"
    ];

    values.forEach(function(val, ci) {
      var cell = row.getCell(ci + 1);
      cell.value  = val;
      cell.font   = ci >= 10 ? monoFont : bodyFont;
      cell.border = thinBorder;
      cell.alignment = { vertical: "middle", wrapText: true };

      if (ci === 7)       cell.fill = statusFill(t.testStatut);
      else if (ci === 10) cell.fill = strategyFill(t.strategy);
      else if (ci === 11) {
        var sc = t.score || 0;
        cell.fill = sc >= 70 ? lightFill(COLORS.greenLight) : sc >= 40 ? lightFill(COLORS.orangeLight) : sc > 0 ? lightFill(COLORS.redLight) : lightFill(COLORS.greyLight);
      }
      else cell.fill = lightFill(rowBg);

      if ([0, 2, 5, 7, 8, 10, 11, 12, 13].indexOf(ci) >= 0) {
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      }
    });

    row.height = Math.max(18, Math.min((t.tcList || []).length, 5) * 15);
  });

  ws1.views = [{ state: "frozen", ySplit: 3 }];
  ws1.autoFilter = { from: "A3", to: "N" + (tickets.length + 3) };

  // ══════════════════════════════════════════════════════════════════════════════
  // FEUILLE 2 : STATISTIQUES + ANALYSE IA
  // ══════════════════════════════════════════════════════════════════════════════
  var ws2 = wb.addWorksheet("Stats " + version);
  ws2.getColumn(1).width = 30;
  ws2.getColumn(2).width = 15;
  ws2.getColumn(3).width = 5;
  ws2.getColumn(4).width = 30;
  ws2.getColumn(5).width = 15;

  // Titre
  ws2.mergeCells("A1:E1");
  var s2Title = ws2.getCell("A1");
  s2Title.value = "STATISTIQUES & ANALYSE IA — Release " + version;
  s2Title.font  = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 11 };
  s2Title.fill  = headerFill();
  s2Title.alignment = { horizontal: "center", vertical: "middle" };
  ws2.getRow(1).height = 28;

  // Compteurs
  var types = {}, stratCounts = {}, riskCounts = {};
  var qaStats = { PASS: 0, FAIL: 0, "A TESTER": 0, BLOCKED: 0, "": 0 };
  var totalScore = 0, scoreCount = 0;

  tickets.forEach(function(t) {
    types[t.type] = (types[t.type] || 0) + 1;
    if (t.strategy) stratCounts[t.strategy] = (stratCounts[t.strategy] || 0) + 1;
    if (t.risk) riskCounts[t.risk] = (riskCounts[t.risk] || 0) + 1;
    var k = t.testStatut in qaStats ? t.testStatut : "";
    qaStats[k]++;
    if (t.score) { totalScore += t.score; scoreCount++; }
  });

  var total = tickets.length;
  var avecTest = tickets.filter(function(t) { return t.testsLies; }).length;
  var avecBug  = tickets.filter(function(t) { return t.bugs; }).length;
  var avgScore = scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0;

  function writeStatsBlock(ws, startRow, col, title, items) {
    var r = startRow;
    var titleCell = ws.getCell(r, col);
    titleCell.value = title;
    titleCell.font  = headerFont;
    titleCell.fill  = headerFill();
    titleCell.border = thinBorder;
    ws.mergeCells(r, col, r, col + 1);
    r++;

    items.forEach(function(item) {
      var c1 = ws.getCell(r, col);
      var c2 = ws.getCell(r, col + 1);
      c1.value = item.label;
      c2.value = item.value;
      c1.font  = bodyFont;
      c2.font  = { bold: true, name: "Arial", size: 9 };
      c1.border = thinBorder;
      c2.border = thinBorder;
      if (item.fill) c2.fill = lightFill(item.fill);
      r++;
    });
    return r + 1;
  }

  // Colonne gauche : stats classiques
  var r = 3;
  r = writeStatsBlock(ws2, r, 1, "RÉPARTITION PAR TYPE",
    Object.keys(types).sort(function(a, b) { return types[b] - types[a]; }).map(function(k) {
      return { label: k || "Inconnu", value: types[k] };
    })
  );

  r = writeStatsBlock(ws2, r, 1, "STATUTS QA",
    [
      { label: "PASS",         value: qaStats.PASS,       fill: COLORS.greenLight },
      { label: "FAIL",         value: qaStats.FAIL,       fill: COLORS.redLight },
      { label: "A TESTER",     value: qaStats["A TESTER"], fill: COLORS.orangeLight },
      { label: "BLOCKED",      value: qaStats.BLOCKED,    fill: COLORS.orangeLight },
      { label: "Non renseigné", value: qaStats[""] }
    ]
  );

  r = writeStatsBlock(ws2, r, 1, "TRAÇABILITÉ",
    [
      { label: "Total tickets",    value: total },
      { label: "Avec ticket Test", value: avecTest },
      { label: "Avec bug lié",     value: avecBug },
      { label: "Taux couverture",  value: total > 0 ? Math.round(avecTest / total * 100) + "%" : "0%",
        fill: avecTest / total >= 0.8 ? COLORS.greenLight : avecTest / total >= 0.5 ? COLORS.orangeLight : COLORS.redLight }
    ]
  );

  // Colonne droite : stats IA AbyQA
  var r2 = 3;
  r2 = writeStatsBlock(ws2, r2, 4, "STRATÉGIES IA",
    Object.keys(stratCounts).sort(function(a, b) { return stratCounts[b] - stratCounts[a]; }).map(function(k) {
      return { label: k.toUpperCase(), value: stratCounts[k] };
    })
  );

  r2 = writeStatsBlock(ws2, r2, 4, "NIVEAUX DE RISQUE",
    Object.keys(riskCounts).sort().map(function(k) {
      var fill = /critique|élevé|high/i.test(k) ? COLORS.redLight :
                 /moyen|medium/i.test(k) ? COLORS.orangeLight : COLORS.greenLight;
      return { label: k, value: riskCounts[k], fill: fill };
    })
  );

  r2 = writeStatsBlock(ws2, r2, 4, "QUALITÉ DES US (AbyQA)",
    [
      { label: "Score moyen",         value: avgScore + "/100",
        fill: avgScore >= 70 ? COLORS.greenLight : avgScore >= 40 ? COLORS.orangeLight : COLORS.redLight },
      { label: "US analysées",        value: scoreCount + "/" + total },
      { label: "US enrichies (auto)", value: tickets.filter(function(t) { return t.enrichStatus; }).length }
    ]
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // FEUILLE 3 : DÉTAIL PAR TICKET (vue complète)
  // ══════════════════════════════════════════════════════════════════════════════
  var ws3 = wb.addWorksheet("Détail " + version);

  ws3.mergeCells("A1:H1");
  var s3Title = ws3.getCell("A1");
  s3Title.value = "DÉTAIL PAR TICKET — Release " + version;
  s3Title.font  = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 11 };
  s3Title.fill  = headerFill();
  s3Title.alignment = { horizontal: "center", vertical: "middle" };
  ws3.getRow(1).height = 28;

  var detailHeaders = [
    { name: "Ticket",       width: 15 },
    { name: "Titre",        width: 40 },
    { name: "Type",         width: 13 },
    { name: "Statut QA",    width: 12 },
    { name: "Stratégie IA", width: 14 },
    { name: "Score",        width: 10 },
    { name: "Risque",       width: 14 },
    { name: "Justification IA", width: 50 }
  ];

  var dHeaderRow = ws3.getRow(2);
  dHeaderRow.height = 22;
  detailHeaders.forEach(function(h, i) {
    var cell = dHeaderRow.getCell(i + 1);
    cell.value = h.name;
    cell.font  = headerFont;
    cell.fill  = headerFill();
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder;
    ws3.getColumn(i + 1).width = h.width;
  });

  tickets.forEach(function(t, idx) {
    var row = ws3.getRow(idx + 3);
    var vals = [
      t.key, t.titre, t.type, t.testStatut || "-",
      t.strategy ? t.strategy.toUpperCase() : "-",
      t.score ? t.score + "/100" : "-",
      t.risk || "-",
      t.reasoning || "-"
    ];

    vals.forEach(function(val, ci) {
      var cell = row.getCell(ci + 1);
      cell.value = val;
      cell.font  = bodyFont;
      cell.border = thinBorder;
      cell.alignment = { vertical: "middle", wrapText: ci === 7 };
      if (ci === 3) cell.fill = statusFill(t.testStatut);
      if (ci === 4) cell.fill = strategyFill(t.strategy);
    });
    row.height = t.reasoning ? 30 : 18;
  });

  ws3.views = [{ state: "frozen", ySplit: 2 }];
  ws3.autoFilter = { from: "A2", to: "H" + (tickets.length + 2) };

  // ══════════════════════════════════════════════════════════════════════════════
  // SAUVEGARDER
  // ══════════════════════════════════════════════════════════════════════════════
  await wb.xlsx.writeFile(outputPath);
  console.log("[MATRIX] Matrice sauvegardée : " + outputPath);
  return outputPath;
}

// ── GENERER LE RAPPORT JSON SYNTHESE ────────────────────────────────────────────
function generateSynthesis(version, tickets) {
  var types = {}, stratCounts = {};
  var qaStats = { PASS: 0, FAIL: 0, "A TESTER": 0, BLOCKED: 0, other: 0 };
  var totalScore = 0, scoreCount = 0;
  var highRisk = [];

  tickets.forEach(function(t) {
    types[t.type] = (types[t.type] || 0) + 1;
    if (t.strategy) stratCounts[t.strategy] = (stratCounts[t.strategy] || 0) + 1;
    var k = t.testStatut in qaStats ? t.testStatut : "other";
    qaStats[k]++;
    if (t.score) { totalScore += t.score; scoreCount++; }
    if (t.risk && /critique|élevé|high/i.test(t.risk)) highRisk.push(t.key + " — " + t.titre);
  });

  var total = tickets.length;
  var avecTest = tickets.filter(function(t) { return t.testsLies; }).length;

  return {
    version:     version,
    generatedAt: new Date().toISOString(),
    total:       total,
    byType:      types,
    byStrategy:  stratCounts,
    qa:          qaStats,
    coverage:    total > 0 ? Math.round(avecTest / total * 100) : 0,
    avgScore:    scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0,
    highRisk:    highRisk,
    quality:     total > 0 ? Math.round(qaStats.PASS / Math.max(1, qaStats.PASS + qaStats.FAIL) * 100) : 0
  };
}

// ── FONCTION PRINCIPALE (exportable) ────────────────────────────────────────────
async function generate(version, outputFile) {
  var outFile = outputFile || "Matrice-QA-" + version + ".xlsx";
  var outPath = path.join(REPORTS_DIR, outFile);

  console.log("[MATRIX] ══════════════════════════════════════════════");
  console.log("[MATRIX] Release   : " + version);
  console.log("[MATRIX] Projet    : " + CFG.jira.project);
  console.log("[MATRIX] ══════════════════════════════════════════════");

  // 1. Récupérer tickets Jira
  var issues = await fetchReleaseTickets(version);
  if (issues.length === 0) {
    console.error("[MATRIX] Aucun ticket trouvé pour " + version);
    return { error: "Aucun ticket trouvé pour " + version };
  }

  // 2. Extraire infos
  console.log("[MATRIX] Extraction des informations...");
  var tickets = issues.map(extractTicketInfo);

  // 3. Charger données enrichies AbyQA
  console.log("[MATRIX] Chargement données enrichies AbyQA...");
  var enrichedMap = loadEnrichedData();
  var enrichedCount = 0;
  Object.keys(enrichedMap).forEach(function(k) {
    if (tickets.some(function(t) { return t.key === k; })) enrichedCount++;
  });
  console.log("[MATRIX] " + enrichedCount + " tickets enrichis trouvés dans AbyQA");

  // 4. Charger release tracker
  var tracker = loadReleaseTracker(version);
  if (tracker) console.log("[MATRIX] Release tracker trouvé (" + (tracker.tickets || []).length + " résultats)");

  // 5. Fusionner les données
  tickets = mergeData(tickets, enrichedMap, tracker);

  // 6. Générer Excel
  console.log("[MATRIX] Génération Excel (exceljs)...");
  await generateExcel(version, tickets, outPath);

  // 7. Générer synthèse JSON
  var synthesis = generateSynthesis(version, tickets);
  var synthPath = path.join(REPORTS_DIR, "synthesis-" + version + ".json");
  fs.writeFileSync(synthPath, JSON.stringify(synthesis, null, 2), "utf8");
  console.log("[MATRIX] Synthèse JSON : " + synthPath);

  // 8. Bilan
  console.log("[MATRIX] ══════════════════════════════════════════════");
  console.log("[MATRIX] MATRICE GÉNÉRÉE");
  console.log("[MATRIX]   Tickets     : " + tickets.length);
  console.log("[MATRIX]   Enrichis IA : " + enrichedCount);
  console.log("[MATRIX]   PASS        : " + synthesis.qa.PASS);
  console.log("[MATRIX]   FAIL        : " + synthesis.qa.FAIL);
  console.log("[MATRIX]   Couverture  : " + synthesis.coverage + "%");
  console.log("[MATRIX]   Score moyen : " + synthesis.avgScore + "/100");
  console.log("[MATRIX]   Qualité     : " + synthesis.quality + "%");
  console.log("[MATRIX]   Fichier     : " + outPath);
  console.log("[MATRIX] ══════════════════════════════════════════════");

  // Bus event
  try {
    var bus = require("./agent-bus");
    bus.publish("matrix:generated", { version: version, file: outPath, tickets: tickets.length, quality: synthesis.quality, coverage: synthesis.coverage });
  } catch(e) { console.error("  [WARN] Bus:", e.message); }

  return { ok: true, file: outPath, synthesis: synthesis };
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────────
module.exports = {
  generate:           generate,
  fetchReleaseTickets: fetchReleaseTickets,
  extractTicketInfo:   extractTicketInfo,
  loadEnrichedData:    loadEnrichedData,
  generateSynthesis:   generateSynthesis
};

// ── CLI ─────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  var args    = process.argv.slice(2);
  var version = args[0];
  var outArg  = args.find(function(a) { return a.startsWith("--output="); });
  var outFile = outArg ? outArg.split("=")[1] : null;

  if (!version) {
    console.log("Usage : node agent-matrix.js v1.25.0 [--output=matrice.xlsx]");
    process.exit(1);
  }

  generate(version, outFile)
    .then(function(r) { if (r.error) process.exit(1); })
    .catch(function(e) { console.error("[MATRIX] ERREUR FATALE : " + e.message); process.exit(1); });
}
