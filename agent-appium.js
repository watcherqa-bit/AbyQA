// agent-appium.js — Agent de test mobile via Appium/WebDriverIO
// Genere et execute des tests mobile (Android/iOS) via Appium
// Usage :
//   node agent-appium.js --mode=generate --text="Tester le login de l'app mobile Safran"
//   node agent-appium.js --mode=run --script=mon-test.js --platform=android
//   node agent-appium.js --mode=generate-run --text="Tester la navigation" --platform=ios

"use strict";

var fs   = require("fs");
var path = require("path");
var CFG  = require("./config");
var ISTQB = require("./istqb-knowledge");
CFG.paths.init();

var SCRIPTS_DIR  = path.join(__dirname, "appium-scripts");
var REPORTS_DIR  = CFG.paths.reports;
var SCREENSHOTS_DIR = CFG.paths.screenshots;

if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

// -- PARSE ARGUMENTS (centralisé dans lib/cli-args.js) ----------------------
var parseArgs = require("./lib/cli-args").parseArgs;

// -- CONFIGURATIONS APPIUM PAR DEFAUT ---------------------------------------
var DEVICE_CONFIGS = {
  "android": {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": "Android Emulator",
    "appium:platformVersion": "14.0"
  },
  "android-chrome": {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": "Android Emulator",
    "appium:platformVersion": "14.0",
    "appium:browserName": "Chrome"
  },
  "ios": {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": "iPhone 15",
    "appium:platformVersion": "17.0"
  },
  "ios-safari": {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": "iPhone 15",
    "appium:platformVersion": "17.0",
    "appium:browserName": "Safari"
  }
};

// -- CONSTRUIRE LES CAPABILITIES APPIUM -------------------------------------
function buildCapabilities(platform, opts) {
  opts = opts || {};
  var base = DEVICE_CONFIGS[platform] || DEVICE_CONFIGS["android-chrome"];
  var caps = JSON.parse(JSON.stringify(base));

  // Surcharges utilisateur
  if (opts.deviceName)      caps["appium:deviceName"]      = opts.deviceName;
  if (opts.platformVersion) caps["appium:platformVersion"]  = opts.platformVersion;
  if (opts.app)             caps["appium:app"]              = opts.app;
  if (opts.browserName)     caps["appium:browserName"]      = opts.browserName;
  if (opts.udid)            caps["appium:udid"]             = opts.udid;

  // Options communes
  caps["appium:newCommandTimeout"] = parseInt(opts.timeout) || 120;
  caps["appium:noReset"] = opts.noReset !== false;

  return caps;
}

