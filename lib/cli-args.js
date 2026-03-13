// lib/cli-args.js — Parsing d'arguments CLI centralisé
// Remplace les copies de parseArgs() dans chaque agent
"use strict";

/**
 * Parse les arguments CLI au format --key=value et --flag.
 * @param {string[]} [argv] - tableau d'arguments (défaut: process.argv.slice(2))
 * @returns {object} clés/valeurs parsées
 *
 * Exemples :
 *   --mode=generate  → { mode: "generate" }
 *   --dry-run        → { "dry-run": true }
 *   --env=sophie     → { env: "sophie" }
 */
function parseArgs(argv) {
  var rawArgs = argv || process.argv.slice(2);
  var args = {};
  rawArgs.forEach(function(a) {
    if (a.startsWith("--")) {
      var idx = a.indexOf("=");
      if (idx > -1) {
        args[a.substring(2, idx)] = a.substring(idx + 1);
      } else {
        args[a.substring(2)] = true;
      }
    }
  });
  return args;
}

/**
 * Raccourci pour lire un argument nommé (format agent-playwright-direct).
 * @param {string} name - nom de l'argument (sans --)
 * @param {string[]} [argv] - tableau d'arguments (défaut: process.argv.slice(2))
 * @returns {string|null}
 */
function arg(name, argv) {
  var rawArgs = argv || process.argv.slice(2);
  var a = rawArgs.find(function(a) { return a.startsWith("--" + name + "="); });
  return a ? a.split("=").slice(1).join("=") : null;
}

/**
 * Raccourci pour vérifier un flag booléen.
 * @param {string} name - nom du flag (sans --)
 * @param {string[]} [argv] - tableau d'arguments (défaut: process.argv.slice(2))
 * @returns {boolean}
 */
function flag(name, argv) {
  var rawArgs = argv || process.argv.slice(2);
  return rawArgs.includes("--" + name);
}

module.exports = { parseArgs: parseArgs, arg: arg, flag: flag };
