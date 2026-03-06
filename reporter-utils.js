/**
 * reporter-utils.js — Utilitaires centralisés pour les rapports HTML (screenshots base64, blocs HTML)
 */
const fs   = require("fs");
const path = require("path");

/**
 * Encode un screenshot en data-URI base64.
 * @param {string} filePath — chemin absolu ou relatif du fichier image
 * @param {string} [screenshotsDir] — dossier de fallback si filePath est un basename
 * @returns {string|null} data-URI "data:image/png;base64,..." ou null si indisponible
 */
function encodeScreenshot(filePath, screenshotsDir) {
  if (!filePath) return null;
  try {
    var absPath = path.isAbsolute(filePath) ? filePath : path.join(screenshotsDir || ".", path.basename(filePath));
    if (!fs.existsSync(absPath)) {
      console.warn("[reporter-utils] Screenshot introuvable : " + absPath);
      return null;
    }
    var buf = fs.readFileSync(absPath);
    if (buf.length === 0) {
      console.warn("[reporter-utils] Screenshot vide (0 octets) : " + absPath);
      return null;
    }
    var ext = path.extname(absPath).toLowerCase();
    var mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
            : ext === ".webp" ? "image/webp"
            : ext === ".gif"  ? "image/gif"
            : "image/png";
    return "data:" + mime + ";base64," + buf.toString("base64");
  } catch (e) {
    console.warn("[reporter-utils] Erreur lecture screenshot : " + e.message);
    return null;
  }
}

/**
 * Génère le HTML complet pour afficher un screenshot dans un rapport.
 * @param {string} filePath — chemin du fichier image
 * @param {string} [label] — légende optionnelle
 * @param {string} [screenshotsDir] — dossier fallback
 * @param {object} [opts] — options { maxWidth:"220px", clickToZoom:true }
 * @returns {string} HTML (<img> avec base64) ou placeholder si indisponible
 */
function buildScreenshotHtml(filePath, label, screenshotsDir, opts) {
  opts = opts || {};
  var maxW = opts.maxWidth || "220px";
  var zoomW = opts.zoomWidth || "600px";
  var b64 = encodeScreenshot(filePath, screenshotsDir);
  if (!b64) {
    return "<span style='color:#4a5568;font-size:10px;font-family:monospace'>-- pas de screenshot</span>";
  }
  var clickZoom = opts.clickToZoom !== false
    ? " onclick=\"this.style.maxWidth=this.style.maxWidth==='" + maxW + "'?'" + zoomW + "':'" + maxW + "'\" style='cursor:zoom-in;"
    : " style='";
  var html = "<img src='" + b64 + "'" + clickZoom +
    "max-width:" + maxW + ";border-radius:4px;border:1px solid #1e2536;display:block'" +
    " loading='lazy'>";
  if (label) {
    html = "<div style='text-align:center'>" + html +
      "<div style='font-family:monospace;font-size:9px;color:#4a5568;margin-top:3px'>" + label + "</div></div>";
  }
  return html;
}

module.exports = { encodeScreenshot, buildScreenshotHtml };
