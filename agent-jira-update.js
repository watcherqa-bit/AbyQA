// agent-jira-update.js - Mise à jour d'un ticket Jira existant
// Sans supprimer le ticket — ajoute commentaire, instructions, cas de test ou statut
//
// Usage :
//   node agent-jira-update.js SAFWBST-2706 --action=add-comment --content="Tester sur mobile"
//   node agent-jira-update.js SAFWBST-2706 --action=add-instructions --content="Vérifier police Barlow"
//   node agent-jira-update.js SAFWBST-2706 --action=add-steps --content="TC11 - Vérifier footer"
//   node agent-jira-update.js SAFWBST-2706 --action=update-status --content="In Progress"

"use strict";


const fs    = require("fs");
const path  = require("path");
const CFG   = require("./config");
CFG.paths.init();

const REPORTS_DIR = CFG.paths.reports;

// ── HELPER JIRA (centralisé dans lib/jira-client.js) ─────────────────────────
var jiraRequest = require("./lib/jira-client").jiraRequest;

// ── RECUPERER LE TICKET ───────────────────────────────────────────────────────
async function getTicket(key) {
  console.log("[INFO] Chargement du ticket " + key + "...");
  var issue = await jiraRequest("GET", "/rest/api/2/issue/" + key + "?fields=summary,status,description,issuetype,labels,comment");
  if (!issue.key) throw new Error("Ticket " + key + " introuvable");
  console.log("[OK] " + issue.key + " — " + issue.fields.summary);
  console.log("     Statut : " + issue.fields.status.name);
  console.log("     Type   : " + issue.fields.issuetype.name);
  return issue;
}

// ── AJOUTER UN COMMENTAIRE ────────────────────────────────────────────────────
async function addComment(key, content) {
  console.log("[->] Ajout commentaire sur " + key + "...");
  var date = new Date().toLocaleDateString("fr-FR") + " " + new Date().toLocaleTimeString("fr-FR");
  var body = {
    body: content
  };
  var result = await jiraRequest("POST", "/rest/api/2/issue/" + key + "/comment", body);
  if (result.id) {
    console.log("[OK] Commentaire ajouté (id: " + result.id + ")");
    return result;
  }
  throw new Error("Echec ajout commentaire");
}

// ── AJOUTER DES INSTRUCTIONS ──────────────────────────────────────────────────
async function addInstructions(key, content, issue) {
  console.log("[->] Ajout instructions dans la description de " + key + "...");
  var currentDesc = issue.fields.description || "";
  var date = new Date().toLocaleDateString("fr-FR");

  var addition = "\n\n---\n\n*INSTRUCTIONS DE TEST — " + date + "*\n\n" + content;
  var newDesc   = currentDesc + addition;

  await jiraRequest("PUT", "/rest/api/2/issue/" + key, {
    fields: { description: newDesc }
  });
  console.log("[OK] Instructions ajoutées dans la description");

  // Aussi en commentaire pour traçabilité
  await addComment(key, "*Instructions ajoutées à la description :*\n\n" + content);
}

// ── AJOUTER DES CAS DE TEST ───────────────────────────────────────────────────
async function addSteps(key, content, issue) {
  console.log("[->] Ajout cas de test sur " + key + "...");
  var currentDesc = issue.fields.description || "";
  var date = new Date().toLocaleDateString("fr-FR");

  // Trouver le dernier TC numéro existant
  var lastTC = 0;
  var tcMatches = currentDesc.match(/TC(\d+)/g) || [];
  tcMatches.forEach(function(tc) {
    var n = parseInt(tc.replace("TC", ""));
    if (n > lastTC) lastTC = n;
  });
  var nextTC = lastTC + 1;

  // Formater les nouveaux cas
  var newSteps = "\n\n---\n\n*CAS DE TEST AJOUTÉS — " + date + "*\n\n";
  var lines = content.split("\n");
  lines.forEach(function(line) {
    if (line.trim()) {
      newSteps += "*TC" + String(nextTC).padStart(2, "0") + "* - " + line.trim() + "\n";
      nextTC++;
    }
  });

  var newDesc = currentDesc + newSteps;
  await jiraRequest("PUT", "/rest/api/2/issue/" + key, {
    fields: { description: newDesc }
  });
  console.log("[OK] " + (nextTC - lastTC - 1) + " cas de test ajoutés (TC" +
    String(lastTC + 1).padStart(2, "0") + " → TC" + String(nextTC - 1).padStart(2, "0") + ")");
  // Les cas de test vont uniquement dans Xray via CSV — pas de commentaire Jira
}

