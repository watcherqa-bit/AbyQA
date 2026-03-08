// agent-lead-qa.js — Cerveau IA V3
// Propulsé par Anthropic API
// Remplace Ollama pour toutes les décisions et générations QA
// Usage : const leadQA = require("./agent-lead-qa");

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const CFG       = require("./config");
const fs        = require("fs");
const path      = require("path");

// ── CLIENT ANTHROPIC ──────────────────────────────────────────────────────────
const client = new Anthropic({ apiKey: CFG.anthropic.apiKey });

// Modèles
const MODEL_FAST    = "claude-haiku-4-5-20251001";  // Décisions rapides (routing, analyse)
const MODEL_QUALITY = "claude-sonnet-4-6";           // Génération de contenu qualité

// ── RÈGLES ANTI-HALLUCINATION — appliquées à toutes les générations ───────────
const ANTI_HALLU =
  "RÈGLES ABSOLUES — NE PAS VIOLER :\n" +
  "1. Génère UNIQUEMENT du contenu basé sur les données du ticket source fourni ci-dessous.\n" +
  "2. EXPLOITE TOUTES les informations présentes dans le ticket source : description, AC, URLs, valeurs de test, noms de champs.\n" +
  "3. Ne JAMAIS écrire [À préciser], [URL à préciser], [À compléter] ou toute placeholder entre crochets.\n" +
  "4. Si une information manque, OMETS le champ ou la section entièrement — ne mets PAS de placeholder.\n" +
  "5. URLs → réutilise celles du ticket source. Si aucune URL → n'invente pas, omets la ligne.\n" +
  "6. Noms de champs, boutons, composants → exactement ceux décrits dans le ticket source.\n" +
  "7. Ne complète JAMAIS un contenu manquant par supposition ou invention.\n\n";

// ── SYSTEM PROMPT — RÈGLES QA SAFRAN ─────────────────────────────────────────
const SYSTEM_QA = `Tu es un QA Senior et expert en automatisation pour Safran Group.

Projet Jira : SAFWBST (Safran - Website)
Environnements : Sophie (staging), Paulo (staging2), Prod (www.safran-group.com)
Date du jour : ${new Date().toLocaleDateString("fr-FR")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOMENCLATURE STRICTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• US   : "User Story - [EPIC] - Titre de l'US"
• TEST : "TEST - [Titre de l'US] - Fonction à tester"
         ex: "TEST - [Validation des paramètres de dates] - Dates invalides rejetées"
• BUG  : "BUG - [Titre de l'US si liée] - Fonction à corriger"
         ex: "BUG - [Validation des paramètres de dates] - Validation dates absente"
         ex: "BUG - [API Drupal] - Validation dates absente" (si pas d'US liée)

Séparateur TOUJOURS : " - " (espace-tiret-espace)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPLATE USER STORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# User Story - [EPIC] - Titre

## 📋 RÉSUMÉ
User Story - [EPIC] - Titre

## 📖 DESCRIPTION
En tant que [rôle]
Je veux [fonctionnalité]
Afin de [bénéfice]

## 🧪 TYPE DE TEST
[Smoke Test / Validation / Régression / Sécurité / Performance / Visuel]

## ✅ CRITÈRES D'ACCEPTATION
(Format Gherkin strict, min 2 max 6)

### AC1 : [Nom du critère]
Étant donné [contexte]
Lorsque [action]
Alors [résultat]
Et [condition supplémentaire] (optionnel)

## 📊 COUVERTURE DES TESTS
### Endpoints couverts : [X] (si API)
### Nombre de tests : [X]
### Types : E2E / API / Drupal BO / CSS / Mix
### Périmètre : [Description]

## 📎 INFORMATIONS JIRA
**Espace :** Safran - Website (SAFWBST)
**Type :** Story | **État :** Backlog
**Epic :** [EPIC] | **Priorité :** [Critique/Haute/Moyenne/Basse]
**Créé le :** [Date]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPLATE TEST TICKET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST - [Titre de l'US] - Fonction à tester

## 📋 RÉSUMÉ
TEST - [Titre de l'US] - Fonction à tester

## 📖 DESCRIPTION
### Objectif
Vérifier que [fonction] fonctionne selon les AC de [US-XXX].

## 📝 CAS DE TEST
### Action
Étant donné [contexte]
Lorsque [action]
Alors [résultat]

### Données
• [Donnée] : [Valeur]

### Résultat Attendu
• [Critère 1]
• [Critère 2]
• Pas d'erreur serveur 5xx

## 🧪 PROCÉDURE
### Étape 1 : Préparation
### Étape 2 : Exécution
### Étape 3 : Validation
### Étape 4 : Nettoyage

## ✅ CRITÈRES DE SUCCÈS
- [ ] [Critère mesurable 1]
- [ ] [Critère mesurable 2]
- [ ] Aucune erreur console
- [ ] Aucune erreur serveur 5xx

## 🐛 EN CAS D'ÉCHEC
Créer : BUG - [CléUS] - [Fonction à corriger]
Lier le BUG à l'US source.

## 📎 INFORMATIONS JIRA
**Espace :** SAFWBST | **Type :** Test | **État :** Backlog
**US liée :** [US-XXX] | **Priorité :** [Critique/Haute/Moyenne/Basse]
**Créé le :** [Date]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPLATE BUG TICKET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# BUG - [Titre de l'US ou EPIC] - Fonction à corriger

## 📋 RÉSUMÉ
BUG - [Titre de l'US ou EPIC] - Fonction à corriger

## 📖 DESCRIPTION
### Étapes de reproduction (numérotées)
1. [Action]
2. [Action]
3. Observer le résultat

### Résultat attendu
[Comportement correct]

### Résultat obtenu
[Comportement bugué]

## 🔥 IMPACT
**Sévérité :** Critique / Majeure / Mineure / Triviale
**Priorité :** P0 (<24h) / P1 (<1 semaine) / P2 (<2 sem) / P3 (backlog)
**Utilisateurs affectés :** Tous / Certains / Rares
**Fonctionnalités impactées :** [Liste]

## 🔍 ANALYSE TECHNIQUE (si disponible)
### Cause probable : [Hypothèse]
### Logs : [Si disponibles]

## ✅ TESTS DE VALIDATION (après correction)
- [ ] Bug corrigé
- [ ] Aucune régression
- [ ] Validation QA OK

## 📎 PIÈCES JOINTES
- Screenshots Playwright
- Logs console

## 📎 INFORMATIONS JIRA
**Espace :** SAFWBST | **Type :** Bug | **État :** Backlog
**US liée :** [US-XXX] | **Test lié :** [TEST-XXX]
**Sévérité :** [X] | **Priorité :** [P0/P1/P2/P3]
**Créé le :** [Date]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMAT CSV CAS DE TEST (3 colonnes strictes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Encodage : UTF-8
Header   : Action,Données,Résultat Attendu
Règles   :
• Chaque cellule entre guillemets doubles
• Action    : "Étant donné [X]\nLorsque [Y]\nAlors [Z]"
• Données   : "• Clé : Valeur\n• Clé2 : Valeur2" (ou Header/Endpoint/Query)
• Résultat  : "• Critère 1\n• Critère 2\n• Pas d'erreur serveur 5xx"
• Min 2 critères, max 6, toujours terminer par contrôle erreur

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TYPES D'AUTOMATISATION PLAYWRIGHT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• manual  : complexité métier élevée, exploratoire, jugement humain requis
• e2e     : parcours utilisateur, formulaires, navigation, rendu DOM
• api     : endpoints REST, validation HTTP, codes retour, payloads
• drupal  : création/édition de contenu dans le BO Drupal (32 types de contenu)
• css     : audit visuel cross-browser, régressions screenshots
• mix     : combinaison de plusieurs types (préciser lesquels)`;