// -- EXECUTER UN SCRIPT DE TEST APPIUM --------------------------------------
async function runScript(scriptPath, platform, opts) {
  opts = opts || {};

  var remote;
  try {
    var wdio = require("webdriverio");
    remote = wdio.remote;
  } catch (e) {
    throw new Error("WebDriverIO non installe. Execute : npm install webdriverio");
  }

  if (!fs.existsSync(scriptPath)) {
    throw new Error("Script introuvable : " + scriptPath);
  }

  var scriptContent = fs.readFileSync(scriptPath, "utf8");
  var scriptName = path.basename(scriptPath, ".js");
  var reportId = "appium-" + scriptName + "-" + Date.now();
  var appiumHost = opts.appiumHost || process.env.APPIUM_HOST || "http://127.0.0.1:4723";

  console.log("[APPIUM] ====================================================");
  console.log("[APPIUM] Script    : " + scriptName);
  console.log("[APPIUM] Platform  : " + platform);
  console.log("[APPIUM] Serveur   : " + appiumHost);
  console.log("[APPIUM] ====================================================");

  var caps = buildCapabilities(platform, opts);
  console.log("[APPIUM] Capabilities : " + JSON.stringify(caps, null, 2));

  var driver = null;
  var results = [];
  var startTime = Date.now();

  try {
    console.log("[APPIUM] Connexion au serveur Appium...");
    driver = await remote({
      protocol: appiumHost.startsWith("https") ? "https" : "http",
      hostname: new URL(appiumHost).hostname,
      port: parseInt(new URL(appiumHost).port) || 4723,
      path: "/",
      capabilities: caps,
      logLevel: "warn"
    });
    console.log("[APPIUM] Connecte! Session : " + driver.sessionId);

    // Charger et executer le script de test
    // Le script exporte une fonction async(driver, ctx)
    // ctx contient : env, baseUrl, assert(), screenshot(), log()
    var testFn;
    try {
      // Nettoyer le cache require pour recharger
      delete require.cache[require.resolve(scriptPath)];
      testFn = require(scriptPath);
    } catch (e) {
      throw new Error("Erreur chargement script : " + e.message);
    }

    if (typeof testFn !== "function") {
      throw new Error("Le script doit exporter une fonction : module.exports = async function(driver, ctx) { ... }");
    }

    var assertions = [];
    var logs = [];
    var screenshotPaths = [];

    var ctx = {
      env: opts.env || "sophie",
      baseUrl: CFG.envs.get(opts.env || "sophie"),
      platform: platform,

      // Helper assertion
      assert: function(name, condition, details) {
        var passed = !!condition;
        assertions.push({ name: name, passed: passed, details: details || "" });
        var icon = passed ? "PASS" : "FAIL";
        console.log("[APPIUM]   " + (passed ? "\u2705" : "\u274C") + " " + name);
        if (!passed && details) console.log("[APPIUM]     -> " + details);
        return passed;
      },

      // Helper screenshot
      screenshot: async function(label) {
        try {
          var base64 = await driver.takeScreenshot();
          var fname = reportId + "-" + (label || "screen-" + screenshotPaths.length) + ".png";
          var fpath = path.join(SCREENSHOTS_DIR, fname);
          fs.writeFileSync(fpath, Buffer.from(base64, "base64"));
          screenshotPaths.push(fpath);
          console.log("[APPIUM]   Screenshot : " + fname);
          return fpath;
        } catch (e) {
          console.log("[APPIUM]   Screenshot echoue : " + e.message);
          return null;
        }
      },

      // Helper log
      log: function(msg) {
        logs.push({ time: Date.now() - startTime, message: msg });
        console.log("[APPIUM] " + msg);
      }
    };

    console.log("[APPIUM] Execution du script...");
    await testFn(driver, ctx);

    results = assertions;
    var failCount = assertions.filter(function(a) { return !a.passed; }).length;

    // Rapport
    var report = {
      id: reportId,
      type: "appium",
      timestamp: new Date().toISOString(),
      script: scriptName,
      platform: platform,
      device: caps["appium:deviceName"],
      environment: opts.env || "sophie",
      duration: Date.now() - startTime,
      stats: {
        assertions: { total: assertions.length, failed: failCount, passed: assertions.length - failCount }
      },
      assertions: assertions,
      logs: logs,
      screenshots: screenshotPaths.map(function(p) { return path.basename(p); }),
      verdict: failCount === 0 ? "PASS" : "FAIL"
    };

    // Sauvegarder
    var reportPath = path.join(REPORTS_DIR, reportId + ".json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log("[APPIUM] Rapport sauvegarde : " + reportPath);

    console.log("[APPIUM] ====================================================");
    if (report.verdict === "PASS") {
      console.log("[APPIUM] \u2705 RESULTAT : PASS -- " + report.stats.assertions.passed + "/" + report.stats.assertions.total + " assertions OK");
    } else {
      console.log("[APPIUM] \u274C RESULTAT : FAIL -- " + failCount + " assertion(s) en echec sur " + report.stats.assertions.total);
    }
    console.log("[APPIUM] Duree : " + report.duration + "ms");
    console.log("[APPIUM] ====================================================");

    // Émettre sur le bus inter-agents
    console.log("BUS_EVENT:" + JSON.stringify({ event: "test:mobile-completed", key: opts.key || null, env: opts.env || null, device: opts.deviceName || platform, pass: report.stats.assertions.passed, fail: report.stats.assertions.failed, total: report.stats.assertions.total, scriptPath: scriptPath }));

    return report;

  } catch (e) {
    console.error("[APPIUM] ERREUR : " + e.message);

    var errorReport = {
      id: reportId,
      type: "appium",
      timestamp: new Date().toISOString(),
      script: scriptName,
      platform: platform,
      environment: opts.env || "sophie",
      duration: Date.now() - startTime,
      stats: { assertions: { total: results.length, failed: results.length, passed: 0 } },
      assertions: results,
      error: e.message,
      verdict: "ERROR"
    };
    var errorReportPath = path.join(REPORTS_DIR, reportId + ".json");
    try { fs.writeFileSync(errorReportPath, JSON.stringify(errorReport, null, 2), "utf8"); } catch(e2) { console.error("  [WARN] Écriture rapport erreur:", e2.message); }

    throw e;

  } finally {
    if (driver) {
      try {
        console.log("[APPIUM] Fermeture session...");
        await driver.deleteSession();
      } catch (e) {
        console.warn("[APPIUM] Erreur fermeture : " + e.message);
      }
    }
  }
}

// -- GENERER UN SCRIPT DE TEST VIA CLAUDE -----------------------------------
async function generateScript(text, ticketData, platform) {
  var leadQA;
  try {
    leadQA = require("./agent-lead-qa");
  } catch (e) {
    throw new Error("agent-lead-qa.js non disponible : " + e.message);
  }

  console.log("[APPIUM] Generation du script via Claude API...");
  var script = await leadQA.generateAppiumScript({
    text: text,
    ticketData: ticketData,
    platform: platform || "android-chrome"
  });

  // Sauvegarder
  var slug = (script.name || "test-mobile")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);
  var filename = slug + "-" + Date.now() + ".js";
  var filepath = path.join(SCRIPTS_DIR, filename);

  fs.writeFileSync(filepath, script.code, "utf8");
  console.log("[APPIUM] Script sauvegarde : " + filepath);

  return { filename: filename, filepath: filepath, name: script.name };
}