// ── METTRE À JOUR LE STATUT ───────────────────────────────────────────────────
async function updateStatus(key, targetStatus) {
  console.log("[->] Changement statut " + key + " → " + targetStatus + "...");
  var transitions = await jiraRequest("GET", "/rest/api/2/issue/" + key + "/transitions");

  if (!transitions.transitions || transitions.transitions.length === 0) {
    throw new Error("Aucune transition disponible");
  }

  console.log("     Transitions disponibles :");
  transitions.transitions.forEach(function(t) {
    console.log("     - " + t.name + " (id: " + t.id + ")");
  });

  var target = transitions.transitions.find(function(t) {
    return t.name.toLowerCase().includes(targetStatus.toLowerCase()) ||
           t.to.name.toLowerCase().includes(targetStatus.toLowerCase());
  });

  if (!target) {
    console.log("[WARN] Transition '" + targetStatus + "' non trouvée");
    console.log("[INFO] Transitions disponibles : " + transitions.transitions.map(function(t) { return t.name; }).join(", "));
    return;
  }

  await jiraRequest("POST", "/rest/api/2/issue/" + key + "/transitions", {
    transition: { id: target.id }
  });
  console.log("[OK] Statut mis à jour → " + target.name);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  var args      = process.argv.slice(2);
  var ticketKey = args[0];
  var actionArg = args.find(function(a) { return a.startsWith("--action="); });
  var contentArg= args.find(function(a) { return a.startsWith("--content="); });

  var action  = actionArg  ? actionArg.split("=").slice(1).join("=")  : "add-comment";
  var content = contentArg ? contentArg.split("=").slice(1).join("=") : "";

  if (!ticketKey || !ticketKey.match(/^[A-Z]+-\d+$/i)) {
    console.error("[ERR] Clé ticket invalide. Ex: SAFWBST-2706");
    process.exit(1);
  }

  if (!content) {
    console.error("[ERR] Contenu vide — utilise --content='...'");
    process.exit(1);
  }

  if (!CFG.jira.token) {
    console.error("[ERR] JIRA_TOKEN manquant dans .env");
    process.exit(1);
  }

  ticketKey = ticketKey.toUpperCase();

  console.log("==================================================");
  console.log("  AGENT JIRA UPDATE - ABY QA V2");
  console.log("==================================================");
  console.log("  Ticket  : " + ticketKey);
  console.log("  Action  : " + action);
  console.log("  Contenu : " + content.substring(0, 60) + (content.length > 60 ? "..." : ""));
  console.log("==================================================\n");

  var issue = await getTicket(ticketKey);

  switch(action) {
    case "add-comment":
      await addComment(ticketKey, content);
      break;
    case "add-instructions":
      await addInstructions(ticketKey, content, issue);
      break;
    case "add-steps":
      await addSteps(ticketKey, content, issue);
      break;
    case "update-status":
      await updateStatus(ticketKey, content);
      break;
    default:
      console.error("[ERR] Action inconnue : " + action);
      console.log("      Actions valides : add-comment, add-instructions, add-steps, update-status");
      process.exit(1);
  }

  // Rapport
  var reportPath = path.join(REPORTS_DIR, "UPDATE-" + ticketKey + "-" + Date.now() + ".md");
  var report = "# Mise à jour " + ticketKey + "\n\n";
  report += "- **Action :** " + action + "\n";
  report += "- **Date :** " + new Date().toLocaleString("fr-FR") + "\n";
  report += "- **Contenu :** " + content + "\n";
  report += "- **Lien :** https://" + CFG.jira.host + "/browse/" + ticketKey + "\n";
  fs.writeFileSync(reportPath, report, "utf8");

  console.log("\n[OK] Mise à jour terminée");
  console.log("  Rapport : " + reportPath);
  console.log("  Lien    : https://" + CFG.jira.host + "/browse/" + ticketKey);
}

main().catch(function(e) {
  console.error("[ERR FATAL]", e.message);
  process.exit(1);
});
