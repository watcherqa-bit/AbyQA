// agent-purge.js — Purge automatique des fichiers anciens
// Nettoie inbox/logs, inbox/tests (done), inbox/inspector-cache, reports/, screenshots/, errors/
// Usage : require("./agent-purge").run(settings) ou node agent-purge.js

"use strict";

var fs   = require("fs");
var path = require("path");

var BASE_DIR = __dirname;

// Dossiers à purger avec leur rétention par défaut (jours)
var PURGE_TARGETS = [
  { dir: "inbox/inspector-cache", defaultDays: 7,  label: "Cache inspecteur" },
  { dir: "inbox/polling",         defaultDays: 30, label: "Polling Jira (.seen exclu)" },
  { dir: "inbox/tests",           defaultDays: 30, label: "File tests (done)",    filter: filterDoneTests },
  { dir: "inbox/logs",            defaultDays: 30, label: "Logs Playwright" },
  { dir: "reports",               defaultDays: 60, label: "Rapports HTML" },
  { dir: "screenshots",           defaultDays: 30, label: "Screenshots" },
  { dir: "errors",                defaultDays: 30, label: "Logs erreurs" }
];

// Ne purger que les tests "done" ou très vieux
function filterDoneTests(filePath, content) {
  if (!filePath.endsWith(".json")) return false;
  try {
    var data = JSON.parse(content);
    return data.status === "done" || data.status === "completed";
  } catch(e) { return false; }
}

/**
 * Purge les fichiers plus vieux que retentionDays dans un dossier.
 * @param {string} dirPath - chemin absolu du dossier
 * @param {number} retentionDays - nombre de jours à conserver
 * @param {function} [filterFn] - filtre optionnel (filePath, content) => boolean
 * @returns {{ deleted: string[], skipped: number, errors: string[] }}
 */
function purgeDir(dirPath, retentionDays, filterFn) {
  var result = { deleted: [], skipped: 0, errors: [] };
  if (!fs.existsSync(dirPath)) return result;

  var cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  var files;
  try { files = fs.readdirSync(dirPath); } catch(e) { result.errors.push(e.message); return result; }

  files.forEach(function(f) {
    // Toujours garder les fichiers système
    if (f.startsWith(".") || f === ".seen.json") { result.skipped++; return; }

    var fp = path.join(dirPath, f);
    try {
      var stat = fs.statSync(fp);
      if (stat.isDirectory()) { result.skipped++; return; }
      if (stat.mtimeMs > cutoff) { result.skipped++; return; }

      // Filtre custom
      if (filterFn) {
        var content = "";
        try { content = fs.readFileSync(fp, "utf8"); } catch(e) {}
        if (!filterFn(fp, content)) { result.skipped++; return; }
      }

      fs.unlinkSync(fp);
      result.deleted.push(f);
    } catch(e) {
      result.errors.push(f + ": " + e.message);
    }
  });

  return result;
}

/**
 * Lance la purge complète selon les settings.
 * @param {object} [settings] - settings.json parsé (optionnel, lu depuis fichier sinon)
 * @returns {{ targets: object[], totalDeleted: number, totalSkipped: number, totalErrors: number, at: string }}
 */
function run(settings) {
  if (!settings) {
    try { settings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); } catch(e) { settings = {}; }
  }

  var purgeSettings = settings.purge || {};
  var globalRetention = purgeSettings.retentionDays || 30;

  var report = { targets: [], totalDeleted: 0, totalSkipped: 0, totalErrors: 0, at: new Date().toISOString() };

  PURGE_TARGETS.forEach(function(target) {
    var dirPath = path.join(BASE_DIR, target.dir);
    var days = purgeSettings[target.dir.replace(/\//g, "_") + "_days"] || target.defaultDays || globalRetention;
    var result = purgeDir(dirPath, days, target.filter || null);

    report.targets.push({
      dir: target.dir,
      label: target.label,
      retentionDays: days,
      deleted: result.deleted.length,
      skipped: result.skipped,
      errors: result.errors.length,
      files: result.deleted.slice(0, 20) // max 20 noms pour le rapport
    });

    report.totalDeleted += result.deleted.length;
    report.totalSkipped += result.skipped;
    report.totalErrors  += result.errors.length;
  });

  // Purge enriched — uniquement les tickets "pushed" de plus de 90 jours
  var enrichedDir = path.join(BASE_DIR, "inbox", "enriched");
  var enrichedDays = purgeSettings.enrichedDays || 90;
  if (fs.existsSync(enrichedDir)) {
    var enrichedResult = purgeDir(enrichedDir, enrichedDays, function(fp, content) {
      try {
        var data = JSON.parse(content);
        return data.pushedToJira === true;
      } catch(e) { return false; }
    });
    report.targets.push({
      dir: "inbox/enriched",
      label: "Tickets enrichis (poussés Jira, 90j+)",
      retentionDays: enrichedDays,
      deleted: enrichedResult.deleted.length,
      skipped: enrichedResult.skipped,
      errors: enrichedResult.errors.length,
      files: enrichedResult.deleted.slice(0, 20)
    });
    report.totalDeleted += enrichedResult.deleted.length;
    report.totalSkipped += enrichedResult.skipped;
    report.totalErrors  += enrichedResult.errors.length;
  }

  console.log("[PURGE] Terminé — " + report.totalDeleted + " fichiers supprimés, " + report.totalSkipped + " conservés, " + report.totalErrors + " erreurs");
  return report;
}

/**
 * Retourne un aperçu de ce qui serait purgé (dry-run).
 */
function preview(settings) {
  if (!settings) {
    try { settings = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "settings.json"), "utf8")); } catch(e) { settings = {}; }
  }

  var purgeSettings = settings.purge || {};
  var globalRetention = purgeSettings.retentionDays || 30;
  var preview = { targets: [], totalEligible: 0 };

  PURGE_TARGETS.forEach(function(target) {
    var dirPath = path.join(BASE_DIR, target.dir);
    if (!fs.existsSync(dirPath)) return;
    var days = purgeSettings[target.dir.replace(/\//g, "_") + "_days"] || target.defaultDays || globalRetention;
    var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    var count = 0;
    var totalSize = 0;
    try {
      fs.readdirSync(dirPath).forEach(function(f) {
        if (f.startsWith(".")) return;
        var fp = path.join(dirPath, f);
        try {
          var stat = fs.statSync(fp);
          if (!stat.isDirectory() && stat.mtimeMs <= cutoff) {
            count++;
            totalSize += stat.size;
          }
        } catch(e) {}
      });
    } catch(e) {}
    if (count > 0) {
      preview.targets.push({ dir: target.dir, label: target.label, eligible: count, sizeMB: Math.round(totalSize / 1024 / 1024 * 10) / 10, retentionDays: days });
      preview.totalEligible += count;
    }
  });

  return preview;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  var report = run();
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { run: run, preview: preview, purgeDir: purgeDir };
