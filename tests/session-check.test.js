// tests/session-check.test.js — Tests unitaires pour lib/session-check.js
"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { checkStorageStateAge } = require("../lib/session-check");

describe("lib/session-check.js", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abyqa-test-"));
  });

  afterEach(() => {
    // Nettoyer le dossier temporaire
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("retourne absent si le fichier auth n'existe pas", () => {
    var result = checkStorageStateAge("sophie", tmpDir);
    expect(result.ok).toBe(false);
    expect(result.absent).toBe(true);
    expect(result.expired).toBe(true);
    expect(result.age).toBeNull();
    expect(result.message).toContain("Session absente");
    expect(result.message).toContain("sophie");
  });

  test("retourne ok si le fichier existe et est récent", () => {
    var authDir = path.join(tmpDir, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    var authFile = path.join(authDir, "sophie.json");
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [] }), "utf8");

    var result = checkStorageStateAge("sophie", tmpDir);
    expect(result.ok).toBe(true);
    expect(result.expired).toBe(false);
    expect(result.absent).toBe(false);
    expect(result.age).toBeDefined();
  });

  test("retourne expiré si le fichier a plus de 24h", () => {
    var authDir = path.join(tmpDir, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    var authFile = path.join(authDir, "prod.json");
    fs.writeFileSync(authFile, JSON.stringify({ cookies: [] }), "utf8");

    // Modifier le mtime pour simuler un fichier de 25h
    var oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(authFile, oldTime, oldTime);

    var result = checkStorageStateAge("prod", tmpDir);
    expect(result.ok).toBe(false);
    expect(result.expired).toBe(true);
    expect(result.absent).toBe(false);
    expect(result.age).toBeGreaterThanOrEqual(24);
    expect(result.message).toContain("expirée");
  });

  test("fonctionne avec différents noms d'environnement", () => {
    var authDir = path.join(tmpDir, "auth");
    fs.mkdirSync(authDir, { recursive: true });

    ["sophie", "paulo", "prod"].forEach(env => {
      var result = checkStorageStateAge(env, tmpDir);
      expect(result.ok).toBe(false);
      expect(result.absent).toBe(true);
      expect(result.message).toContain(env);
    });
  });

  test("message d'absence mentionne login-save-state.js", () => {
    var result = checkStorageStateAge("sophie", tmpDir);
    expect(result.message).toContain("login-save-state.js");
  });

  test("message d'expiration mentionne login-save-state.js", () => {
    var authDir = path.join(tmpDir, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    var authFile = path.join(authDir, "sophie.json");
    fs.writeFileSync(authFile, "{}", "utf8");
    var oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(authFile, oldTime, oldTime);

    var result = checkStorageStateAge("sophie", tmpDir);
    expect(result.message).toContain("login-save-state.js");
  });
});