// ── HELPER : pause async ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── HELPER : appel LLM API (avec retry backoff sur 429, fallback Ollama) ─────
async function ask(userPrompt, model, systemOverride) {
  var hasCredits = !!CFG.anthropic.apiKey;

  // Tenter Anthropic API en premier (3 essais max sur rate-limit)
  if (hasCredits) {
    var MAX_RETRY = 3;
    for (var attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        var response = await client.messages.create({
          model:      model || MODEL_QUALITY,
          max_tokens: 4096,
          system:     systemOverride || SYSTEM_QA,
          messages:   [{ role: "user", content: userPrompt }]
        });
        return response.content[0].text;
      } catch(e) {
        if (e.status === 429) {
          // Rate limit → attendre et retenter (backoff exponentiel : 5s, 15s, 30s)
          var wait = [5000, 15000, 30000][attempt - 1] || 30000;
          console.warn("[LeadQA] Rate limit 429 — tentative " + attempt + "/" + MAX_RETRY + " — attente " + (wait/1000) + "s");
          if (attempt < MAX_RETRY) { await sleep(wait); continue; }
          console.warn("[LeadQA] Rate limit persistant → fallback Ollama");
          break;
        }
        if (e.status === 400 || e.status === 402) {
          console.warn("[LeadQA] Anthropic API indisponible (" + e.status + ") → fallback Ollama");
          break;
        }
        throw e;
      }
    }
  }

  // Fallback Ollama local
  return await askOllama(userPrompt, systemOverride || SYSTEM_QA);
}

// Appel Ollama local (fallback)
function askOllama(userPrompt, system) {
  return new Promise(function(resolve, reject) {
    var http    = require("http");
    var payload = JSON.stringify({
      model:    CFG.ollama.model,
      messages: [
        { role: "system",  content: system || SYSTEM_QA },
        { role: "user",    content: userPrompt }
      ],
      stream:  false,
      options: { temperature: 0.2 }
    });
    var req = http.request({
      hostname: CFG.ollama.host,
      port:     CFG.ollama.port,
      path:     "/api/chat",
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try {
          var parsed = JSON.parse(data);
          resolve((parsed.message && parsed.message.content) || data);
        } catch(e) { resolve(data); }
      });
    });
    req.on("error", function(e) {
      reject(new Error("LLM indisponible. Ajoute des crédits sur console.anthropic.com ou lance Ollama avec un modèle léger (ex: ollama pull phi3:mini)"));
    });
    req.setTimeout(120000, function() {
      req.destroy();
      reject(new Error("LLM timeout (120s)"));
    });
    req.write(payload);
    req.end();
  });
}

// Appel avec retour JSON structuré
async function askJSON(userPrompt, model) {
  var text = await ask(
    userPrompt + "\n\nRéponds UNIQUEMENT avec un objet JSON valide. Pas de markdown, pas d'explication.",
    model || MODEL_FAST
  );
  // Nettoyer les éventuels blocs markdown
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(text);
}

// ── 1. ANALYSER UNE US ────────────────────────────────────────────────────────
// Lit un ticket Jira US et retourne une stratégie QA complète
async function analyzeUS(ticket) {
  var key     = ticket.key || "?";
  var summary = (ticket.fields && ticket.fields.summary) || ticket.summary || "";
  var desc    = extractText((ticket.fields && ticket.fields.description) || ticket.description);
  var epic    = extractEpic(ticket);

  var prompt =
    "Analyse cette User Story Jira et fournis une stratégie QA.\n\n" +
    "Clé    : " + key + "\n" +
    "Résumé : " + summary + "\n" +
    "Epic   : " + epic + "\n" +
    "Description : " + desc.substring(0, 800) + "\n\n" +
    "Retourne un JSON avec ces champs :\n" +
    "{\n" +
    '  "key": "' + key + '",\n' +
    '  "epic": "' + epic + '",\n' +
    '  "summary": "' + summary.replace(/"/g, "'") + '",\n' +
    '  "complexity": "faible|moyenne|élevée",\n' +
    '  "automationType": "manual|e2e|api|drupal|css|mix",\n' +
    '  "automationTypes": ["e2e"],\n' +
    '  "reasoning": "Justification courte en 2 phrases",\n' +
    '  "testCount": 3,\n' +
    '  "priority": "Critique|Haute|Moyenne|Basse",\n' +
    '  "risks": ["Risque 1"],\n' +
    '  "missingElements": ["ac", "persona"]\n' +
    "}";

  return await askJSON(prompt, MODEL_FAST);
}

// ── 2. ENRICHIR UNE US DU BACKLOG ────────────────────────────────────────────
// Améliore une US existante et retourne le markdown complet
async function enrichUS(ticket) {
  var key     = ticket.key || "?";
  var summary = (ticket.fields && ticket.fields.summary) || ticket.summary || "";
  var desc    = extractText((ticket.fields && ticket.fields.description) || ticket.description);
  var epic    = extractEpic(ticket);

  var prompt =
    ANTI_HALLU +
    "Tu enrichis cette User Story. Retourne un JSON structuré (pas de markdown).\n\n" +
    "=== TICKET SOURCE ===\n" +
    "Clé : " + key + "\n" +
    "Résumé : " + summary + "\n" +
    "Description actuelle : " + (desc || "(vide)") + "\n" +
    "=== FIN TICKET SOURCE ===\n\n" +
    "RETOURNE EXACTEMENT ce JSON :\n" +
    "{\n" +
    '  "persona": "le persona déduit du ticket",\n' +
    '  "objectif": "ce que le persona veut faire",\n' +
    '  "benefice": "le bénéfice métier",\n' +
    '  "testType": "E2E|API|Manuel|Drupal BO|Mix — BO + E2E (déduit du contenu)",\n' +
    '  "acs": [\n' +
    '    { "title": "Titre court AC1", "given": "contexte", "when": "action", "then": "résultat" },\n' +
    '    { "title": "Titre court AC2", "given": "contexte", "when": "action", "then": "résultat" }\n' +
    "  ]\n" +
    "}\n\n" +
    "RÈGLES :\n" +
    "- 3 à 8 ACs, chacun avec un seul comportement observable\n" +
    "- Gherkin strict : given/when/then basés sur le ticket source\n" +
    "- testType déduit : Drupal BO si mentions BO/contenu, API si mentions API/REST, E2E si front/page/URL\n" +
    "- Si une info manque, omets le champ — JAMAIS de [À préciser]\n" +
    "- PAS de métadonnées Jira, PAS de markdown, PAS d'emojis";

  var enriched = await askJSON(prompt, MODEL_QUALITY);
  // Sauvegarder aussi le markdown pour compatibilité
  var markdown = formatEnrichedMarkdown(enriched, summary);
  return { key: key, summary: summary, epic: epic, markdown: markdown, structured: enriched };
}

// Formater le JSON enrichi en markdown (pour sauvegarde locale lisible)
function formatEnrichedMarkdown(enriched, summary) {
  if (!enriched) return summary || "";
  var lines = [];
  if (enriched.persona && enriched.objectif) {
    lines.push("En tant que " + enriched.persona + ", je veux " + enriched.objectif +
      (enriched.benefice ? ", afin de " + enriched.benefice : "") + ".");
  }
  if (enriched.testType) lines.push("\nType de test : " + enriched.testType);
  if (enriched.acs && enriched.acs.length) {
    lines.push("\nCritères d'acceptation :");
    enriched.acs.forEach(function(ac, i) {
      lines.push("AC" + (i + 1) + " : " + (ac.title || ""));
      lines.push("  Étant donné " + (ac.given || ""));
      lines.push("  Lorsque " + (ac.when || ""));
      lines.push("  Alors " + (ac.then || ""));
    });
  }
  return lines.join("\n");
}

// Construire le document ADF avec accordéons pour chaque AC
function buildADFDescription(enriched) {
  if (!enriched || !enriched.persona) {
    // Fallback texte simple si le JSON est invalide
    return {
      type: "doc", version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: JSON.stringify(enriched || {}) }] }]
    };
  }

  var content = [];

  // Heading DESCRIPTION
  content.push({
    type: "heading", attrs: { level: 3 },
    content: [{ type: "text", text: "DESCRIPTION" }]
  });

  // User Story statement
  var usText = "En tant que " + enriched.persona +
    "\nJe veux " + enriched.objectif +
    (enriched.benefice ? "\nAfin de " + enriched.benefice : "");
  content.push({
    type: "paragraph",
    content: [{ type: "text", text: usText }]
  });

  // Séparateur
  content.push({ type: "rule" });

  // Type de test
  if (enriched.testType) {
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: "TYPE DE TEST\n" + enriched.testType }]
    });
    content.push({ type: "rule" });
  }

  // Heading AC
  content.push({
    type: "heading", attrs: { level: 3 },
    content: [{ type: "text", text: "CRITÈRES D'ACCEPTATION" }]
  });

  // Accordéons AC (expand nodes)
  var acs = enriched.acs || [];
  acs.forEach(function(ac, i) {
    var title = "AC" + (i + 1) + " : " + (ac.title || "Critère " + (i + 1));
    var gherkin = "Étant donné " + (ac.given || "...") +
      "\nLorsque " + (ac.when || "...") +
      "\nAlors " + (ac.then || "...");
    content.push({
      type: "expand",
      attrs: { title: title },
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: gherkin }]
      }]
    });
  });

  return { type: "doc", version: 1, content: content };
}

