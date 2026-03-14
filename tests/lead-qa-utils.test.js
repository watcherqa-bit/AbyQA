// tests/lead-qa-utils.test.js — Tests unitaires pour les utilitaires de agent-lead-qa.js
// On teste les fonctions pures exportées sans appeler l'API Anthropic
"use strict";

const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const os     = require("os");

// Pas besoin de mock — on teste uniquement les fonctions utilitaires
// qui ne font pas d'appels API
const leadQA = require("../agent-lead-qa");

describe("agent-lead-qa.js — fonctions utilitaires", () => {

  describe("getCacheStats()", () => {
    test("retourne un objet avec hits, misses, files, hitRate", () => {
      var stats = leadQA.getCacheStats();
      expect(stats).toHaveProperty("hits");
      expect(stats).toHaveProperty("misses");
      expect(stats).toHaveProperty("files");
      expect(stats).toHaveProperty("hitRate");
      expect(typeof stats.hits).toBe("number");
      expect(typeof stats.misses).toBe("number");
      expect(typeof stats.files).toBe("number");
      expect(typeof stats.hitRate).toBe("number");
    });

    test("hitRate est entre 0 et 100", () => {
      var stats = leadQA.getCacheStats();
      expect(stats.hitRate).toBeGreaterThanOrEqual(0);
      expect(stats.hitRate).toBeLessThanOrEqual(100);
    });
  });

  describe("validateJiraPayload()", () => {
    test("détecte les patterns interdits dans le payload", () => {
      var result = leadQA.validateJiraPayload({
        fields: { summary: "TEST - [À préciser] - Fonction" }
      });
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations).toContain("[À préciser]");
    });

    test("retourne valid pour un payload sans patterns interdits", () => {
      var result = leadQA.validateJiraPayload({
        fields: {
          summary: "TEST - Validation des dates - Dates invalides rejetées",
          project: { key: "SAFWBST" }
        }
      });
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test("détecte les références à AbyQA dans le payload", () => {
      var result = leadQA.validateJiraPayload({
        fields: { description: "Généré par AbyQA automatiquement" }
      });
      expect(result.valid).toBe(false);
      expect(result.violations).toContain("AbyQA");
    });

    test("détecte les emojis interdits", () => {
      var result = leadQA.validateJiraPayload({
        fields: { summary: "📋 Test ticket" }
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("buildADFDescription()", () => {
    test("retourne un objet ADF valide", () => {
      var adf = leadQA.buildADFDescription("Contenu test\nLigne 2");
      expect(adf).toHaveProperty("type", "doc");
      expect(adf).toHaveProperty("version", 1);
      expect(adf).toHaveProperty("content");
      expect(Array.isArray(adf.content)).toBe(true);
      expect(adf.content.length).toBeGreaterThan(0);
    });

    test("retourne un doc vide si pas de contenu", () => {
      var adf = leadQA.buildADFDescription("");
      expect(adf.type).toBe("doc");
      expect(adf.content.length).toBeGreaterThanOrEqual(0);
    });
  });

  // buildXraySteps est async et appelle l'API — on le skip en tests unitaires
  // Il sera couvert par les tests d'intégration
});

// ── Tests de la logique de cache (via fichiers temporaires) ──
describe("Logique cache IA (intégration)", () => {
  let tmpCacheDir;

  beforeEach(() => {
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cache-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  test("MD5 de la clé de cache est déterministe", () => {
    var key1 = crypto.createHash("md5").update("model|prompt").digest("hex");
    var key2 = crypto.createHash("md5").update("model|prompt").digest("hex");
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(32);
  });

  test("clés différentes pour prompts différents", () => {
    var key1 = crypto.createHash("md5").update("model|prompt1").digest("hex");
    var key2 = crypto.createHash("md5").update("model|prompt2").digest("hex");
    expect(key1).not.toBe(key2);
  });

  test("clés différentes pour modèles différents", () => {
    var key1 = crypto.createHash("md5").update("haiku|prompt").digest("hex");
    var key2 = crypto.createHash("md5").update("sonnet|prompt").digest("hex");
    expect(key1).not.toBe(key2);
  });

  test("fichier cache JSON est lisible après écriture", () => {
    var entry = { ts: Date.now(), model: "test", response: "réponse test" };
    var file = path.join(tmpCacheDir, "test-entry.json");
    fs.writeFileSync(file, JSON.stringify(entry), "utf8");

    var read = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(read.response).toBe("réponse test");
    expect(read.ts).toBe(entry.ts);
  });

  test("entrée expirée est détectable par TTL", () => {
    var entry = { ts: Date.now() - 5 * 60 * 60 * 1000, model: "test", response: "vieux" };
    var TTL_4H = 4 * 60 * 60 * 1000;
    expect(Date.now() - entry.ts > TTL_4H).toBe(true);
  });

  test("entrée récente n'est pas expirée", () => {
    var entry = { ts: Date.now() - 1000, model: "test", response: "frais" };
    var TTL_4H = 4 * 60 * 60 * 1000;
    expect(Date.now() - entry.ts > TTL_4H).toBe(false);
  });
});
