// agent-postman.js — Agent de test API via Postman/Newman
// Génère des collections Postman et les exécute via Newman
// Usage :
//   node agent-postman.js --mode=generate --text="Tester l'API /jsonapi/node/news"
//   node agent-postman.js --mode=run --collection=ma-collection.json --env=sophie
//   node agent-postman.js --mode=generate-run --text="Tester le endpoint /fr/api" --env=sophie

"use strict";

const fs   = require("fs");
const path = require("path");
const CFG  = require("./config");
const ISTQB = require("./istqb-knowledge");
CFG.paths.init();

const COLLECTIONS_DIR = CFG.paths.collections;
const REPORTS_DIR     = CFG.paths.reports;

// ── PARSE ARGUMENTS (centralisé dans lib/cli-args.js) ────────────────────────
var parseArgs = require("./lib/cli-args").parseArgs;

// ── CONSTRUIRE L'ENVIRONNEMENT POSTMAN ──────────────────────────────────────
function buildEnvironment(envName) {
  var env = envName || "sophie";
  var baseUrl = CFG.envs.get(env);
  var auth = CFG.httpAuth[env] || {};

  return {
    id: "env-" + env,
    name: env,
    values: [
      { key: "baseUrl",   value: baseUrl,              enabled: true },
      { key: "httpUser",  value: auth.user || "",       enabled: true },
      { key: "httpPass",  value: auth.pass || "",       enabled: true },
      { key: "jiraHost",  value: CFG.jira.host,         enabled: true },
      { key: "jiraAuth",  value: CFG.jira.authHeader(), enabled: true }
    ]
  };
}

