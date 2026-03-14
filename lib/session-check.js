// lib/session-check.js — Vérification storageState Playwright centralisée
// Remplace les copies de checkStorageStateAge() dans chaque agent
"use strict";

const fs   = require("fs");
const path = require("path");

var STORAGE_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Vérifie l'âge du fichier auth/{env}.json (cookies Cloudflare).
 * @param {string} envName - nom de l'environnement (sophie, paulo, prod)
 * @param {string} [baseDir] - répertoire de base (défaut: répertoire parent de lib/)
 * @returns {{ ok: boolean, expired: boolean, absent: boolean, age: number|null, message: string }}
 */
function checkStorageStateAge(envName, baseDir) {
  var CFG;
  try { CFG = require("../config"); } catch(e) {}
  var base = baseDir || (CFG && CFG.dataDir) || path.join(__dirname, "..");
  var authFile = path.join(base, "auth", envName + ".json");

  if (!fs.existsSync(authFile)) {
    return {
      ok: false,
      expired: true,
      absent: true,
      age: null,
      message: "Session absente pour " + envName + " — relancer login-save-state.js " + envName
    };
  }

  var stat = fs.statSync(authFile);
  var ageMs = Date.now() - stat.mtimeMs;

  if (ageMs > STORAGE_STATE_MAX_AGE_MS) {
    var ageH = Math.round(ageMs / 3600000);
    return {
      ok: false,
      expired: true,
      absent: false,
      age: ageH,
      message: "Session expirée (" + ageH + "h) pour " + envName + " — relancer login-save-state.js " + envName
    };
  }

  return {
    ok: true,
    expired: false,
    absent: false,
    age: Math.round(ageMs / 3600000)
  };
}

module.exports = { checkStorageStateAge: checkStorageStateAge };