// ── 3. REVUE D'UNE US — QUALITÉ ─────────────────────────────────────────────
// Score et liste les éléments manquants
async function reviewUS(ticket) {
  var key     = ticket.key || "?";
  var summary = (ticket.fields && ticket.fields.summary) || ticket.summary || "";
  var desc    = extractText((ticket.fields && ticket.fields.description) || ticket.description);

  var prompt =
    "Évalue la qualité de cette User Story selon nos standards QA Safran.\n\n" +
    "Clé     : " + key + "\n" +
    "Résumé  : " + summary + "\n" +
    "Description : " + desc.substring(0, 800) + "\n\n" +
    "Retourne un JSON :\n" +
    "{\n" +
    '  "score": 65,\n' +
    '  "isReadyForTest": false,\n' +
    '  "missingElements": ["ac", "persona", "goal"],\n' +
    '  "issues": ["AC manquants", "Persona non défini"],\n' +
    '  "suggestions": ["Ajouter le persona", "Définir 2 AC Gherkin"]\n' +
    "}";

  return await askJSON(prompt, MODEL_FAST);
}

// ── 4. DÉCIDER LA STRATÉGIE DE TEST ─────────────────────────────────────────
// Retourne le type d'automatisation et le mode Playwright
async function decideStrategy(ticket) {
  var summary = (ticket.fields && ticket.fields.summary) || ticket.summary || "";
  var desc    = extractText((ticket.fields && ticket.fields.description) || ticket.description);

  var prompt =
    "En tant que QA Senior, décide la stratégie de test optimale pour ce ticket.\n\n" +
    "Ticket  : " + (ticket.key || "") + "\n" +
    "Résumé  : " + summary + "\n" +
    "Description : " + desc.substring(0, 600) + "\n\n" +
    "Choix :\n" +
    "• manual  → complexité métier, exploration, jugement humain\n" +
    "• e2e     → parcours utilisateur, formulaires, navigation DOM\n" +
    "• api     → REST, HTTP, payloads, codes retour\n" +
    "• drupal  → création/édition contenu BO Drupal (32 types)\n" +
    "• css     → audit visuel, cross-browser, régressions\n" +
    "• mix     → plusieurs types nécessaires\n\n" +
    "Retourne un JSON :\n" +
    "{\n" +
    '  "decision": "e2e|api|drupal|css|manual|mix",\n' +
    '  "types": ["e2e", "api"],\n' +
    '  "confidence": 85,\n' +
    '  "reasoning": "Justification courte (2 phrases max)",\n' +
    '  "playwrightMode": "ui|api|drupal|css-audit|null"\n' +
    "}";

  return await askJSON(prompt, MODEL_FAST);
}

// ── 5. GÉNÉRER UN TICKET TEST ─────────────────────────────────────────────────
async function generateTestTicket(us, testType, fonction) {
  var usKey   = us.key || "SAFWBST-?";
  var epic    = us.epic || extractEpic(us);
  var summary = us.summary || "";
  var desc    = us.description || extractText((us.fields && us.fields.description) || "");
  var fn      = fonction || summary;
  var title   = safeTruncate("TEST - [" + summary + "] - " + fn, 200);

  var prompt =
    ANTI_HALLU +
    "Génère un ticket TEST complet et actionnable à partir du ticket source ci-dessous.\n\n" +
    "=== TICKET SOURCE ===\n" +
    "Clé             : " + usKey + "\n" +
    "Epic            : " + epic + "\n" +
    "Résumé          : " + summary + "\n" +
    "Type de test    : " + (testType || "mixte") + "\n" +
    "Fonction testée : " + fn + "\n" +
    "Description complète :\n" + desc.substring(0, 2000) + "\n" +
    "=== FIN TICKET SOURCE ===\n\n" +
    "Titre exact du ticket : \"" + title + "\"\n\n" +
    "IMPORTANT : Réutilise les URLs, AC Gherkin, valeurs de test et noms de champs présents dans le ticket source.\n" +
    "Génère le ticket TEST au format Markdown complet selon le template.\n" +
    "Date : " + new Date().toLocaleDateString("fr-FR");

  var markdown = await ask(prompt, MODEL_QUALITY);
  return { title: title, usKey: usKey, epic: epic, testType: testType, markdown: markdown };
}

// ── 5b. VUE INTERNE — contenu complet pour AbyQA (jamais envoyé à Jira) ──────
function buildInternalView(testResult, sourceTicket) {
  var source = sourceTicket || {};
  var sourceKey  = source.key || "?";
  var sourceSummary = source.summary || (source.fields && source.fields.summary) || "";
  var sourceDesc = source.description || extractText((source.fields && source.fields.description) || "");

  var view = {
    title:      testResult.title,
    sourceKey:  sourceKey,
    sourceSummary: sourceSummary,
    epic:       testResult.epic || extractEpic(source),
    testType:   testResult.testType || "Mix",
    methodology: testResult.markdown,     // Contenu complet généré par l'IA
    sourceDescription: sourceDesc,
    createdAt:  new Date().toISOString()
  };

  // Sauvegarder dans inbox/internal/
  var internalDir = path.join(CFG.paths.base || __dirname, "inbox", "internal");
  if (!fs.existsSync(internalDir)) fs.mkdirSync(internalDir, { recursive: true });
  var filename = sourceKey + "-TEST-" + Date.now() + ".json";
  fs.writeFileSync(path.join(internalDir, filename), JSON.stringify(view, null, 2), "utf8");
  console.log("[LeadQA] Vue interne sauvegardée : " + filename);

  return view;
}

// ── 5c. VUE EXTERNE — payload minimal pour Jira (ADF strict) ────────────────
function buildExternalJiraPayload(testResult, sourceTicket, opts) {
  opts = opts || {};
  var source = sourceTicket || {};
  var sourceKey  = source.key || "?";
  var sourceSummary = source.summary || (source.fields && source.fields.summary) || "";
  var epic       = testResult.epic || extractEpic(source);

  // Titre strict : TEST - [Epic] - Fonction testée (200 chars max, coupure au mot)
  var title = safeTruncate("TEST - [" + epic + "] - " + (testResult.testType === "manual" ? "Validation " : "") + sourceSummary, 200);

  // Type de test normalisé (3 valeurs uniquement)
  var rawType = (testResult.testType || "mix").toLowerCase();
  var testTypeLabel;
  if (rawType === "manual" || rawType === "manuel") testTypeLabel = "Manuel";
  else if (rawType === "e2e" || rawType === "auto" || rawType === "api" || rawType === "css") testTypeLabel = "Auto";
  else testTypeLabel = "Mix";

  // Objectif fonctionnel (2-3 lignes max, basé sur le ticket source)
  var objectif = "Vérifier que la fonction « " + sourceSummary + " » fonctionne correctement selon les critères d'acceptation de " + sourceKey + ".";

  // Description ADF minimale et propre
  var adfContent = [];

  // Objectif
  adfContent.push({
    type: "paragraph",
    content: [{ type: "text", text: objectif }]
  });

  // Séparateur
  adfContent.push({ type: "rule" });

  // Type de test
  adfContent.push({
    type: "paragraph",
    content: [
      { type: "text", text: "Type de test : ", marks: [{ type: "strong" }] },
      { type: "text", text: testTypeLabel }
    ]
  });

  var description = { type: "doc", version: 1, content: adfContent };

  // Labels : version courante uniquement
  var labels = [];
  if (opts.version) labels.push(opts.version);

  // Payload Jira complet
  var fields = {
    project:   { key: CFG.jira.project },
    summary:   title,
    issuetype: { name: "Test" },
    description: description,
    labels: labels
  };

  // Priority
  if (opts.priority) {
    fields.priority = { name: opts.priority };
  }

  return { fields: fields, title: title, testType: testTypeLabel };
}

