// agent-matrix.js - Matrice de traçabilité QA par release
// Interroge l'API Jira, recupere tous les tickets de la release
// et genere un fichier Excel avec la traçabilite complete
//
// Usage :
//   node agent-matrix.js v1.25.0
//   node agent-matrix.js v1.25.0 --output=matrice-v1.25.0.xlsx

"use strict";


const fs    = require("fs");
const path  = require("path");
const https = require("https");
const { execSync } = require("child_process");

// ── CONFIG (lue depuis .env via config.js) ────────────────────────────────────
const CFG    = require("./config");
CFG.paths.init();
const CONFIG = CFG;

const REPORTS_DIR = CFG.paths.reports;
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ── JIRA API ──────────────────────────────────────────────────────────────────
function jiraGet(apiPath) {
  return new Promise(function(resolve, reject) {
    var auth    = Buffer.from(CONFIG.jira.email + ":" + CONFIG.jira.token).toString("base64");
    var options = {
      hostname: CONFIG.jira.host,
      path:     apiPath,
      method:   "GET",
      headers:  { "Authorization": "Basic " + auth, "Accept": "application/json" }
    };
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error : " + data.substring(0, 100))); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── RECUPERER TICKETS DE LA RELEASE ──────────────────────────────────────────
async function fetchReleaseTickets(version) {
  console.log("[JIRA] Recuperation des tickets " + version + "...");

  var allIssues = [];
  var startAt   = 0;
  var maxResults = 50;
  var total     = 999;

  while (startAt < total) {
    var jql = encodeURIComponent(
      'project = ' + CONFIG.jira.project +
      ' AND labels = "' + version + '"' +
      ' ORDER BY issuetype ASC, status ASC'
    );
    var url = "/rest/api/2/search?jql=" + jql +
      "&startAt=" + startAt +
      "&maxResults=" + maxResults +
      "&fields=summary,issuetype,status,priority,assignee,labels,issuelinks,comment,customfield_10077";

    var result = await jiraGet(url);
    total      = result.total || 0;
    var issues = result.issues || [];
    allIssues  = allIssues.concat(issues);
    startAt   += issues.length;

    process.stdout.write("  " + allIssues.length + "/" + total + " tickets recuperes...\r");
    if (issues.length === 0) break;
    await new Promise(function(r) { setTimeout(r, 200); });
  }

  console.log("\n  Total : " + allIssues.length + " tickets");
  return allIssues;
}

// ── EXTRAIRE LES INFOS D'UN TICKET ───────────────────────────────────────────
function extractTicketInfo(issue) {
  var fields  = issue.fields || {};
  var links   = fields.issuelinks || [];

  // Tickets Test lies
  var testLinks = links.filter(function(l) {
    var linked = l.inwardIssue || l.outwardIssue;
    return linked && linked.fields && linked.fields.issuetype &&
           linked.fields.issuetype.name === "Test";
  }).map(function(l) {
    var linked = l.inwardIssue || l.outwardIssue;
    return linked.key;
  });

  // Bugs lies
  var bugLinks = links.filter(function(l) {
    var linked = l.inwardIssue || l.outwardIssue;
    return linked && linked.fields && linked.fields.issuetype &&
           linked.fields.issuetype.name === "Bug";
  }).map(function(l) {
    var linked = l.inwardIssue || l.outwardIssue;
    return linked.key;
  });

  // Extraire les cas de test depuis le champ Tests (customfield_10077)
  var testsField = fields.customfield_10077 || "";
  var tcList     = [];
  if (testsField) {
    var tcMatches = testsField.match(/TC\d+[^:)}\n]*/g) || [];
    tcMatches.forEach(function(tc) {
      var clean = tc.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().substring(0,80);
      if (clean.length > 3) tcList.push(clean);
    });
  }

  // Extraire statut global des tests (PASS/FAIL/KO depuis les commentaires)
  var comments     = (fields.comment && fields.comment.comments) || [];
  var lastComment  = comments.length > 0 ? comments[comments.length-1].body : "";
  var testStatut   = "";
  if (lastComment.toLowerCase().includes("ok sur sophie") || lastComment.toLowerCase().includes("ok\n")) {
    testStatut = "PASS";
  } else if (lastComment.toLowerCase().includes("ko") || lastComment.toLowerCase().includes("fail")) {
    testStatut = "FAIL";
  } else if (fields.status && fields.status.name === "To Test UAT") {
    testStatut = "A TESTER";
  } else if (fields.status && (fields.status.name === "Done" || fields.status.name === "Closed")) {
    testStatut = "PASS";
  }

  return {
    key:       issue.key,
    titre:     fields.summary || "",
    type:      fields.issuetype ? fields.issuetype.name : "",
    statut:    fields.status ? fields.status.name : "",
    priorite:  fields.priority ? fields.priority.name : "",
    assignee:  fields.assignee ? fields.assignee.displayName : "Non assigne",
    labels:    (fields.labels || []).join(", "),
    testsLies: testLinks.join(", "),
    bugs:      bugLinks.join(", "),
    tcList:    tcList,
    testStatut: testStatut,
    nbComments: comments.length
  };
}

// ── GENERER LE FICHIER PYTHON POUR OPENPYXL ──────────────────────────────────
function generatePythonScript(version, tickets, outputPath) {
  // Serialiser les données pour le script Python
  var ticketsJson = JSON.stringify(tickets, null, 2).replace(/'/g, "\\'");

  var py = `import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, GradientFill
from openpyxl.utils import get_column_letter

version  = "${version}"
out_path = r"${outputPath.replace(/\\/g, "\\\\")}"

tickets_raw = json.loads(r'''${JSON.stringify(tickets)}''')

wb = Workbook()

# ── COULEURS ───────────────────────────────────────────────────────────────────
BLUE_DARK  = "003580"   # Safran bleu
BLUE_LIGHT = "E8F0FB"
GREEN      = "D4EDDA"
RED        = "F8D7DA"
ORANGE     = "FFF3CD"
GREY_LIGHT = "F5F5F5"
GREY_HEADER= "DEE2E6"
WHITE      = "FFFFFF"

def header_style(cell, bg=BLUE_DARK):
    cell.font      = Font(bold=True, color="FFFFFF", name="Arial", size=9)
    cell.fill      = PatternFill("solid", start_color=bg)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

def subheader_style(cell):
    cell.font      = Font(bold=True, color="003580", name="Arial", size=9)
    cell.fill      = PatternFill("solid", start_color=GREY_HEADER)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

def cell_style(cell, bg=WHITE, bold=False, color="000000", wrap=True):
    cell.font      = Font(bold=bold, color=color, name="Arial", size=9)
    cell.fill      = PatternFill("solid", start_color=bg)
    cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=wrap)

def status_color(statut):
    s = (statut or "").upper()
    if "PASS" in s or s == "DONE" or s == "CLOSED":  return GREEN
    if "FAIL" in s or "KO" in s:                      return RED
    if "TESTER" in s or "UAT" in s or "TEST" in s:    return ORANGE
    return GREY_LIGHT

thin = Side(style="thin", color="CCCCCC")
def add_border(cell):
    cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)

# ── FEUILLE 1 : MATRICE TRACABILITE ───────────────────────────────────────────
ws1 = wb.active
ws1.title = "Matrice " + version

# Titre
ws1.merge_cells("A1:J1")
ws1["A1"] = "MATRICE DE TRAÇABILITE QA - Release " + version + " - Projet SAFWBST"
ws1["A1"].font      = Font(bold=True, color="FFFFFF", name="Arial", size=12)
ws1["A1"].fill      = PatternFill("solid", start_color=BLUE_DARK)
ws1["A1"].alignment = Alignment(horizontal="center", vertical="center")
ws1.row_dimensions[1].height = 30

# Sous-titre
ws1.merge_cells("A2:J2")
ws1["A2"] = "Genere automatiquement par Aby QA V2 - " + __import__("datetime").datetime.now().strftime("%d/%m/%Y %H:%M")
ws1["A2"].font      = Font(italic=True, color="666666", name="Arial", size=8)
ws1["A2"].alignment = Alignment(horizontal="center")

# En-tetes colonnes
headers = [
    ("Ticket", 14),
    ("Titre", 45),
    ("Type", 14),
    ("Assignee", 20),
    ("Statut Jira", 16),
    ("Ticket Test", 14),
    ("Cas de test", 35),
    ("Statut QA", 12),
    ("Bugs lies", 14),
    ("Preuves", 30),
]
ws1.row_dimensions[3].height = 25
for col, (h, w) in enumerate(headers, 1):
    cell = ws1.cell(row=3, column=col, value=h)
    header_style(cell)
    add_border(cell)
    ws1.column_dimensions[get_column_letter(col)].width = w

# Données
row = 4
for t in tickets_raw:
    # Couleur de fond selon type
    if t["type"] in ("Story", "User Story"):  row_bg = "EBF5FB"
    elif t["type"] == "Bug":                  row_bg = "FDFEFE"
    else:                                      row_bg = WHITE

    # Statut QA couleur
    qa_bg = status_color(t["testStatut"])

    # TC list formatte
    tc_text = "\\n".join(t["tcList"][:5]) if t["tcList"] else "-"
    if len(t["tcList"]) > 5: tc_text += "\\n... +" + str(len(t["tcList"]) - 5) + " autres"

    values = [
        t["key"],
        t["titre"],
        t["type"],
        t["assignee"],
        t["statut"],
        t["testsLies"] or "-",
        tc_text,
        t["testStatut"] or "-",
        t["bugs"] or "-",
        ""   # Preuves - a renseigner manuellement ou par agent
    ]

    for col, val in enumerate(values, 1):
        cell = ws1.cell(row=row, column=col, value=val)
        bg = qa_bg if col == 8 else row_bg
        cell_style(cell, bg=bg, color="BF2600" if t["type"] == "Bug" else "000000")
        add_border(cell)
        if col in (1, 6, 8, 9): cell.alignment = Alignment(horizontal="center", vertical="center")

    # Hauteur de ligne selon nb de TC
    nb_tc = max(1, min(len(t["tcList"]), 5))
    ws1.row_dimensions[row].height = max(18, nb_tc * 15)
    row += 1

# Freeze header
ws1.freeze_panes = "A4"

# Filtre auto
ws1.auto_filter.ref = "A3:J" + str(row - 1)

# ── FEUILLE 2 : STATS ─────────────────────────────────────────────────────────
ws2 = wb.create_sheet("Stats " + version)

ws2.merge_cells("A1:D1")
ws2["A1"] = "STATISTIQUES - Release " + version
ws2["A1"].font      = Font(bold=True, color="FFFFFF", name="Arial", size=11)
ws2["A1"].fill      = PatternFill("solid", start_color=BLUE_DARK)
ws2["A1"].alignment = Alignment(horizontal="center", vertical="center")
ws2.row_dimensions[1].height = 28

# Compteurs par type
types = {}
statuts_qa = {"PASS": 0, "FAIL": 0, "A TESTER": 0, "": 0}
for t in tickets_raw:
    types[t["type"]] = types.get(t["type"], 0) + 1
    k = t["testStatut"] if t["testStatut"] in statuts_qa else ""
    statuts_qa[k] += 1

total = len(tickets_raw)
avec_test  = sum(1 for t in tickets_raw if t["testsLies"])
avec_bug   = sum(1 for t in tickets_raw if t["bugs"])

stats = [
    ("REPARTITION PAR TYPE", None),
]
for typ, count in sorted(types.items(), key=lambda x: -x[1]):
    stats.append(("  " + (typ or "Inconnu"), count))

stats.append(("", None))
stats.append(("STATUTS QA", None))
stats.append(("  PASS", statuts_qa["PASS"]))
stats.append(("  FAIL", statuts_qa["FAIL"]))
stats.append(("  A TESTER", statuts_qa["A TESTER"]))
stats.append(("  Non renseigne", statuts_qa[""]))

stats.append(("", None))
stats.append(("TRACABILITE", None))
stats.append(("  Total tickets", total))
stats.append(("  Avec ticket Test", avec_test))
stats.append(("  Avec bug lie", avec_bug))
stats.append(("  Taux couverture test", "=ROUND(B" + str(len(stats) + 1) + "/B" + str(len(stats)) + "*100,1)&\"%\""))

for i, (label, val) in enumerate(stats, 2):
    ws2.row_dimensions[i].height = 18
    c1 = ws2.cell(row=i, column=1, value=label)
    c2 = ws2.cell(row=i, column=2, value=val)

    if val is None:
        c1.font = Font(bold=True, color="FFFFFF", name="Arial", size=9)
        c1.fill = PatternFill("solid", start_color="003580")
        ws2.merge_cells(f"A{i}:D{i}")
    else:
        c1.font = Font(name="Arial", size=9)
        c2.font = Font(bold=True, name="Arial", size=9)
        if "PASS" in label:   c2.fill = PatternFill("solid", start_color="D4EDDA")
        elif "FAIL" in label: c2.fill = PatternFill("solid", start_color="F8D7DA")
        else:                 c2.fill = PatternFill("solid", start_color="F5F5F5")

    add_border(c1)
    if val is not None: add_border(c2)

ws2.column_dimensions["A"].width = 30
ws2.column_dimensions["B"].width = 15

# ── FEUILLE 3 : DETAIL TC ─────────────────────────────────────────────────────
ws3 = wb.create_sheet("Detail TC")

ws3.merge_cells("A1:F1")
ws3["A1"] = "DETAIL DES CAS DE TEST - Release " + version
ws3["A1"].font      = Font(bold=True, color="FFFFFF", name="Arial", size=11)
ws3["A1"].fill      = PatternFill("solid", start_color=BLUE_DARK)
ws3["A1"].alignment = Alignment(horizontal="center", vertical="center")
ws3.row_dimensions[1].height = 28

tc_headers = [("Ticket", 14), ("Titre", 40), ("Type", 14), ("Cas de test", 60), ("Statut QA", 14), ("Bugs", 14)]
for col, (h, w) in enumerate(tc_headers, 1):
    cell = ws3.cell(row=2, column=col, value=h)
    header_style(cell)
    add_border(cell)
    ws3.column_dimensions[get_column_letter(col)].width = w

tc_row = 3
for t in tickets_raw:
    if not t["tcList"]:
        continue
    for tc in t["tcList"]:
        vals = [t["key"], t["titre"], t["type"], tc, t["testStatut"] or "-", t["bugs"] or "-"]
        for col, val in enumerate(vals, 1):
            cell = ws3.cell(row=tc_row, column=col, value=val)
            cell_style(cell, bg=status_color(t["testStatut"]) if col == 5 else WHITE)
            add_border(cell)
            if col in (1, 3, 5, 6): cell.alignment = Alignment(horizontal="center", vertical="center")
        ws3.row_dimensions[tc_row].height = 18
        tc_row += 1

ws3.freeze_panes = "A3"
ws3.auto_filter.ref = "A2:F" + str(tc_row - 1)

wb.save(out_path)
print("OK - Matrice generee : " + out_path)
`;

  return py;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  var args    = process.argv.slice(2);
  var version = args[0];
  var outArg  = args.find(function(a) { return a.startsWith("--output="); });
  var outFile = outArg ? outArg.split("=")[1] : "Matrice-QA-" + (version || "release") + ".xlsx";
  var outPath = path.join(REPORTS_DIR, outFile);

  if (!version) {
    console.log("Usage : node agent-matrix.js v1.25.0 [--output=matrice.xlsx]");
    process.exit(1);
  }

  if (CONFIG.jira.token === "TON_TOKEN_API_ICI") {
    console.error("[ERR] Configure ton token dans CONFIG.jira.token (ligne 17)");
    process.exit(1);
  }

  console.log("==================================================");
  console.log("  AGENT MATRIX - ABY QA V2");
  console.log("  Release : " + version);
  console.log("  Projet  : " + CONFIG.jira.project);
  console.log("==================================================\n");

  // 1. Recuperer les tickets
  var issues  = await fetchReleaseTickets(version);
  if (issues.length === 0) {
    console.error("[ERR] Aucun ticket trouve pour la release " + version);
    console.error("      Verifie que le label '" + version + "' existe dans Jira.");
    process.exit(1);
  }

  // 2. Extraire les infos
  console.log("\n[INFO] Extraction des informations...");
  var tickets = issues.map(extractTicketInfo);

  var types = {};
  tickets.forEach(function(t) { types[t.type] = (types[t.type] || 0) + 1; });
  Object.keys(types).forEach(function(k) { console.log("  " + k + " : " + types[k]); });

  // 3. Generer le script Python
  console.log("\n[EXCEL] Generation de la matrice Excel...");
  var pyScript = generatePythonScript(version, tickets, outPath);
  var pyFile   = path.join(__dirname, "tmp_matrix.py");
  fs.writeFileSync(pyFile, pyScript, "utf8");

  // 4. Executer le script Python
  try {
    execSync("python3 " + pyFile + " 2>&1", { stdio: "inherit" });
    fs.unlinkSync(pyFile);
  } catch (e) {
    try {
      execSync("python " + pyFile + " 2>&1", { stdio: "inherit" });
      fs.unlinkSync(pyFile);
    } catch (e2) {
      console.error("[ERR] Python non disponible. Installe python3 et openpyxl.");
      process.exit(1);
    }
  }

  // 5. Bilan
  var avecTest = tickets.filter(function(t) { return t.testsLies; }).length;
  var pass     = tickets.filter(function(t) { return t.testStatut === "PASS"; }).length;
  var fail     = tickets.filter(function(t) { return t.testStatut === "FAIL"; }).length;
  var aTesters = tickets.filter(function(t) { return t.testStatut === "A TESTER"; }).length;

  console.log("\n==================================================");
  console.log("  MATRICE GENEREE");
  console.log("==================================================");
  console.log("  Release    : " + version);
  console.log("  Tickets    : " + tickets.length);
  console.log("  Avec test  : " + avecTest);
  console.log("  PASS       : " + pass);
  console.log("  FAIL       : " + fail);
  console.log("  A tester   : " + aTesters);
  console.log("  Fichier    : " + outPath);
  console.log("==================================================\n");
}

main().catch(function(e) { console.error("[ERR FATAL]", e.message); process.exit(1); });
