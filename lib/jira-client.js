// lib/jira-client.js — Client Jira centralisé
// Remplace les copies de jiraRequest() dans chaque agent
"use strict";

const https = require("https");
const CFG   = require("../config");

/**
 * Appel HTTP vers l'API Jira REST.
 * @param {string} method - GET, POST, PUT, DELETE
 * @param {string} apiPath - ex: /rest/api/3/issue/SAF-123
 * @param {object|string|null} body - payload (objet JSON ou string brute)
 * @param {object} [opts] - options supplémentaires
 * @param {string} [opts.contentType] - Content-Type custom (défaut: application/json)
 * @param {boolean} [opts.rejectOnError] - rejeter la promesse si HTTP >= 400 (défaut: true)
 * @param {boolean} [opts.rawResponse] - retourner la réponse brute (string) au lieu de JSON (défaut: false)
 * @returns {Promise<object|string>}
 */
function jiraRequest(method, apiPath, body, opts) {
  opts = opts || {};
  var contentType   = opts.contentType || "application/json";
  var rejectOnError = opts.rejectOnError !== false; // true par défaut
  var rawResponse   = opts.rawResponse || false;

  return new Promise(function(resolve, reject) {
    var auth    = Buffer.from(CFG.jira.email + ":" + CFG.jira.token).toString("base64");
    var payload = null;

    if (body) {
      payload = (typeof body === "string") ? body : JSON.stringify(body);
    }

    var headers = {
      "Authorization": "Basic " + auth,
      "Accept":        "application/json",
      "Content-Type":  contentType
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    var options = {
      hostname: CFG.jira.host,
      path:     apiPath,
      method:   method,
      headers:  headers
    };

    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        // Réponse brute demandée
        if (rawResponse) {
          if (rejectOnError && res.statusCode >= 400) {
            reject(new Error("HTTP " + res.statusCode + " : " + data.substring(0, 300)));
          } else {
            resolve(data);
          }
          return;
        }
        // Parse JSON
        try {
          var parsed = data ? JSON.parse(data) : {};
          if (rejectOnError && res.statusCode >= 400) {
            reject(new Error("HTTP " + res.statusCode + " : " + data.substring(0, 300)));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          // Réponse non-JSON (ex: 204 No Content, texte brut)
          if (rejectOnError && res.statusCode >= 400) {
            reject(new Error("HTTP " + res.statusCode + " : " + data.substring(0, 300)));
          } else {
            resolve(data || {});
          }
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Raccourci compatible ancien format (sans opts) pour migration douce.
 * jiraRequest(method, path, body) → fonctionne tel quel.
 * jiraRequest(method, path, body, true, "multipart/form-data") → migration xray.
 */
function jiraRequestCompat(method, apiPath, body, isMultipartOrOpts, contentType) {
  // Ancien format xray : jiraRequest(method, path, body, true, "text/xml")
  if (typeof isMultipartOrOpts === "boolean" || typeof isMultipartOrOpts === "string") {
    return jiraRequest(method, apiPath, body, {
      contentType: contentType || (isMultipartOrOpts ? "text/xml" : "application/json"),
      rejectOnError: true
    });
  }
  // Nouveau format : jiraRequest(method, path, body, { opts })
  if (typeof isMultipartOrOpts === "object") {
    return jiraRequest(method, apiPath, body, isMultipartOrOpts);
  }
  // Format simple : jiraRequest(method, path, body)
  return jiraRequest(method, apiPath, body, { rejectOnError: false });
}

module.exports = { jiraRequest: jiraRequest, jiraRequestCompat: jiraRequestCompat };
