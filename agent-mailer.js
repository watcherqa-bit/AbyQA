// agent-mailer.js — Module email AbyQA
// Envoi d'alertes, rapports de release, notifications
// Usage : const mailer = require("./agent-mailer");

"use strict";

var nodemailer = require("nodemailer");
var fs         = require("fs");
var path       = require("path");
var CFG        = require("./config");

// ── TRANSPORTEUR SMTP ────────────────────────────────────────────────────────
var _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!CFG.email.enabled()) {
    console.log("[MAIL] SMTP non configuré (SMTP_HOST manquant)");
    return null;
  }
  _transporter = nodemailer.createTransport({
    host:   CFG.email.host,
    port:   CFG.email.port,
    secure: CFG.email.secure,
    auth: {
      user: CFG.email.user,
      pass: CFG.email.pass
    }
  });
  console.log("[MAIL] Transporteur SMTP configuré → " + CFG.email.host + ":" + CFG.email.port);
  return _transporter;
}

// ── ENVOI GÉNÉRIQUE ──────────────────────────────────────────────────────────
/**
 * @param {object} opts - { to, subject, html, text, attachments }
 * @returns {Promise<object>} info envoi ou null
 */
async function sendMail(opts) {
  var transport = getTransporter();
  if (!transport) {
    console.log("[MAIL] Envoi impossible — SMTP non configuré");
    return null;
  }
  try {
    var mailOpts = {
      from:        CFG.email.from,
      to:          opts.to,
      subject:     opts.subject || "[AbyQA] Notification",
      html:        opts.html || undefined,
      text:        opts.text || undefined,
      attachments: opts.attachments || []
    };
    var info = await transport.sendMail(mailOpts);
    console.log("[MAIL] Envoyé → " + opts.to + " | " + opts.subject + " | " + info.messageId);
    return info;
  } catch(e) {
    console.error("[MAIL] Erreur envoi:", e.message);
    return null;
  }
}

// ── ALERTE DIAGNOSTIC CRITIQUE ───────────────────────────────────────────────
/**
 * Envoie une alerte mail quand un diagnostic IA est CRITICAL ou MAJOR FAIL.
 * @param {string} to - destinataire(s) (virgule séparés)
 * @param {object} diag - diagnostic IA { key, tool, verdict, severity, diagnostic, action }
 */
async function sendAlert(to, diag) {
  if (!to) return null;
  var sevColors = { CRITICAL: "#ef4444", MAJOR: "#f59e0b", MINOR: "#6b7280", INFO: "#10b981" };
  var sevColor = sevColors[diag.severity] || "#6b7280";
  var verdictIcon = diag.verdict === "PASS" ? "&#x2705;" : diag.verdict === "FALSE_POSITIVE" ? "&#x26A0;&#xFE0F;" : "&#x274C;";

  var html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f8f9fa;padding:20px">' +
    '<div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">' +
    '<div style="background:#1a1a2e;color:white;padding:20px 24px">' +
    '<h2 style="margin:0;font-size:18px">' + verdictIcon + ' AbyQA — Alerte Test</h2>' +
    '<p style="margin:4px 0 0;opacity:.7;font-size:13px">' + new Date().toLocaleString("fr-FR") + '</p>' +
    '</div>' +
    '<div style="padding:24px">' +
    '<div style="display:inline-block;background:' + sevColor + ';color:white;padding:4px 12px;border-radius:6px;font-weight:bold;font-size:13px;margin-bottom:16px">' + (diag.severity || "?") + '</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
    '<tr><td style="padding:8px 0;color:#6b7280;width:120px">Ticket</td><td style="padding:8px 0;font-weight:600">' + (diag.key || "—") + '</td></tr>' +
    '<tr><td style="padding:8px 0;color:#6b7280">Outil</td><td style="padding:8px 0">' + (diag.tool || "—").toUpperCase() + '</td></tr>' +
    '<tr><td style="padding:8px 0;color:#6b7280">Verdict</td><td style="padding:8px 0;font-weight:600;color:' + sevColor + '">' + (diag.verdict || "—") + '</td></tr>' +
    '<tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Diagnostic</td><td style="padding:8px 0">' + (diag.diagnostic || "—") + '</td></tr>' +
    '<tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">Action</td><td style="padding:8px 0;font-style:italic">' + (diag.action || "—") + '</td></tr>' +
    '</table>' +
    '</div>' +
    '<div style="background:#f1f5f9;padding:12px 24px;font-size:11px;color:#94a3b8;text-align:center">' +
    'AbyQA — Plateforme QA automatisée Safran Group' +
    '</div></div></body></html>';

  return sendMail({
    to: to,
    subject: "[AbyQA] " + (diag.severity || "ALERTE") + " — " + (diag.key || "Test") + " " + (diag.verdict || ""),
    html: html
  });
}

// ── RAPPORT RELEASE PAR MAIL ─────────────────────────────────────────────────
/**
 * Envoie un rapport de release par mail aux contributeurs.
 * @param {object} opts - { to, version, synthesis, reportPath, pdfPath, template }
 */