// ── 5d. VALIDATION — scanner le payload avant envoi Jira ─────────────────────
var FORBIDDEN_PATTERNS = [
  "[À préciser]", "[URL à préciser]", "[à préciser]",
  "[À compléter]", "[à compléter]",
  "## ", "### ",
  "RÉSUMÉ", "INFORMATIONS JIRA",
  "CAS DE TEST", "PROCÉDURE", "EN CAS D'ÉCHEC",
  "AbyQA", "Aby QA", "aby-qa",
  "Claude", "QA Automation", "Lead QA",
  "📋", "📎", "📝", "🧪", "🐛", "🤖"
];

function validateJiraPayload(payload) {
  var payloadStr = JSON.stringify(payload);
  var violations = [];
  FORBIDDEN_PATTERNS.forEach(function(pattern) {
    if (payloadStr.includes(pattern)) {
      violations.push(pattern);
    }
  });
  if (violations.length > 0) {
    console.error("[BLOQUÉ] Contenu interdit détecté dans le payload Jira : " + violations.join(", "));
    return { valid: false, violations: violations };
  }
  return { valid: true, violations: [] };
}

// ── 5e. GÉNÉRER LES STEPS XRAY — format 3 colonnes strict ───────────────────
async function buildXraySteps(sourceTicket) {
  var source = sourceTicket || {};
  var key     = source.key || "?";
  var summary = source.summary || (source.fields && source.fields.summary) || "";
  var desc    = source.description || extractText((source.fields && source.fields.description) || "");

  var prompt =
    ANTI_HALLU +
    "Génère les cas de test Xray au format 3 colonnes strict pour ce ticket.\n\n" +
    "=== TICKET SOURCE ===\n" +
    "Clé     : " + key + "\n" +
    "Résumé  : " + summary + "\n" +
    "Description :\n" + desc.substring(0, 2000) + "\n" +
    "=== FIN TICKET SOURCE ===\n\n" +
    "FORMAT STRICT — chaque cas de test est un objet JSON avec 3 champs :\n\n" +
    "1. action (Gherkin strict) :\n" +
    "   \"Étant donné [contexte extrait du ticket]\\nLorsque [action précise]\\nAlors [résultat observable]\"\n" +
    "   - 1 seul comportement par cas de test\n" +
    "   - Infos concrètes extraites du ticket source\n\n" +
    "2. data :\n" +
    "   \"• URL : [URL concrète du ticket]\\n• Device : Desktop 1920x1080\\n• [Autres données]\"\n" +
    "   - URLs extraites du ticket source, pas de placeholder\n" +
    "   - Si une info manque, écrire \"À confirmer : [raison]\"\n" +
    "   - Environnement par défaut : Sophie\n\n" +
    "3. result :\n" +
    "   \"• [Vérification mesurable 1]\\n• [Vérification mesurable 2]\\n• Aucune erreur HTTP 5xx\"\n" +
    "   - Chaque puce = 1 vérification observable\n" +
    "   - Formulé de façon mesurable et vérifiable\n\n" +
    "4. mode (obligatoire) :\n" +
    "   \"auto\" = Playwright peut l'exécuter (navigation, clic, vérif DOM, responsive, texte visible, HTTP status)\n" +
    "   \"manuel\" = vérification humaine nécessaire (rendu visuel subjectif, UX, contenu rédactionnel, comparaison maquette, accessibilité perçue)\n" +
    "   Règle : si TOUTES les vérifications du result sont automatisables par Playwright → \"auto\", sinon → \"manuel\"\n\n" +
    "Génère 3 à 8 cas de test couvrant les scénarios principaux.\n" +
    "Retourne UNIQUEMENT un JSON array : [{\"action\":\"...\",\"data\":\"...\",\"result\":\"...\",\"mode\":\"auto|manuel\"}]";

  var steps = await askJSON(prompt, MODEL_QUALITY);
  if (!Array.isArray(steps)) {
    console.error("[LeadQA] buildXraySteps — réponse invalide (pas un array)");
    return [];
  }

  // Normaliser et valider chaque step
  var validated = [];
  var warnings = [];
  steps.forEach(function(s, i) {
    var action = (s.action || "").trim();
    var data   = (s.data || "").trim();
    var result = (s.result || s.expectedResult || "").trim();
    if (!action) return; // ignorer les steps vides

    // Vérifier les placeholders interdits
    [action, data, result].forEach(function(field, fi) {
      var fieldName = ["action", "data", "result"][fi];
      if (/\[À préciser\]|\[URL à préciser\]|\[à compléter\]/i.test(field)) {
        warnings.push("Step " + (i + 1) + " — " + fieldName + " contient un placeholder interdit");
      }
    });

    var mode = (s.mode || "").trim().toLowerCase();
    if (mode !== "auto" && mode !== "manuel") mode = "manuel";
    validated.push({ action: action, data: data, result: result, mode: mode });
  });

  if (warnings.length > 0) {
    warnings.forEach(function(w) { console.warn("[LeadQA] " + w); });
  }

  console.log("[LeadQA] buildXraySteps — " + validated.length + " cas de test générés" +
    (warnings.length > 0 ? " (" + warnings.length + " warning(s))" : ""));
  return validated;
}

