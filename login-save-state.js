// login-save-state.js — Sauvegarde la session d'authentification Drupal/SSO
// Usage : node login-save-state.js [sophie|paulo|prod]  (défaut: sophie)
"use strict";

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");
const CFG  = require("./config");

var envName = process.argv[2] || "sophie";
var envUrl  = CFG.envs[envName];
if (!envUrl) {
  console.error("[ERREUR] Env inconnu : " + envName + " — utilise : sophie | paulo | prod");
  process.exit(1);
}

var dataDir  = CFG.dataDir || __dirname;
var authDir  = path.join(dataDir, "auth");
var authFile = path.join(authDir, envName + ".json");
var WAIT_MS  = 90000; // 90s pour se connecter manuellement

// HTTP Basic Auth seulement pour sophie/paulo (staging), pas pour prod
var needsHttpAuth = (envName !== "prod");
var httpAuth = CFG.httpAuth && CFG.httpAuth[envName];

(async () => {
  console.log("==================================================");
  console.log("  LOGIN SAVE STATE — " + envName.toUpperCase());
  console.log("==================================================");
  console.log("  URL    : " + envUrl);
  console.log("  Auth   : " + (needsHttpAuth ? "HTTP Basic (" + (httpAuth ? httpAuth.user : CFG.drupal.user) + ")" : "aucune (prod)"));
  console.log("  Sortie : " + authFile);
  console.log("==================================================\n");

  const browser = await chromium.launch({ headless: false });

  var contextOpts = {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  };
  if (needsHttpAuth) {
    var user = (httpAuth && httpAuth.user) || CFG.drupal.user;
    var pass = (httpAuth && httpAuth.pass) || CFG.drupal.pass;
    if (user && pass) {
      contextOpts.httpCredentials = { username: user, password: pass };
    }
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  console.log("[->] Ouverture de " + envUrl + " ...");
  await page.goto(envUrl, { waitUntil: "load", timeout: 30000 });

  if (needsHttpAuth) {
    console.log("\n⚠️  Connecte-toi manuellement dans le navigateur (SSO / Drupal).");
    console.log("   Tu as " + (WAIT_MS / 1000) + " secondes.\n");
  } else {
    console.log("\n⚠️  La page prod va charger. Si Cloudflare challenge apparaît, résous-le.");
    console.log("   Tu as " + (WAIT_MS / 1000) + " secondes.\n");
  }

  await page.waitForTimeout(WAIT_MS);

  fs.mkdirSync(authDir, { recursive: true });
  await context.storageState({ path: authFile });

  console.log("\n✅ Session sauvegardée : " + authFile);
  console.log("   Elle sera chargée automatiquement par agent-playwright-direct.js\n");
  await browser.close();
})();