async function sendReleaseReport(opts) {
  if (!opts.to) return null;
  var version = opts.version || "?";
  var synth = opts.synthesis || {};
  var template = opts.template || null;

  // Stats
  var totalTickets = synth.totalTickets || 0;
  var passCount = synth.passCount || 0;
  var failCount = synth.failCount || 0;
  var coverage = totalTickets > 0 ? Math.round(passCount / totalTickets * 100) : 0;
  var scoreIA = synth.avgScore || "—";

  var html;
  if (template) {
    // Template personnalisée — remplacer les variables
    html = template
      .replace(/\{\{version\}\}/g, version)
      .replace(/\{\{date\}\}/g, new Date().toLocaleDateString("fr-FR"))
      .replace(/\{\{totalTickets\}\}/g, String(totalTickets))
      .replace(/\{\{passCount\}\}/g, String(passCount))
      .replace(/\{\{failCount\}\}/g, String(failCount))
      .replace(/\{\{coverage\}\}/g, String(coverage))
      .replace(/\{\{scoreIA\}\}/g, String(scoreIA))
      .replace(/\{\{bugs\}\}/g, String(synth.bugCount || 0))
      .replace(/\{\{riskTickets\}\}/g, (synth.highRiskTickets || []).join(", ") || "aucun")
      .replace(/\{\{strategies\}\}/g, JSON.stringify(synth.strategies || {}));
  } else {
    // Template par défaut
    var statusColor = coverage >= 80 ? "#10b981" : coverage >= 50 ? "#f59e0b" : "#ef4444";
    html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f8f9fa;padding:20px">' +
      '<div style="max-width:650px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">' +
      // Header
      '<div style="background:linear-gradient(135deg,#1a237e,#283593);color:white;padding:24px">' +
      '<h1 style="margin:0;font-size:22px">Rapport QA — Release ' + version + '</h1>' +
      '<p style="margin:6px 0 0;opacity:.8;font-size:13px">' + new Date().toLocaleDateString("fr-FR") + ' — Généré par AbyQA</p>' +
      '</div>' +
      // Stats cards
      '<div style="padding:24px;display:flex;gap:12px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:100px;background:#f1f5f9;border-radius:8px;padding:16px;text-align:center">' +
      '<div style="font-size:24px;font-weight:700;color:#1a1a2e">' + totalTickets + '</div><div style="font-size:11px;color:#6b7280">Tickets</div></div>' +
      '<div style="flex:1;min-width:100px;background:rgba(16,185,129,.08);border-radius:8px;padding:16px;text-align:center">' +
      '<div style="font-size:24px;font-weight:700;color:#10b981">' + passCount + '</div><div style="font-size:11px;color:#6b7280">PASS</div></div>' +
      '<div style="flex:1;min-width:100px;background:rgba(239,68,68,.08);border-radius:8px;padding:16px;text-align:center">' +
      '<div style="font-size:24px;font-weight:700;color:#ef4444">' + failCount + '</div><div style="font-size:11px;color:#6b7280">FAIL</div></div>' +
      '<div style="flex:1;min-width:100px;background:rgba(59,130,246,.08);border-radius:8px;padding:16px;text-align:center">' +
      '<div style="font-size:24px;font-weight:700;color:' + statusColor + '">' + coverage + '%</div><div style="font-size:11px;color:#6b7280">Couverture</div></div>' +
      '</div>' +
      // Score IA
      '<div style="padding:0 24px 16px"><div style="background:#f8fafc;border-radius:8px;padding:12px 16px;font-size:13px">' +
      '<strong>Score IA moyen :</strong> ' + scoreIA + '/100 | ' +
      '<strong>Bugs détectés :</strong> ' + (synth.bugCount || 0) +
      '</div></div>';

    // High risk tickets
    if (synth.highRiskTickets && synth.highRiskTickets.length > 0) {
      html += '<div style="padding:0 24px 16px"><div style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.15);border-radius:8px;padding:12px 16px">' +
        '<div style="font-size:12px;font-weight:600;color:#ef4444;margin-bottom:6px">Tickets à risque élevé</div>' +
        '<div style="font-size:13px;color:#374151">' + synth.highRiskTickets.join(", ") + '</div>' +
        '</div></div>';
    }

    // Strategies breakdown
    if (synth.strategies) {
      var stratHtml = Object.keys(synth.strategies).map(function(k) {
        return '<span style="display:inline-block;background:#e5e7eb;border-radius:4px;padding:2px 8px;margin:2px;font-size:12px">' + k + ': ' + synth.strategies[k] + '</span>';
      }).join(" ");
      html += '<div style="padding:0 24px 20px"><div style="font-size:12px;color:#6b7280;margin-bottom:4px">Stratégies de test</div>' + stratHtml + '</div>';
    }

    html += '<div style="background:#f1f5f9;padding:16px 24px;font-size:11px;color:#94a3b8;text-align:center">' +
      'AbyQA — Plateforme QA automatisée Safran Group<br>Ce rapport a été généré automatiquement.' +
      '</div></div></body></html>';
  }

  // Pièces jointes
  var attachments = [];
  if (opts.pdfPath && fs.existsSync(opts.pdfPath)) {
    attachments.push({ filename: path.basename(opts.pdfPath), path: opts.pdfPath });
  }
  if (opts.reportPath && fs.existsSync(opts.reportPath) && !opts.pdfPath) {
    attachments.push({ filename: path.basename(opts.reportPath), path: opts.reportPath });
  }

  return sendMail({
    to: opts.to,
    subject: "[AbyQA] Rapport QA — Release " + version + " — " + coverage + "% couverture",
    html: html,
    attachments: attachments
  });
}

// ── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = {
  sendMail: sendMail,
  sendAlert: sendAlert,
  sendReleaseReport: sendReleaseReport,
  getTransporter: getTransporter
};
