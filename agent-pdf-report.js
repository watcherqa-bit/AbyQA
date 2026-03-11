// agent-pdf-report.js — Génération de rapport PDF de release via Playwright
// Usage : require("./agent-pdf-report").generate(releaseData) → { pdfPath, htmlPath }

"use strict";

// Fix Playwright path for Render
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

var fs   = require("fs");
var path = require("path");

var BASE_DIR = __dirname;

/**
 * Génère un rapport HTML de release.
 * @param {object} data - { version, tickets[], stats, diagnostics[], date }
 * @returns {string} HTML complet
 */
function buildHTML(data) {
  var version = data.version || "?";
  var date    = data.date || new Date().toLocaleDateString("fr-FR");
  var stats   = data.stats || {};
  var tickets = data.tickets || [];
  var diags   = data.diagnostics || [];

  var total    = stats.total || tickets.length;
  var passC    = stats.pass || 0;
  var failC    = stats.fail || 0;
  var bugC     = stats.bugs || 0;
  var coverage = total > 0 ? Math.round(passC / total * 100) : 0;
  var covColor = coverage >= 80 ? "#10b981" : coverage >= 50 ? "#f59e0b" : "#ef4444";

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>AbyQA — Rapport Release ' + esc(version) + '</title>' +
    '<style>' +
    'body{font-family:Arial,sans-serif;background:#f8f9fa;margin:0;padding:20px;color:#1a1a2e}' +
    '.container{max-width:800px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}' +
    '.header{background:linear-gradient(135deg,#1a237e,#283593);color:white;padding:30px 32px}' +
    '.header h1{margin:0;font-size:22px}' +
    '.header p{margin:6px 0 0;opacity:.7;font-size:13px}' +
    '.stats{display:flex;gap:12px;padding:24px 32px;flex-wrap:wrap}' +
    '.stat-card{flex:1;min-width:90px;background:#f1f5f9;border-radius:10px;padding:16px;text-align:center}' +
    '.stat-num{font-size:28px;font-weight:800}' +
    '.stat-label{font-size:10px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.05em}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}' +
    'th{text-align:left;padding:10px 12px;background:#f8fafc;color:#6b7280;font-weight:500;border-bottom:1px solid #e5e7eb}' +
    'td{padding:8px 12px;border-bottom:1px solid #f1f5f9}' +
    '.pass{color:#10b981;font-weight:600}' +
    '.fail{color:#ef4444;font-weight:600}' +
    '.section{padding:20px 32px}' +
    '.section-title{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #e5e7eb}' +
    '.footer{background:#f1f5f9;padding:16px 32px;font-size:10px;color:#94a3b8;text-align:center}' +
    '.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600}' +
    '</style></head><body>' +
    '<div class="container">' +
    '<div class="header"><h1>Rapport QA — Release ' + esc(version) + '</h1>' +
    '<p>' + esc(date) + ' — Généré par AbyQA</p></div>';

  // Stats
  html += '<div class="stats">' +
    '<div class="stat-card"><div class="stat-num" style="color:#1a1a2e">' + total + '</div><div class="stat-label">Tickets</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:#10b981">' + passC + '</div><div class="stat-label">PASS</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:#ef4444">' + failC + '</div><div class="stat-label">FAIL</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:#f59e0b">' + bugC + '</div><div class="stat-label">Bugs</div></div>' +
    '<div class="stat-card"><div class="stat-num" style="color:' + covColor + '">' + coverage + '%</div><div class="stat-label">Couverture</div></div>' +
    '</div>';

  // Tickets table
  if (tickets.length > 0) {
    html += '<div class="section"><div class="section-title">Détail des tickets (' + tickets.length + ')</div>' +
      '<table><tr><th>Ticket</th><th>Type</th><th>Résumé</th><th>Statut</th><th>Tests</th></tr>';
    tickets.forEach(function(t) {
      var statusClass = t.qaStatus === "PASS" ? "pass" : t.qaStatus === "FAIL" ? "fail" : "";
      html += '<tr><td style="font-family:monospace;font-weight:600;color:#3b6fff">' + esc(t.key || "?") + '</td>' +
        '<td>' + esc(t.type || "?") + '</td>' +
        '<td>' + esc((t.summary || "").substring(0, 60)) + '</td>' +
        '<td class="' + statusClass + '">' + esc(t.status || "?") + '</td>' +
        '<td>' + (t.testPass || 0) + '/' + (t.testTotal || 0) + '</td></tr>';
    });
    html += '</table></div>';
  }

  // Diagnostics summary
  if (diags.length > 0) {
    var critCount = diags.filter(function(d){return d.severity==="CRITICAL"}).length;
    var majCount  = diags.filter(function(d){return d.severity==="MAJOR"}).length;
    html += '<div class="section"><div class="section-title">Diagnostics IA (' + diags.length + ')</div>';
    if (critCount > 0 || majCount > 0) {
      html += '<div style="margin-bottom:12px">';
      if (critCount > 0) html += '<span class="badge" style="background:rgba(239,68,68,.1);color:#ef4444;margin-right:6px">' + critCount + ' CRITICAL</span>';
      if (majCount > 0) html += '<span class="badge" style="background:rgba(245,158,11,.1);color:#f59e0b">' + majCount + ' MAJOR</span>';
      html += '</div>';
    }
    html += '<table><tr><th>Ticket</th><th>Outil</th><th>Verdict</th><th>Sévérité</th><th>Diagnostic</th></tr>';
    diags.slice(0, 30).forEach(function(d) {
      html += '<tr><td style="font-family:monospace;color:#3b6fff">' + esc(d.key || "?") + '</td>' +
        '<td>' + esc(d._tool || "?") + '</td>' +
        '<td class="' + (d.verdict === "PASS" ? "pass" : d.verdict === "FAIL" ? "fail" : "") + '">' + esc(d.verdict || "?") + '</td>' +
        '<td>' + esc(d.severity || "—") + '</td>' +
        '<td>' + esc((d.diagnostic || "").substring(0, 80)) + '</td></tr>';
    });
    html += '</table></div>';
  }

  html += '<div class="footer">AbyQA — Plateforme QA automatisée Safran Group<br>Ce rapport a été généré automatiquement le ' + esc(date) + '</div>';
  html += '</div></body></html>';

  return html;
}

function esc(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

/**
 * Génère un PDF à partir des données de release.
 * @param {object} data - { version, tickets[], stats, diagnostics[], date }
 * @returns {Promise<{ pdfPath:string, htmlPath:string }>}
 */
async function generate(data) {
  var version = data.version || "release";
  var safeName = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  var reportsDir = path.join(BASE_DIR, "reports");
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  var htmlPath = path.join(reportsDir, "release-" + safeName + ".html");
  var pdfPath  = path.join(reportsDir, "release-" + safeName + ".pdf");

  // Build HTML
  var htmlContent = buildHTML(data);
  fs.writeFileSync(htmlPath, htmlContent, "utf8");
  console.log("[PDF] HTML généré → " + htmlPath);

  // Convert to PDF via Playwright
  try {
    var pw = require("playwright");
    var browser = await pw.chromium.launch({ headless: true });
    var page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: "networkidle" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      printBackground: true
    });
    await browser.close();
    console.log("[PDF] PDF généré → " + pdfPath);
  } catch(e) {
    console.error("[PDF] Erreur génération PDF (Playwright):", e.message);
    // Fallback: juste le HTML
    pdfPath = null;
  }

  return { pdfPath: pdfPath, htmlPath: htmlPath };
}

module.exports = { generate: generate, buildHTML: buildHTML };