// ── 6. GÉNÉRER DES CAS DE TEST CSV ───────────────────────────────────────────
async function generateTestCasesCSV(us, count) {
  var usKey   = us.key || "SAFWBST-?";
  var summary = us.summary || "";
  var desc    = us.description || extractText((us.fields && us.fields.description) || "");
  var type    = us.automationType || "mixte";

  var prompt =
    ANTI_HALLU +
    "Génère " + (count || 5) + " cas de test au format CSV strict.\n\n" +
    "US      : " + usKey + " — " + summary + "\n" +
    "Type    : " + type + "\n" +
    "Contexte: " + desc.substring(0, 500) + "\n\n" +
    "Format CSV STRICT :\n" +
    "- Ligne 1 (header) : Action,Données,Résultat Attendu\n" +
    "- Chaque cellule entre guillemets doubles\n" +
    "- Colonne Action    : \"Étant donné [X]\\nLorsque [Y]\\nAlors [Z]\"\n" +
    "- Colonne Données   : \"• Clé : Valeur\\n• Clé2 : Valeur2\"\n" +
    "- Colonne Résultat  : \"• Critère 1\\n• Critère 2\\n• Pas d'erreur serveur 5xx\"\n\n" +
    "Génère UNIQUEMENT le CSV. Pas d'explication. Commence par la ligne header.";

  var csv = await ask(prompt, MODEL_QUALITY);
  // Nettoyer les éventuels blocs markdown
  csv = csv.replace(/^```csv\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  return csv;
}

// ── 6b. ANALYSE + REVUE + STRATEGIE FUSIONNEES (1 seul appel IA) ────────────
// Fusionne reviewUS + analyzeUS + decideStrategy en un seul prompt
async function analyzeAndReviewUS(ticket) {
  var key     = ticket.key || "?";
  var summary = (ticket.fields && ticket.fields.summary) || ticket.summary || "";
  var desc    = extractText((ticket.fields && ticket.fields.description) || ticket.description);
  var epic    = extractEpic(ticket);

  var prompt =
    "Analyse cette User Story Jira selon 3 axes en un seul JSON.\n\n" +
    "Cle    : " + key + "\n" +
    "Resume : " + summary + "\n" +
    "Epic   : " + epic + "\n" +
    "Description : " + desc.substring(0, 800) + "\n\n" +
    "Retourne un JSON UNIQUE avec ces champs :\n" +
    "{\n" +
    '  "key": "' + key + '",\n' +
    '  "epic": "' + epic + '",\n' +
    '  "summary": "' + summary.replace(/"/g, "'") + '",\n' +
    '  "review": {\n' +
    '    "score": 65,\n' +
    '    "isReadyForTest": false,\n' +
    '    "missingElements": ["ac", "persona"],\n' +
    '    "issues": ["AC manquants"],\n' +
    '    "suggestions": ["Ajouter 2 AC Gherkin"]\n' +
    '  },\n' +
    '  "analysis": {\n' +
    '    "complexity": "faible|moyenne|elevee",\n' +
    '    "testCount": 3,\n' +
    '    "priority": "Critique|Haute|Moyenne|Basse",\n' +
    '    "risks": ["Risque 1"]\n' +
    '  },\n' +
    '  "strategy": {\n' +
    '    "decision": "e2e|api|drupal|css|manual|mix",\n' +
    '    "types": ["e2e"],\n' +
    '    "confidence": 85,\n' +
    '    "reasoning": "Justification courte (2 phrases max)",\n' +
    '    "playwrightMode": "ui|api|drupal|css-audit|null"\n' +
    '  }\n' +
    "}";

  return await askJSON(prompt, MODEL_FAST);
}

// ── 6c. GENERER TICKET TEST + CSV EN UN SEUL APPEL ──────────────────────────
// Fusionne generateTestTicket + generateTestCasesCSV en un seul prompt
async function generateTestAndCSV(us, testType, fonction, csvCount) {
  var usKey   = us.key || "SAFWBST-?";
  var epic    = us.epic || extractEpic(us);
  var summary = us.summary || "";
  var desc    = us.description || extractText((us.fields && us.fields.description) || "");
  var fn      = fonction || summary;
  var title   = safeTruncate("TEST - [" + summary + "] - " + fn, 200);
  var count   = csvCount || 5;

  var prompt =
    ANTI_HALLU +
    "Genere un ticket TEST complet + ses cas de test CSV en une seule reponse.\n\n" +
    "=== TICKET SOURCE ===\n" +
    "US de reference : " + usKey + "\n" +
    "Epic            : " + epic + "\n" +
    "Resume US       : " + summary + "\n" +
    "Type de test    : " + (testType || "mixte") + "\n" +
    "Fonction testee : " + fn + "\n" +
    "Description complete :\n" + desc.substring(0, 2000) + "\n" +
    "=== FIN TICKET SOURCE ===\n\n" +
    "IMPORTANT : Reutilise les URLs, AC Gherkin, valeurs de test et noms de champs presents dans le ticket source.\n\n" +
    "Titre exact du ticket : \"" + title + "\"\n" +
    "Date : " + new Date().toLocaleDateString("fr-FR") + "\n\n" +
    "REPONDS EN 2 SECTIONS SEPAREES PAR LA LIGNE : ---CSV-SEPARATOR---\n\n" +
    "SECTION 1 — Ticket TEST complet en Markdown selon le template.\n\n" +
    "SECTION 2 — " + count + " cas de test au format CSV strict :\n" +
    "- Ligne 1 (header) : Action,Donnees,Resultat Attendu\n" +
    "- Chaque cellule entre guillemets doubles\n" +
    "- Colonne Action    : \"Etant donne [X]\\nLorsque [Y]\\nAlors [Z]\"\n" +
    "- Colonne Donnees   : \"• Cle : Valeur\\n• Cle2 : Valeur2\"\n" +
    "- Colonne Resultat  : \"• Critere 1\\n• Critere 2\\n• Pas d'erreur serveur 5xx\"";

  var raw = await ask(prompt, MODEL_QUALITY);

  // Separer les deux sections
  var parts = raw.split(/---CSV-SEPARATOR---/i);
  var markdown = (parts[0] || "").trim();
  var csv = (parts[1] || "").trim();
  // Nettoyer les eventuels blocs markdown du CSV
  csv = csv.replace(/^```csv\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  return {
    title: title, usKey: usKey, epic: epic, testType: testType,
    markdown: markdown, csv: csv
  };
}

// ── 7. GÉNÉRER UN TICKET BUG ─────────────────────────────────────────────────
// opts: { sourceUS, epic, page, description, steps, expected, actual, severity, evidence }
async function generateBugTicket(opts) {
  var usKey    = opts.sourceUS || null;
  var usSummary = opts.usSummary || null;
  var epic     = opts.epic || "SAFWBST";
  // Référence : titre de l'US si disponible, sinon l'epic
  var ref      = usSummary || epic;
  var fonction = opts.fonction || opts.page || "Comportement anormal";
  var title    = safeTruncate("BUG - [" + ref + "] - " + fonction, 200);

  var prompt =
    ANTI_HALLU +
    "Génère un ticket BUG complet, précis et actionnable.\n\n" +
    "Titre           : \"" + title + "\"\n" +
    "US source       : " + (usKey || "Aucune") + (usSummary ? " — " + usSummary : "") + "\n" +
    "Page/Fonction   : " + (opts.page || fonction) + "\n" +
    "Description     : " + (opts.description || "Comportement anormal observé") + "\n" +
    "Étapes          : " + (opts.steps || "À documenter via Playwright") + "\n" +
    "Résultat obtenu : " + (opts.actual || "Comportement inattendu") + "\n" +
    "Résultat attendu: " + (opts.expected || "Comportement correct") + "\n" +
    "Sévérité        : " + (opts.severity || "À évaluer") + "\n" +
    "Preuves         : " + (opts.evidence || "Screenshots Playwright disponibles") + "\n\n" +
    "Génère le ticket BUG au format Markdown complet selon le template.\n" +
    "Date : " + new Date().toLocaleDateString("fr-FR");

  var markdown = await ask(prompt, MODEL_QUALITY);
  return { title: title, usKey: usKey, epic: epic, fonction: fonction, markdown: markdown };
}

// ── 8. TRAITER UNE DEMANDE DIRECTE (chat) ────────────────────────────────────
// Pour le mode direct depuis le dashboard (texte libre + contexte)
async function handleDirectRequest(request, context) {
  var prompt =
    "L'utilisateur a une demande QA directe. Analyse-la et réponds de manière actionnable.\n\n" +
    "Demande : " + request + "\n" +
    (context ? "Contexte : " + context + "\n" : "") + "\n" +
    "Si la demande implique de générer un ticket (US/TEST/BUG) ou un CSV, génère-le directement.\n" +
    "Si la demande implique de lancer Playwright, décris les étapes et le type de test.\n" +
    "Réponds en français, de manière concise et professionnelle.";

  return await ask(prompt, MODEL_QUALITY);
}

// ── 9. GÉNÉRER UN RAPPORT QA ─────────────────────────────────────────────────
async function generateReport(results) {
  var prompt =
    "Génère un rapport QA / notes de livraison.\n\n" +
    "Version  : " + (results.version || "N/A") + "\n" +
    "Sprint   : " + (results.sprint || "N/A") + "\n" +
    "Tickets  : " + JSON.stringify(results.tickets || [], null, 2) + "\n\n" +
    "Fournis un rapport Markdown avec :\n" +
    "1. Résumé exécutif (KPIs : tickets testés, taux réussite, bugs ouverts)\n" +
    "2. Détail par ticket\n" +
    "3. Risques identifiés\n" +
    "4. Recommandations avant MEP\n" +
    "5. Date : " + new Date().toLocaleDateString("fr-FR");

  return await ask(prompt, MODEL_QUALITY);
}

// ── HELPERS INTERNES ──────────────────────────────────────────────────────────

// Extrait le texte d'un champ Jira (ADF ou string)
function extractText(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  var texts = [];
  function walk(node) {
    if (!node) return;
    if (node.type === "text" && node.text) texts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(adf);
  return texts.join(" ").trim();
}

// Extrait l'epic d'un ticket Jira
function extractEpic(ticket) {
  if (!ticket) return "SAFWBST";
  var f = ticket.fields || {};
  // Champs Jira courants pour l'epic
  var epic = f.customfield_10014 || f.customfield_10008 || f["Epic Name"] || "";
  if (!epic && f.labels && f.labels.length) {
    // Chercher un label qui ressemble à un nom d'epic (pas une version, pas un tag auto)
    epic = f.labels.find(function(l) {
      return l && !l.match(/^v\d/) && !l.match(/aby-qa|auto-generated/i);
    }) || "";
  }
  return epic || "SAFWBST";
}

// ── TRONCATURE TITRE SAFE ────────────────────────────────────────────────────
function safeTruncate(str, max) {
  if (!str || str.length <= max) return str || "";
  var truncated = str.substring(0, max);
  // Ne pas couper en milieu de mot
  var lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > max * 0.6) truncated = truncated.substring(0, lastSpace);
  return truncated.trim() + "...";
}

// ── SAUVEGARDE FICHIERS ────────────────────────────────────────────────────────

function saveMarkdown(content, type, name) {
  CFG.paths.init();
  var safe     = (name || "output").replace(/[<>:"/\\|?* àâäéèêëîïôùûüç]/gi, function(c) {
    var map = { à:"a",â:"a",ä:"a",é:"e",è:"e",ê:"e",ë:"e",î:"i",ï:"i",ô:"o",ù:"u",û:"u",ü:"u",ç:"c" };
    return map[c] || "-";
  }).replace(/-+/g, "-").replace(/^-|-$/g, "");
  var filename = type.toUpperCase() + "-" + safe + "-" + Date.now() + ".md";
  var filepath = path.join(CFG.paths.reports, filename);
  fs.writeFileSync(filepath, content, "utf8");
  console.log("[LeadQA] Fichier créé : " + filepath);
  return filepath;
}

function saveCSV(content, name) {
  CFG.paths.init();
  var safe     = (name || "cas-test").replace(/[<>:"/\\|?* ]/g, "-").replace(/-+/g, "-");
  var filename = "CAS_TEST-" + safe + "-" + Date.now() + ".csv";
  var filepath = path.join(CFG.paths.reports, filename);
  // BOM UTF-8 pour Excel
  fs.writeFileSync(filepath, "\uFEFF" + content, "utf8");
  console.log("[LeadQA] CSV créé : " + filepath);
  return filepath;
}

// ── TEST AUTONOME (si lancé directement) ─────────────────────────────────────
if (require.main === module) {
  (async function() {
    console.log("══════════════════════════════════════════════");
    console.log("  QA Agent");
    console.log("══════════════════════════════════════════════");

    // Test rapide avec un ticket fictif
    var testTicket = {
      key: "SAFWBST-999",
      fields: {
        summary: "Validation des paramètres de dates sur l'API Drupal",
        description: "L'API doit valider le format des dates avant traitement et retourner une erreur 400 si le format est invalide.",
        status: { name: "Backlog" },
        labels: ["API-Drupal"]
      }
    };

    try {
      console.log("\n[1] Test analyzeUS...");
      var analysis = await analyzeUS(testTicket);
      console.log("    → automationType:", analysis.automationType);
      console.log("    → priority:", analysis.priority);
      console.log("    → reasoning:", analysis.reasoning);

      console.log("\n[2] Test decideStrategy...");
      var strategy = await decideStrategy(testTicket);
      console.log("    → decision:", strategy.decision);
      console.log("    → confidence:", strategy.confidence + "%");

      console.log("\n[3] Test enrichUS...");
      var enriched = await enrichUS(testTicket);
      var filepath = saveMarkdown(enriched.markdown, "US", testTicket.key + "-enrichi");
      console.log("    → Fichier:", filepath);

      console.log("\n✅ Tous les tests passent — agent-lead-qa.js opérationnel !");
    } catch(e) {
      console.error("\n❌ Erreur :", e.message);
      if (e.status) console.error("   Status HTTP:", e.status);
    }
  })();
}

// ── ANALYSE IMAGE (Vision API) ───────────────────────────────────────────────
// Analyse un screenshot ou toute image pour en extraire un contexte QA
async function analyzeImage(base64Data, mimeType) {
  var mediaType = (mimeType || "image/png").replace("image/jpg", "image/jpeg");
  // Valider que c'est un type supporté par Vision API
  var supported = ["image/jpeg","image/png","image/gif","image/webp"];
  if (!supported.includes(mediaType)) mediaType = "image/png";

  var response = await client.messages.create({
    model: MODEL_FAST,
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mediaType, data: base64Data }
        },
        {
          type: "text",
          text: "Tu es un QA expert. Analyse cette capture d'écran dans un contexte de test logiciel.\n\n" +
                "Décris en français :\n" +
                "1. Les éléments d'interface visibles (formulaires, boutons, menus, messages)\n" +
                "2. Les erreurs ou anomalies visibles (messages d'erreur, éléments manquants, mise en page incorrecte)\n" +
                "3. Les éléments testables clés (IDs, classes CSS visibles, textes de labels)\n" +
                "4. Une suggestion de cas de test si une anomalie est détectée\n\n" +
                "Format : markdown structuré, concis (max 20 lignes)."
        }
      ]
    }]
  });
  return response.content[0].text;
}