// -- MAIN -------------------------------------------------------------------
async function main() {
  var args = parseArgs();
  var mode = args.mode || "run";
  var platform = args.platform || "android-chrome";

  console.log("[APPIUM] Mode : " + mode);
  console.log("[APPIUM] Platform : " + platform);

  try {
    if (mode === "generate" || mode === "generate-run") {
      var text = args.text || "";
      var ticketData = null;
      if (args.ticket) {
        try { ticketData = JSON.parse(fs.readFileSync(args.ticket, "utf8")); } catch(e) { console.error("  [WARN] Lecture ticket:", e.message); }
      }

      if (!text && !ticketData) {
        console.error("[APPIUM] Erreur : --text ou --ticket requis en mode generate");
        process.exit(1);
      }

      var gen = await generateScript(text, ticketData, platform);

      if (mode === "generate-run") {
        console.log("[APPIUM] Execution immediate du script genere...");
        await runScript(gen.filepath, platform, args);
      }

    } else if (mode === "run") {
      var scriptFile = args.script;
      if (!scriptFile) {
        console.error("[APPIUM] Erreur : --script=<fichier.js> requis en mode run");
        process.exit(1);
      }

      var scriptPath = path.isAbsolute(scriptFile)
        ? scriptFile
        : path.join(SCRIPTS_DIR, scriptFile);

      if (!fs.existsSync(scriptPath)) {
        console.error("[APPIUM] Script introuvable : " + scriptPath);
        process.exit(1);
      }

      await runScript(scriptPath, platform, args);

    } else {
      console.error("[APPIUM] Mode inconnu : " + mode);
      process.exit(1);
    }

  } catch (e) {
    console.error("[APPIUM] ERREUR FATALE : " + e.message);
    process.exit(1);
  }
}

// -- EXPORTS ----------------------------------------------------------------
module.exports = {
  buildCapabilities: buildCapabilities,
  runScript: runScript,
  generateScript: generateScript,
  DEVICE_CONFIGS: DEVICE_CONFIGS
};

// Execution directe
if (require.main === module) {
  main();
}