// ── EXÉCUTER UNE COLLECTION VIA NEWMAN ──────────────────────────────────────
function runCollection(collectionPath, envName, options) {
  return new Promise(function(resolve, reject) {
    var newman;
    try {
      newman = require("newman");
    } catch (e) {
      reject(new Error("Newman non installé. Exécute : npm install newman"));
      return;
    }

    var collectionData;
    try {
      collectionData = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
    } catch (e) {
      reject(new Error("Collection invalide : " + e.message));
      return;
    }

    if (!collectionData.item || collectionData.item.length === 0) {
      reject(new Error("Collection vide — aucune requête à exécuter"));
      return;
    }

    var collectionName = collectionData.info ? collectionData.info.name : path.basename(collectionPath, ".json");
    var reportId = "postman-" + Date.now();
    var reportPath = path.join(REPORTS_DIR, reportId + ".json");
    var environment = buildEnvironment(envName);

    console.log("[POSTMAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("[POSTMAN] Collection : " + collectionName);
    console.log("[POSTMAN] Environnement : " + (envName || "sophie"));
    console.log("[POSTMAN] Requêtes : " + collectionData.item.length);
    console.log("[POSTMAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    newman.run({
      collection: collectionData,
      environment: environment,
      iterationCount: parseInt(options.iterations) || 1,
      timeoutRequest: parseInt(options.timeout) || 30000,
      insecure: true,
      reporters: []
    })
    .on("request", function(err, data) {
      if (data && data.item) {
        var req  = data.item.name || "Requête";
        var resp = data.response || {};
        var code = resp.code || "???";
        var time = resp.responseTime || 0;
        var icon = (code >= 200 && code < 400) ? "✅" : "❌";
        console.log("[POSTMAN] " + icon + " " + req + " → " + code + " (" + time + "ms)");
      }
    })
    .on("assertion", function(err, data) {
      if (err) {
        console.log("[POSTMAN]   ❌ Assertion FAIL : " + (data.assertion || err.message));
      }
    })
    .on("done", function(err, summary) {
      if (err) {
        reject(new Error("Newman error : " + err.message));
        return;
      }

      var report = formatReport(summary, collectionName, envName, reportId);

      // Sauvegarder le rapport JSON
      try {
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
        console.log("[POSTMAN] Rapport sauvegardé : " + reportPath);
      } catch (e) {
        console.error("[POSTMAN] Erreur sauvegarde rapport : " + e.message);
      }

      // Verdict final
      console.log("[POSTMAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      if (report.verdict === "PASS") {
        console.log("[POSTMAN] ✅ RÉSULTAT : PASS — " + report.stats.assertions.total + "/" + report.stats.assertions.total + " assertions OK");
      } else {
        console.log("[POSTMAN] ❌ RÉSULTAT : FAIL — " + report.stats.assertions.failed + " assertion(s) en échec sur " + report.stats.assertions.total);
      }
      console.log("[POSTMAN] Durée totale : " + report.duration + "ms");
      console.log("[POSTMAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      // Émettre sur le bus inter-agents
      console.log("BUS_EVENT:" + JSON.stringify({ event: "test:api-completed", key: (options && options.key) || null, env: envName, collectionName: collectionName, pass: report.stats.assertions.total - report.stats.assertions.failed, fail: report.stats.assertions.failed, total: report.stats.assertions.total, reportPath: report.reportPath || null }));

      resolve(report);
    });
  });
}

// ── FORMATER LE RAPPORT NEWMAN ──────────────────────────────────────────────
function formatReport(summary, collectionName, envName, reportId) {
  var run = summary.run || {};
  var stats = run.stats || {};
  var timings = run.timings || {};

  var results = [];
  var failures = [];

  (run.executions || []).forEach(function(exec) {
    var item = exec.item || {};
    var req  = exec.request || {};
    var resp = exec.response || {};

    var assertions = (exec.assertions || []).map(function(a) {
      var passed = !a.error;
      if (!passed) {
        failures.push({
          request: item.name || "Inconnu",
          assertion: a.assertion || "Assertion",
          error: a.error ? a.error.message : "Échec"
        });
      }
      return {
        name: a.assertion || "Assertion",
        passed: passed,
        error: a.error ? a.error.message : null
      };
    });

    results.push({
      name: item.name || "Requête",
      method: req.method || "GET",
      url: req.url ? (typeof req.url === "string" ? req.url : req.url.toString()) : "",
      status: resp.code || 0,
      responseTime: resp.responseTime || 0,
      assertions: assertions,
      passed: assertions.every(function(a) { return a.passed; })
    });
  });

  return {
    id: reportId,
    type: "postman",
    timestamp: new Date().toISOString(),
    collection: collectionName,
    environment: envName || "sophie",
    duration: timings.completed ? timings.completed - timings.started : 0,
    stats: {
      requests:   { total: (stats.requests   || {}).total || 0, failed: (stats.requests   || {}).failed || 0 },
      assertions: { total: (stats.assertions || {}).total || 0, failed: (stats.assertions || {}).failed || 0 },
      testScripts:{ total: (stats.testScripts|| {}).total || 0, failed: (stats.testScripts|| {}).failed || 0 }
    },
    results: results,
    failures: failures,
    verdict: ((stats.assertions || {}).failed || 0) === 0 ? "PASS" : "FAIL"
  };
}

// ── GÉNÉRER UNE COLLECTION VIA LE LEAD QA ───────────────────────────────────
async function generateCollection(text, ticketData) {
  var leadQA;
  try {
    leadQA = require("./agent-lead-qa");
  } catch (e) {
    throw new Error("agent-lead-qa.js non disponible : " + e.message);
  }

  console.log("[POSTMAN] Génération de la collection via Claude API...");
  var collection = await leadQA.generatePostmanCollection({
    text: text,
    ticketData: ticketData
  });

  // Sauvegarder
  var slug = (collection.info && collection.info.name || "collection")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);
  var filename = slug + "-" + Date.now() + ".json";
  var filepath = path.join(COLLECTIONS_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(collection, null, 2), "utf8");
  console.log("[POSTMAN] Collection sauvegardée : " + filepath);
  console.log("[POSTMAN] Requêtes générées : " + (collection.item || []).length);

  return { filename: filename, filepath: filepath, collection: collection };
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  var args = parseArgs();
  var mode = args.mode || "run";

  console.log("[POSTMAN] Mode : " + mode);

  try {
    if (mode === "generate" || mode === "generate-run") {
      var text = args.text || "";
      var ticketData = null;
      if (args.ticket) {
        try {
          ticketData = JSON.parse(fs.readFileSync(args.ticket, "utf8"));
        } catch (e) {
          console.error("[POSTMAN] Erreur lecture ticket : " + e.message);
        }
      }

      if (!text && !ticketData) {
        console.error("[POSTMAN] Erreur : --text ou --ticket requis en mode generate");
        process.exit(1);
      }

      var gen = await generateCollection(text, ticketData);

      if (mode === "generate-run") {
        console.log("[POSTMAN] Exécution immédiate de la collection générée...");
        await runCollection(gen.filepath, args.env || "sophie", args);
      }

    } else if (mode === "run") {
      var collectionFile = args.collection;
      if (!collectionFile) {
        console.error("[POSTMAN] Erreur : --collection=<fichier.json> requis en mode run");
        process.exit(1);
      }

      var collectionPath = path.isAbsolute(collectionFile)
        ? collectionFile
        : path.join(COLLECTIONS_DIR, collectionFile);

      if (!fs.existsSync(collectionPath)) {
        console.error("[POSTMAN] Collection introuvable : " + collectionPath);
        process.exit(1);
      }

      await runCollection(collectionPath, args.env || "sophie", args);

    } else {
      console.error("[POSTMAN] Mode inconnu : " + mode + " (attendu : generate, run, generate-run)");
      process.exit(1);
    }

  } catch (e) {
    console.error("[POSTMAN] ERREUR : " + e.message);
    process.exit(1);
  }
}

// ── EXPORTS (pour usage par agent-server.js) ────────────────────────────────
module.exports = {
  buildEnvironment,
  runCollection,
  formatReport,
  generateCollection
};

// Exécution directe
if (require.main === module) {
  main();
}