// ── EXTRACTION HTML ────────────────────────────────────────────────────────────
// Extrait le texte et les sélecteurs CSS utiles d'un contenu HTML
function extractFromHTML(html) {
  // Supprimer scripts, styles, commentaires
  var clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extraire sélecteurs utiles depuis le HTML brut
  var selectors = [];
  var seen = new Set();

  // IDs
  var idMatches = html.match(/\bid="([^"]{1,60})"/g) || [];
  idMatches.slice(0, 8).forEach(function(m) {
    var id = m.match(/id="([^"]+)"/)[1];
    if (!seen.has("#" + id)) { selectors.push("#" + id); seen.add("#" + id); }
  });

  // data-cy / data-testid (sélecteurs de test)
  var dataMatches = html.match(/\bdata-(?:cy|testid|qa)="([^"]{1,60})"/g) || [];
  dataMatches.slice(0, 5).forEach(function(m) {
    var attr = m.split("=")[0].replace(/\s/g,"");
    var val  = m.match(/="([^"]+)"/)[1];
    if (!seen.has("[" + attr + '="' + val + '"]')) {
      selectors.push("[" + attr + '="' + val + '"]');
      seen.add("[" + attr + '="' + val + '"]');
    }
  });

  // Classes principales (boutons, formulaires)
  var btnMatches = html.match(/(?:class="[^"]*(?:btn|button|submit|form|nav|menu|modal|input)[^"]*")/gi) || [];
  btnMatches.slice(0, 5).forEach(function(m) {
    var cls = m.match(/class="([^"]+)"/);
    if (cls) {
      var first = cls[1].trim().split(/\s+/)[0];
      if (first && !seen.has("." + first)) { selectors.push("." + first); seen.add("." + first); }
    }
  });

  return {
    text:      clean.substring(0, 3000),
    selectors: selectors.join("\n")
  };
}

