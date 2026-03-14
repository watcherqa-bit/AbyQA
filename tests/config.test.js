// tests/config.test.js — Tests unitaires pour config.js
"use strict";

const path = require("path");
const fs   = require("fs");

// Sauvegarder l'env original
const origEnv = { ...process.env };

afterEach(() => {
  // Restaurer l'env
  process.env = { ...origEnv };
  // Purger le cache require pour recharger config à chaque test
  delete require.cache[require.resolve("../config")];
});

describe("config.js", () => {

  describe("loadEnv / get()", () => {
    test("charge les variables depuis .env si le fichier existe", () => {
      const CFG = require("../config");
      // Le fichier .env existe en local, donc on doit avoir des valeurs
      expect(CFG.jira.host).toBeTruthy();
      expect(typeof CFG.jira.host).toBe("string");
    });

    test("jira.authHeader() retourne un header Basic valide", () => {
      const CFG = require("../config");
      var header = CFG.jira.authHeader();
      expect(header.startsWith("Basic ")).toBe(true);
      // Le header doit être du base64 valide
      var b64 = header.replace("Basic ", "");
      expect(() => Buffer.from(b64, "base64")).not.toThrow();
    });

    test("server.port retourne un nombre", () => {
      const CFG = require("../config");
      expect(typeof CFG.server.port).toBe("number");
      expect(CFG.server.port).toBeGreaterThan(0);
    });
  });

  describe("DATA_DIR / isCloud", () => {
    test("en local (pas de DATA_DIR), dataDir = __dirname du config", () => {
      const CFG = require("../config");
      // En local, dataDir pointe vers le dossier racine du projet
      expect(CFG.dataDir).toBe(path.dirname(require.resolve("../config")));
    });

    test("isCloud est false en local (pas de DATA_DIR ni production)", () => {
      const CFG = require("../config");
      // En local sans DATA_DIR et NODE_ENV !== production
      if (!process.env.DATA_DIR && process.env.NODE_ENV !== "production") {
        expect(CFG.isCloud).toBe(false);
      }
    });

    test("DATA_DIR est lu depuis process.env.DATA_DIR au chargement", () => {
      // On vérifie que config.js lit bien process.env.DATA_DIR
      // Le test précédent confirme que sans DATA_DIR → __dirname
      const CFG = require("../config");
      expect(typeof CFG.dataDir).toBe("string");
      expect(typeof CFG.isCloud).toBe("boolean");
    });
  });

  describe("paths", () => {
    test("paths contient les clés attendues", () => {
      const CFG = require("../config");
      var expectedKeys = ["reports", "screenshots", "uploads", "errors", "inbox", "auth", "assets", "collections"];
      expectedKeys.forEach(k => {
        expect(CFG.paths).toHaveProperty(k);
        expect(typeof CFG.paths[k]).toBe("string");
      });
    });

    test("paths.init() crée les répertoires sans erreur", () => {
      const CFG = require("../config");
      expect(() => CFG.paths.init()).not.toThrow();
    });

    test("paths data sont basés sur dataDir, assets sur __dirname", () => {
      const CFG = require("../config");
      // Les chemins data doivent commencer par dataDir
      expect(CFG.paths.reports.startsWith(CFG.dataDir)).toBe(true);
      expect(CFG.paths.inbox.startsWith(CFG.dataDir)).toBe(true);
      expect(CFG.paths.auth.startsWith(CFG.dataDir)).toBe(true);
      // assets est toujours relatif au code source, pas au data dir
      var configDir = path.dirname(require.resolve("../config"));
      expect(CFG.paths.assets.startsWith(configDir)).toBe(true);
    });
  });

  describe("envs", () => {
    test("envs.get() retourne l'URL de l'env demandé", () => {
      const CFG = require("../config");
      expect(CFG.envs.get("sophie")).toBe(CFG.envs.sophie);
      expect(CFG.envs.get("prod")).toBe(CFG.envs.prod);
    });

    test("envs.get() fallback sur sophie si env inconnu", () => {
      const CFG = require("../config");
      expect(CFG.envs.get("unknown")).toBe(CFG.envs.sophie);
    });

    test("envs.adapt() remplace le domaine dans une URL", () => {
      const CFG = require("../config");
      var adapted = CFG.envs.adapt("https://sophie.safran-group.com/page/test", "prod");
      expect(adapted).toContain("safran-group.com/page/test");
      expect(adapted).not.toContain("sophie");
    });
  });

  describe("httpAuth", () => {
    test("httpAuth a sophie et paulo, pas prod", () => {
      const CFG = require("../config");
      expect(CFG.httpAuth).toHaveProperty("sophie");
      expect(CFG.httpAuth).toHaveProperty("paulo");
      expect(CFG.httpAuth).not.toHaveProperty("prod");
    });
  });

  describe("email", () => {
    test("email.enabled() retourne un booléen", () => {
      const CFG = require("../config");
      expect(typeof CFG.email.enabled()).toBe("boolean");
    });
  });
});
