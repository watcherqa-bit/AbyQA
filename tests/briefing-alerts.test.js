// tests/briefing-alerts.test.js — Tests de la logique d'alertes du briefing IA
// Teste la logique de collecte d'alertes (0 token) sans appeler le serveur
"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

describe("Briefing — logique d'alertes", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-test-"));
    // Créer la structure de dossiers
    fs.mkdirSync(path.join(tmpDir, "inbox", "backlog"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "inbox", "enriched"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Fonction helper qui reproduit la logique d'alertes de routes/backlog.js
  function collectAlerts(baseDir) {
    var BACKLOG_P = path.join(baseDir, "inbox", "backlog", "pending.json");
    var TRACKER_PATH = path.join(baseDir, "reports", "release-tracker.json");
    var AUTH_DIR = path.join(baseDir, "auth");

    var alerts = [];

    // 1. Backlog
    var pending = [];
    try { pending = JSON.parse(fs.readFileSync(BACKLOG_P, "utf8")); } catch(e) {}
    var stories = pending.filter(function(t) { return t.type === "Story" || t.type === "User Story"; });
    var uncovered = stories.filter(function(t) { return !t.hasTest && !t.testKey; });

    if (uncovered.length > 0) {
      var uncovKeys = uncovered.slice(0, 5).map(function(t) { return t.key; }).join(", ");
      alerts.push({
        type: "coverage",
        severity: uncovered.length > 3 ? "high" : "medium",
        data: uncovered.length + " US sans couverture test" + (uncovered.length <= 5 ? " (" + uncovKeys + ")" : "")
      });
    }

    var highPrio = pending.filter(function(t) {
      return (t.priority === "High" || t.priority === "Highest" || t.priority === "Critical");
    });
    if (highPrio.length > 0) {
      var hpNoTest = highPrio.filter(function(t) { return !t.hasTest && !t.testKey; });
      if (hpNoTest.length > 0) {
        alerts.push({
          type: "priority",
          severity: "high",
          data: hpNoTest.length + " tickets haute priorité sans test : " + hpNoTest.slice(0, 3).map(function(t) { return t.key; }).join(", ")
        });
      }
    }

    // 2. Release tracker
    var tracker = {};
    try { tracker = JSON.parse(fs.readFileSync(TRACKER_PATH, "utf8")); } catch(e) {}
    var releases = Object.keys(tracker);
    if (releases.length > 0) {
      var latestRel = releases[releases.length - 1];
      var rd = tracker[latestRel];
      var pass = rd.totalPass || 0;
      var fail = rd.totalFail || 0;
      var tested = pass + fail;
      var pct = tested > 0 ? Math.round(pass / tested * 100) : 0;
      if (fail > 0) {
        alerts.push({
          type: "release",
          severity: pct < 50 ? "high" : pct < 80 ? "medium" : "low",
          data: "Release " + latestRel + " à " + pct + "% de réussite — " + fail + " FAIL"
        });
      }
    }

    // 3. Sessions Playwright
    ["sophie", "paulo", "prod"].forEach(function(env) {
      var authFile = path.join(AUTH_DIR, env + ".json");
      if (!fs.existsSync(authFile)) {
        alerts.push({
          type: "session",
          severity: "medium",
          data: "Session " + env + " absente — relancer login-save-state.js"
        });
      } else {
        var stat = fs.statSync(authFile);
        var ageH = Math.round((Date.now() - stat.mtimeMs) / 3600000);
        if (ageH > 24) {
          alerts.push({
            type: "session",
            severity: "medium",
            data: "Session " + env + " expirée (" + ageH + "h)"
          });
        }
      }
    });

    return alerts;
  }

  test("aucune alerte si backlog vide et sessions présentes", () => {
    // Écrire un backlog vide
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), "[]", "utf8");
    // Créer des fichiers de session récents
    ["sophie", "paulo", "prod"].forEach(env => {
      fs.writeFileSync(path.join(tmpDir, "auth", env + ".json"), "{}", "utf8");
    });

    var alerts = collectAlerts(tmpDir);
    expect(alerts).toHaveLength(0);
  });

  test("alerte coverage quand des US n'ont pas de test", () => {
    var pending = [
      { key: "SAF-100", type: "Story", hasTest: false },
      { key: "SAF-101", type: "Story", hasTest: false },
      { key: "SAF-102", type: "Story", hasTest: true }
    ];
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), JSON.stringify(pending), "utf8");
    ["sophie", "paulo", "prod"].forEach(env => {
      fs.writeFileSync(path.join(tmpDir, "auth", env + ".json"), "{}", "utf8");
    });

    var alerts = collectAlerts(tmpDir);
    var coverage = alerts.find(a => a.type === "coverage");
    expect(coverage).toBeDefined();
    expect(coverage.severity).toBe("medium"); // 2 <= 3
    expect(coverage.data).toContain("2 US sans couverture");
    expect(coverage.data).toContain("SAF-100");
  });

  test("alerte severity high si > 3 US sans couverture", () => {
    var pending = [
      { key: "SAF-1", type: "Story" },
      { key: "SAF-2", type: "Story" },
      { key: "SAF-3", type: "Story" },
      { key: "SAF-4", type: "Story" }
    ];
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), JSON.stringify(pending), "utf8");
    ["sophie", "paulo", "prod"].forEach(env => {
      fs.writeFileSync(path.join(tmpDir, "auth", env + ".json"), "{}", "utf8");
    });

    var alerts = collectAlerts(tmpDir);
    var coverage = alerts.find(a => a.type === "coverage");
    expect(coverage.severity).toBe("high");
  });

  test("alerte priorité haute si tickets haute priorité sans test", () => {
    var pending = [
      { key: "SAF-50", type: "Story", priority: "High" },
      { key: "SAF-51", type: "Story", priority: "Critical", hasTest: true },
      { key: "SAF-52", type: "Task", priority: "Highest" }
    ];
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), JSON.stringify(pending), "utf8");
    ["sophie", "paulo", "prod"].forEach(env => {
      fs.writeFileSync(path.join(tmpDir, "auth", env + ".json"), "{}", "utf8");
    });

    var alerts = collectAlerts(tmpDir);
    var prio = alerts.find(a => a.type === "priority");
    expect(prio).toBeDefined();
    expect(prio.severity).toBe("high");
    expect(prio.data).toContain("2 tickets haute priorité sans test");
  });

  test("alerte release quand il y a des FAIL", () => {
    var tracker = {
      "v1.25.0": { totalPass: 8, totalFail: 2 }
    };
    fs.writeFileSync(path.join(tmpDir, "reports", "release-tracker.json"), JSON.stringify(tracker), "utf8");
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), "[]", "utf8");
    ["sophie", "paulo", "prod"].forEach(env => {
      fs.writeFileSync(path.join(tmpDir, "auth", env + ".json"), "{}", "utf8");
    });

    var alerts = collectAlerts(tmpDir);
    var release = alerts.find(a => a.type === "release");
    expect(release).toBeDefined();
    expect(release.severity).toBe("low"); // 80% → low (>= 80%)
    expect(release.data).toContain("v1.25.0");
    expect(release.data).toContain("80%");
    expect(release.data).toContain("2 FAIL");
  });

  test("severity release high si < 50% réussite", () => {
    var tracker = {
      "v2.0.0": { totalPass: 2, totalFail: 8 }
    };
    fs.writeFileSync(path.join(tmpDir, "reports", "release-tracker.json"), JSON.stringify(tracker), "utf8");
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), "[]", "utf8");
    ["sophie", "paulo", "prod"].forEach(env => {
      fs.writeFileSync(path.join(tmpDir, "auth", env + ".json"), "{}", "utf8");
    });

    var alerts = collectAlerts(tmpDir);
    var release = alerts.find(a => a.type === "release");
    expect(release.severity).toBe("high"); // 20% < 50
  });

  test("alerte session absente", () => {
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), "[]", "utf8");
    // Pas de fichiers auth → 3 alertes session

    var alerts = collectAlerts(tmpDir);
    var sessions = alerts.filter(a => a.type === "session");
    expect(sessions).toHaveLength(3);
    expect(sessions[0].data).toContain("absente");
  });

  test("alerte session expirée", () => {
    fs.writeFileSync(path.join(tmpDir, "inbox", "backlog", "pending.json"), "[]", "utf8");
    // Créer un fichier de session ancien (48h)
    var authFile = path.join(tmpDir, "auth", "sophie.json");
    fs.writeFileSync(authFile, "{}", "utf8");
    var oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(authFile, oldTime, oldTime);
    // Les autres sessions absentes
    fs.writeFileSync(path.join(tmpDir, "auth", "paulo.json"), "{}", "utf8");
    fs.writeFileSync(path.join(tmpDir, "auth", "prod.json"), "{}", "utf8");

    var alerts = collectAlerts(tmpDir);
    var sessionExpired = alerts.find(a => a.type === "session" && a.data.includes("expirée"));
    expect(sessionExpired).toBeDefined();
    expect(sessionExpired.data).toContain("sophie");
  });
});