// ── AUTO-DEBUG — analyse une erreur d'agent et propose un correctif ──────────
async function analyzeAgentError(ctx) {
  var fileRef = ctx.fileInfo
    ? require("path").basename(ctx.fileInfo.file) + " ligne " + ctx.fileInfo.line
    : "fichier inconnu";

  var prompt =
    "Tu es un expert Node.js et développeur senior. Un agent QA a planté avec une erreur.\n\n" +
    "Agent : " + ctx.agentId + "\n" +
    "Fichier : " + fileRef + "\n\n" +
    "ERREURS :\n" + ctx.errorLines + "\n\n" +
    (ctx.codeContext ? "CODE AUTOUR DE L'ERREUR (avec numéros de ligne) :\n```js\n" + ctx.codeContext + "\n```\n\n" : "") +
    "LOGS COMPLETS :\n" + ctx.allLogs + "\n\n" +
    "Réponds UNIQUEMENT en JSON strict (pas de texte avant/après) :\n" +
    '{"summary":"Explication courte de l\'erreur (1 phrase en français)",' +
    '"explanation":"Explication détaillée : pourquoi ça plante et quel est l\'impact",' +
    '"oldCode":"La portion de code EXACTE à remplacer — copie mot pour mot depuis le fichier, sans modification",' +
    '"newCode":"Le code corrigé qui doit remplacer oldCode",' +
    '"confidence":"high|medium|low"}';

  try {
    var response = await client.messages.create({
      model: MODEL_FAST, max_tokens: 900,
      messages: [{ role: "user", content: prompt }]
    });
    var text  = response.content[0].text;
    var match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { summary: "Erreur analyse", explanation: text, oldCode: "", newCode: "", confidence: "low" };
  } catch(e) {
    return { summary: "Analyse indisponible : " + e.message, explanation: "", oldCode: "", newCode: "", confidence: "low" };
  }
}

// ── DIAGNOSTIC PLAYWRIGHT — analyse les logs d'un run échoué ─────────────────
// Retourne une structure normalisée pour le bouton "Corriger" universel
async function analyzePlaywrightFail(logs, resultData) {
  var logsText = (Array.isArray(logs) ? logs : (logs || "").split("\n")).slice(-100).join("\n");
  var logsArr = Array.isArray(logs) ? logs : (logs || "").split("\n");
  var failLines = logsArr.filter(function(l) {
    return l.includes("[FAIL]") || l.includes("FAIL") || l.includes("[ERR]") || l.includes("Error");
  }).slice(0, 20).join("\n");
  var bugList = (resultData.bugs || []).map(function(b) { return "- " + (b.title || b); }).join("\n");

  var prompt = "Tu es QA expert Playwright et développeur web senior.\n" +
    "Un run Playwright a échoué. Analyse les logs et fournis un diagnostic structuré.\n\n" +
    "Ticket: " + (resultData.ticketKey || "?") + " | Mode: " + (resultData.mode || "?") +
    " | Env: " + (resultData.env || "?") +
    " | Pass: " + (resultData.pass || 0) + "/" + (resultData.total || 0) + "\n\n" +
    "LIGNES D'ERREUR :\n" + (failLines || "voir logs complets") + "\n\n" +
    "LOGS COMPLETS (fin) :\n" + logsText + "\n\n" +
    (bugList ? "BUGS DÉTECTÉS :\n" + bugList + "\n\n" : "") +
    "Réponds UNIQUEMENT en JSON strict :\n" +
    "{\n" +
    '  "diagnostic": "Explication claire du problème (2-3 phrases)",\n' +
    '  "causeProbable": "Cause technique précise",\n' +
    '  "typeErreur": "SYNTAX_JIRA | PARSING | CONFIG | UNKNOWN",\n' +
    '  "correction": "Action corrective détaillée",\n' +
    '  "actionSuggérée": {\n' +
    '    "type": "OPEN_JIRA | AUTO_FIX | OPEN_CONFIG | CLAUDE_CODE",\n' +
    '    "valeur": "valeur spécifique (URL, champ config, etc.)",\n' +
    '    "code": "snippet de code à appliquer si AUTO_FIX (optionnel)"\n' +
    "  },\n" +
    '  "priorité": "HIGH | MEDIUM | LOW",\n' +
    '  "pages": ["URLs en échec"]\n' +
    "}\n\n" +
    "RÈGLES pour typeErreur :\n" +
    "- SYNTAX_JIRA : si l'erreur vient du ticket Jira (encodage, caractères spéciaux, syntaxe)\n" +
    "- PARSING : si l'erreur vient du parsing/extraction (URL malformée, sélecteur cassé, caractères spéciaux dans les données)\n" +
    "- CONFIG : si l'erreur vient d'un mauvais paramétrage (variable d'env, config, authentification, session expirée)\n" +
    "- UNKNOWN : si l'erreur est complexe ou ne rentre dans aucune catégorie\n\n" +
    "RÈGLES pour actionSuggérée.type :\n" +
    "- OPEN_JIRA : ouvrir le ticket Jira pour corriger manuellement\n" +
    "- AUTO_FIX : correction automatique applicable par le code (fournir le snippet dans 'code')\n" +
    "- OPEN_CONFIG : rediriger vers les paramètres de l'outil QA\n" +
    "- CLAUDE_CODE : erreur complexe nécessitant une analyse approfondie";

  var fallback = {
    diagnostic: "Erreur analyse",
    causeProbable: "Inconnue",
    typeErreur: "UNKNOWN",
    correction: "Consulter les logs",
    "actionSuggérée": { type: "CLAUDE_CODE", valeur: "", code: "" },
    "priorité": "MEDIUM",
    pages: []
  };

  try {
    var response = await client.messages.create({
      model: MODEL_FAST, max_tokens: 900,
      messages: [{ role: "user", content: prompt }]
    });
    var text = response.content[0].text;
    var match = text.match(/\{[\s\S]*\}/);
    if (match) {
      var parsed = JSON.parse(match[0]);
      // Normaliser : garantir la structure attendue
      var result = {
        diagnostic:      parsed.diagnostic || parsed.diagnosis || fallback.diagnostic,
        causeProbable:   parsed.causeProbable || parsed.cause || fallback.causeProbable,
        typeErreur:      (parsed.typeErreur || "UNKNOWN").toUpperCase(),
        correction:      parsed.correction || parsed.fix || fallback.correction,
        "actionSuggérée": parsed["actionSuggérée"] || parsed.actionSuggeree || parsed.actionSuggested || fallback["actionSuggérée"],
        "priorité":      (parsed["priorité"] || parsed.priority || "MEDIUM").toUpperCase(),
        pages:           parsed.pages || parsed.affectedPages || [],
        // Rétrocompatibilité avec l'ancien format (dashboard existant)
        diagnosis:       parsed.diagnostic || parsed.diagnosis || fallback.diagnostic,
        cause:           parsed.causeProbable || parsed.cause || fallback.causeProbable,
        fix:             parsed.correction || parsed.fix || fallback.correction,
        priority:        (parsed["priorité"] || parsed.priority || "MEDIUM").toLowerCase(),
        affectedPages:   parsed.pages || parsed.affectedPages || []
      };
      // Post-correction : si le LLM accuse le ticket Jira mais que l'erreur contient
      // des caractères Jira parasites dans les URLs → c'est un problème de parsing interne
      if (result.typeErreur === "SYNTAX_JIRA") {
        var allText = (result.diagnostic + " " + result.causeProbable + " " + result.correction).toLowerCase();
        var hasJiraChars = /[\)\(\]\[\|\_\{\}]/.test(allText) || /url.*malform|caract.*parasit|pars/i.test(allText);
        if (hasJiraChars) {
          result.typeErreur = "PARSING";
          result.diagnostic = "Caractères Jira détectés dans l'URL extraite — correction automatique appliquée par l'outil QA. " + result.diagnostic;
          result.diagnosis = result.diagnostic;
          result.causeProbable = "Le parser d'URLs n'éliminait pas les caractères de syntaxe Jira ( ) [ ] | _ en fin d'URL.";
          result.cause = result.causeProbable;
          result["actionSuggérée"] = { type: "AUTO_FIX", valeur: "", code: "" };
        }
      }
      return result;
    }
    return Object.assign({}, fallback, { diagnostic: text, diagnosis: text });
  } catch(e) {
    return Object.assign({}, fallback, { diagnostic: "Erreur analyse : " + e.message, diagnosis: "Erreur analyse : " + e.message });
  }
}

// ── EXTRACTION URLs DEPUIS DESCRIPTION ────────────────────────────────────────
/**
 * Extrait toutes les URLs trouvées dans un texte (description de ticket Jira).
 * Retourne un tableau de strings URL dédupliqué.
 */
function extractUrlsFromDescription(text) {
  if (!text || typeof text !== "string") return [];
  // 1. Extraire les URLs depuis la syntaxe Jira [texte|url]
  var jiraLinkUrls = [];
  var jiraLinkRe = /\[([^\|\]]+)\|([^\]]+)\]/g;
  var jlm;
  while ((jlm = jiraLinkRe.exec(text)) !== null) {
    var jlUrl = jlm[2].trim();
    if (/^https?:\/\//i.test(jlUrl)) jiraLinkUrls.push(jlUrl);
  }
  // 2. Extraire les URLs brutes
  var urlRegex = /https?:\/\/[^\s<>"'{}\\^`\]\)]+/g;
  var raw = text.match(urlRegex) || [];
  var all = jiraLinkUrls.concat(raw);
  var seen = {};
  return all
    .map(function(u) {
      // Nettoyer les caractères Jira parasites en fin d'URL
      return u.replace(/[\)\(\]\[\|\_\{\}.,;:!?]+$/g, "").trim();
    })
    .filter(function(u) {
      if (!u || u.length < 10) return false;
      try { new URL(u); } catch(e) { return false; }
      if (seen[u]) return false;
      seen[u] = true;
      return true;
    });
}

// ── 14. GÉNÉRER DES SCÉNARIOS EXÉCUTABLES PLAYWRIGHT ────────────────────────
// Prend un ticket (key, summary, description, type, urls) et retourne des scénarios normalisés
async function generateExecutableScenarios(ticket) {
  var key     = ticket.key || "?";
  var summary = ticket.summary || "";
  var desc    = ticket.description || extractText((ticket.fields && ticket.fields.description) || "");
  var type    = ticket.type || (ticket.fields && ticket.fields.issuetype && ticket.fields.issuetype.name) || "";
  var urls    = ticket.urls || [];

  // Contexte parent (ticket source US/Bug lié au ticket TEST)
  var parentContext = "";
  if (ticket.parentKey) {
    parentContext = "\n\nTICKET SOURCE LIÉ : " + ticket.parentKey + "\n" +
      "Titre source : " + (ticket.parentSummary || "") + "\n" +
      "Description source : " + (ticket.parentDescription || "").substring(0, 1500) + "\n";
  }

  // Détecter si le desc contient des cas CSV injectés
  var hasCSVCases = desc.indexOf("CAS DE TEST À CONVERTIR") !== -1 || desc.indexOf("CAS DE TEST À EXÉCUTER") !== -1;

  // Compter les cas CSV pour forcer le nombre exact de scénarios
  var csvCaseCount = 0;
  if (hasCSVCases) {
    var casMatches = desc.match(/Cas \d+ :/g);
    csvCaseCount = casMatches ? casMatches.length : 0;
  }

  var csvRule = "";
  if (hasCSVCases && csvCaseCount > 0) {
    csvRule =
      "\n⚠️ RÈGLE ABSOLUE — NOMBRE DE SCÉNARIOS :\n" +
      "Il y a EXACTEMENT " + csvCaseCount + " cas de test dans le CSV.\n" +
      "Tu DOIS générer EXACTEMENT " + csvCaseCount + " scénarios — 1 par cas, dans l'ordre.\n" +
      "NE PAS fusionner, regrouper ou ignorer de cas. Chaque \"Cas N\" = 1 scénario.\n" +
      "Si un cas n'est pas automatisable, génère-le quand même avec type: \"MANUEL\".\n\n";
  }

  var prompt =
    ANTI_HALLU +
    "Tu dois générer des scénarios de test Playwright EXÉCUTABLES pour ce ticket Jira.\n\n" +
    "Ticket  : " + key + "\n" +
    "Type    : " + type + "\n" +
    "Résumé  : " + summary + "\n" +
    "Description : " + desc.substring(0, 4000) + "\n" +
    parentContext +
    "URLs disponibles : " + (urls.length > 0 ? urls.map(function(u) { return u.url || u; }).join(", ") : "[aucune URL dans le ticket]") + "\n\n" +
    csvRule +
    "STRUCTURE OBLIGATOIRE pour chaque scénario :\n" +
    "{\n" +
    '  "id": "scenario-1",\n' +
    '  "titre": "Titre descriptif du test",\n' +
    '  "type": "AUTO" ou "MANUEL",\n' +
    '  "actions": [\n' +
    '    { "type": "navigate", "url": "https://..." },\n' +
    '    { "type": "click", "selector": "css-selector" },\n' +
    '    { "type": "fill", "selector": "css-selector", "value": "texte" },\n' +
    '    { "type": "waitForURL", "value": "pattern" },\n' +
    '    { "type": "waitForEvent", "event": "popup" },\n' +
    '    { "type": "hover", "selector": "css-selector" },\n' +
    '    { "type": "press", "key": "Enter" },\n' +
    '    { "type": "wait", "value": "1000" },\n' +
    '    { "type": "scroll", "selector": "css-selector" }\n' +
    "  ],\n" +
    '  "assertions": [\n' +
    '    { "type": "url", "operator": "toContain", "value": "/path" },\n' +
    '    { "type": "url", "operator": "toBe", "value": "https://full-url" },\n' +
    '    { "type": "url", "operator": "notToContain", "value": "error" },\n' +
    '    { "type": "element", "operator": "toBeVisible", "selector": "css-selector" },\n' +
    '    { "type": "element", "operator": "toHaveText", "selector": "css-selector", "value": "texte" },\n' +
    '    { "type": "popup", "operator": "toBeTruthy" },\n' +
    '    { "type": "title", "operator": "toContain", "value": "texte" }\n' +
    "  ]\n" +
    "}\n\n" +
    "RÈGLES STRICTES :\n" +
    "1. Un scénario AUTO DOIT avoir au minimum 1 action navigate + 1 assertion vérifiable.\n" +
    "2. Les sélecteurs CSS doivent être réalistes (balises HTML standard, classes CSS courantes).\n" +
    "3. Si tu ne peux PAS générer d'actions/assertions concrètes → mets type: \"MANUEL\".\n" +
    "4. Utilise uniquement les URLs du ticket. Si aucune URL → navigate vers la page d'accueil.\n" +
    "5. Pour un Bug : teste la correction (le scénario doit vérifier que le bug est corrigé).\n" +
    "6. Pour une US : teste les critères d'acceptation (AC).\n" +
    "7. Pour un Test : exécute les étapes décrites dans le cas de test.\n" +
    (hasCSVCases && csvCaseCount > 0
      ? "8. Tu DOIS retourner EXACTEMENT " + csvCaseCount + " scénarios. Pas plus, pas moins.\n"
      : "8. Génère entre 1 et 6 scénarios maximum.\n") +
    "\nRetourne un JSON : { \"scenarios\": [ ... ] }";

  try {
    var result = await askJSON(prompt, MODEL_QUALITY);
    if (result && result.scenarios && Array.isArray(result.scenarios)) {
      return result.scenarios;
    }
    return [];
  } catch (e) {
    console.log("[LEAD-QA] Erreur génération scénarios : " + e.message.substring(0, 80));
    return [];
  }
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
module.exports = {
  // Analyse & décision
  analyzeUS,
  reviewUS,
  decideStrategy,
  // Fonctions fusionnees (daily-job optimise)
  analyzeAndReviewUS,
  generateTestAndCSV,
  // Génération & ADF
  enrichUS,
  buildADFDescription,
  generateTestTicket,
  generateTestCasesCSV,
  generateBugTicket,
  // Vue interne/externe + validation + Xray
  buildInternalView,
  buildExternalJiraPayload,
  validateJiraPayload,
  buildXraySteps,
  generateReport,
  handleDirectRequest,
  // Vision & extraction
  analyzeImage,
  extractFromHTML,
  // Diagnostic Playwright
  analyzePlaywrightFail,
  // Auto-debug agent errors
  analyzeAgentError,
  // Scénarios Playwright exécutables
  generateExecutableScenarios,
  // Extraction URLs
  extractUrlsFromDescription,
  // LLM bas niveau (pour routes custom du serveur)
  askJSON,
  // Utilitaires
  saveMarkdown,
  saveCSV,
  extractText,
  extractEpic,
  safeTruncate,
  // Modèles
  MODEL_FAST,
  MODEL_QUALITY
};
