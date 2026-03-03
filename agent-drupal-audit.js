// agent-drupal-audit.js - Audit complet du BO Drupal Safran
// Explore tout le BO et produit un rapport de ce qui est automatisable
// Usage : node agent-drupal-audit.js sophie
//         node agent-drupal-audit.js paulo

"use strict";

// Forcer le chemin des navigateurs Playwright (Render/cloud Linux uniquement)
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.platform !== "win32") {
  process.env.PLAYWRIGHT_BROWSERS_PATH = require("path").join(__dirname, ".playwright");
}

const fs       = require("fs");
const path     = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CFG             = require("./config");
CFG.paths.init();
const SCREENSHOTS_DIR = CFG.paths.screenshots;
const REPORTS_DIR     = CFG.paths.reports;

const ENVS = {
  sophie: {
    url:      CFG.envs.sophie,
    login:    CFG.httpAuth.sophie.user || CFG.drupal.user,
    password: CFG.httpAuth.sophie.pass || CFG.drupal.pass
  },
  paulo: {
    url:      CFG.envs.paulo,
    login:    CFG.httpAuth.paulo.user  || CFG.drupal.user,
    password: CFG.httpAuth.paulo.pass  || CFG.drupal.pass
  }
};
// ─────────────────────────────────────────────────────────────────────────────

[SCREENSHOTS_DIR, REPORTS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function waitForEnter(msg) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

// ── CONNEXION + 2FA ───────────────────────────────────────────────────────────
async function login(page, env) {
  console.log(`[LOGIN] ${env.url}/user/login`);
  await page.goto(`${env.url}/user/login`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Remplir email
  for (const s of ["#edit-name", "input[name='name']", "input[type='email']"]) {
    if (await page.isVisible(s).catch(() => false)) {
      await page.fill(s, env.login);
      console.log("  [✓] Email rempli :", env.login);
      break;
    }
  }

  // Remplir password
  for (const s of ["#edit-pass", "input[name='pass']", "input[type='password']"]) {
    if (await page.isVisible(s).catch(() => false)) {
      await page.fill(s, env.password);
      console.log("  [✓] Password rempli");
      break;
    }
  }

  // Soumettre
  for (const s of ["#edit-submit", "input[value='Log in']", "button[type='submit']", ".form-submit"]) {
    if (await page.isVisible(s).catch(() => false)) {
      await page.click(s);
      console.log("  [✓] Formulaire soumis");
      break;
    }
  }

  // Attendre navigation
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

  // TOUJOURS faire une pause pour le 2FA - l'utilisateur confirme quand il est prêt
  console.log("\n" + "═".repeat(55));
  console.log("  🔐 ÉTAPE 2FA");
  console.log("═".repeat(55));
  console.log("  Si une page de code 2FA s'affiche dans le navigateur :");
  console.log("  → Entre ton code 6 chiffres et valide");
  console.log("  Si tu es déjà dans le BO Drupal :");
  console.log("  → Appuie directement sur ENTRÉE");
  console.log("═".repeat(55));
  await waitForEnter("\n  ✅ Appuie sur ENTRÉE quand tu es connecté au BO...\n");

  // Attendre que le BO soit chargé
  await page.waitForTimeout(2000);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

  // Vérifier la connexion
  const currentUrl = page.url();
  const pageContent = await page.content();
  const isAdmin = currentUrl.includes("/admin") || currentUrl.includes("check_logged_in") ||
                  pageContent.includes("toolbar-bar") || pageContent.includes("Manage") ||
                  pageContent.includes("admin-toolbar");

  console.log(`  [INFO] URL actuelle : ${currentUrl}`);
  if (isAdmin) {
    console.log("  [✓] Connexion BO confirmée !\n");
  } else {
    console.log("  [⚠] Connexion incertaine - on continue...\n");
  }
}

// ── ANALYSER UN FORMULAIRE ────────────────────────────────────────────────────
async function analyzeForm(page, url, name) {
  const result = {
    name,
    url,
    fields:       [],
    hasFileUpload: false,
    hasMedia:      false,
    hasCKEditor:   false,
    hasSelect:     false,
    hasTabs:       [],
    automatable:   null,
    blockers:      [],
    screenshot:    null
  };

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);

    const screenshot = path.join(SCREENSHOTS_DIR, `audit-${name.replace(/[^a-z0-9]/gi, "-")}-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    result.screenshot = screenshot;

    // Récupérer les onglets
    const tabs = await page.$$eval(
      ".horizontal-tabs-list a, .vertical-tabs__menu-item a, [role='tab']",
      els => els.map(e => e.textContent.trim()).filter(Boolean)
    ).catch(() => []);
    result.hasTabs = tabs;

    // Analyser les champs
    const inputs = await page.$$eval("input:not([type='hidden']):not([type='submit']):not([type='button'])", els =>
      els.map(e => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder, required: e.required }))
    ).catch(() => []);

    const textareas = await page.$$eval("textarea", els =>
      els.map(e => ({ type: "textarea", name: e.name, id: e.id, required: e.required }))
    ).catch(() => []);

    const selects = await page.$$eval("select", els =>
      els.map(e => ({ type: "select", name: e.name, id: e.id, required: e.required, options: e.options.length }))
    ).catch(() => []);

    result.fields = [...inputs, ...textareas, ...selects];

    // Détecter les blockers
    result.hasFileUpload = result.fields.some(f => f.type === "file") ||
                           await page.isVisible("input[type='file'], .file-upload, [data-drupal-selector*='file']").catch(() => false);

    result.hasMedia = await page.isVisible(".media-library-widget, .media-library, button:text('Add media'), input[data-media-library]").catch(() => false);

    result.hasCKEditor = await page.isVisible(".ck-editor, .ck-content, .cke, .ckeditor").catch(() => false);

    result.hasSelect = selects.length > 0;

    // Calculer l'automatisabilité
    if (result.hasFileUpload) result.blockers.push("Upload de fichier requis");
    if (result.hasMedia)      result.blockers.push("Sélection de média requis (Media Library)");

    if (result.blockers.length === 0)      result.automatable = "✅ COMPLET";
    else if (result.blockers.length === 1) result.automatable = "⚠️ PARTIEL";
    else                                   result.automatable = "❌ LIMITÉ";

  } catch (e) {
    result.automatable = "❌ ERREUR";
    result.blockers.push(`Erreur : ${e.message}`);
  }

  return result;
}

// ── DÉCOUVERTE DES TYPES DE CONTENU ──────────────────────────────────────────
async function discoverContentTypes(page, env) {
  console.log("[AUDIT] Découverte des types de contenu...");
  await page.goto(`${env.url}/node/add`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Screenshot pour debug
  await page.screenshot({ path: require("path").join(SCREENSHOTS_DIR, `debug-node-add-${Date.now()}.png`) });
  console.log(`  [DEBUG] URL après /node/add : ${page.url()}`);

  // Sélecteurs larges pour capturer tous les liens de types de contenu
  const types = await page.$$eval("a", els =>
    els
      .filter(e => e.href && e.href.includes("/node/add/") && !e.href.endsWith("/node/add/") && !e.href.endsWith("/node/add"))
      .map(e => ({
        name: e.textContent.trim().replace(/\s+/g, " ") || "Sans nom",
        url:  e.href,
        path: new URL(e.href).pathname
      }))
      .filter(e => e.name.length > 0 && e.name.length < 100)
  ).catch(() => []);

  // Déduplication
  const unique = [];
  const seen   = new Set();
  for (const t of types) {
    if (!seen.has(t.path)) { seen.add(t.path); unique.push(t); }
  }

  // Si aucun trouvé via /node/add, essayer /admin/content/add ou /admin/structure/types
  if (unique.length === 0) {
    console.log("  [INFO] /node/add vide → tentative via /admin/structure/types/add...");
    await page.goto(`${env.url}/admin/structure/types`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);

    // Reconstruire les URLs de création depuis la liste des types
    const structureTypes = await page.$$eval("a", els =>
      els
        .filter(e => e.href && (e.href.includes("/node/add/") || e.href.includes("/structure/types/manage")))
        .map(e => ({
          name: e.textContent.trim().replace(/\s+/g, " "),
          url:  e.href,
          path: new URL(e.href).pathname
        }))
        .filter(e => e.name.length > 0)
    ).catch(() => []);

    for (const t of structureTypes) {
      if (!seen.has(t.path)) { seen.add(t.path); unique.push(t); }
    }

    // Si encore rien → types connus de Safran en dur
    if (unique.length === 0) {
      console.log("  [INFO] Utilisation des types de contenu connus pour Safran...");
      const knownTypes = [
        { name: "News",          path: "/node/add/news",          url: `${env.url}/node/add/news` },
        { name: "Press Release", path: "/node/add/press_release", url: `${env.url}/node/add/press_release` },
        { name: "Homepage",      path: "/node/add/homepage",      url: `${env.url}/node/add/homepage` },
        { name: "Jobs",          path: "/node/add/jobs",          url: `${env.url}/node/add/jobs` },
        { name: "Company",       path: "/node/add/company",       url: `${env.url}/node/add/company` },
        { name: "Commercial Sheet", path: "/node/add/commercial_sheet", url: `${env.url}/node/add/commercial_sheet` },
        { name: "Institutional", path: "/node/add/institutional", url: `${env.url}/node/add/institutional` }
      ];
      for (const t of knownTypes) {
        if (!seen.has(t.path)) { seen.add(t.path); unique.push(t); }
      }
    }
  }

  console.log(`[✓] ${unique.length} type(s) de contenu trouvé(s) : ${unique.map(t => t.name).join(", ")}`);
  return unique;
}

// ── DÉCOUVERTE DES TYPES DE MÉDIAS ───────────────────────────────────────────
async function discoverMediaTypes(page, env) {
  console.log("[AUDIT] Découverte des types de médias...");
  await page.goto(`${env.url}/media/add`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log(`  [DEBUG] URL après /media/add : ${page.url()}`);

  const types = await page.$$eval("a", els =>
    els
      .filter(e => e.href && e.href.includes("/media/add/") && !e.href.endsWith("/media/add"))
      .map(e => ({
        name: e.textContent.trim().replace(/\s+/g, " ") || "Sans nom",
        url:  e.href,
        path: new URL(e.href).pathname
      }))
      .filter(e => e.name.length > 0 && e.name.length < 100)
  ).catch(() => []);

  const unique = [];
  const seen   = new Set();
  for (const t of types) {
    if (!seen.has(t.path)) { seen.add(t.path); unique.push(t); }
  }

  // Fallback types médias connus Safran
  if (unique.length === 0) {
    console.log("  [INFO] Utilisation des types de médias connus pour Safran...");
    const knownMedia = [
      { name: "Image",       path: "/media/add/image",       url: `${env.url}/media/add/image` },
      { name: "Video",       path: "/media/add/video",       url: `${env.url}/media/add/video` },
      { name: "Publication", path: "/media/add/publication", url: `${env.url}/media/add/publication` },
      { name: "Document",    path: "/media/add/document",    url: `${env.url}/media/add/document` }
    ];
    for (const t of knownMedia) {
      if (!seen.has(t.path)) { seen.add(t.path); unique.push(t); }
    }
  }

  console.log(`[✓] ${unique.length} type(s) de média trouvé(s) : ${unique.map(t => t.name).join(", ")}`);
  return unique;
}

// ── AUDIT DU MENU ADMIN ───────────────────────────────────────────────────────
async function auditAdminMenu(page, env) {
  console.log("[AUDIT] Analyse du menu admin...");
  await page.goto(`${env.url}/admin`, { waitUntil: "networkidle", timeout: 30000 });

  const menuItems = await page.$$eval(
    ".toolbar-menu a, #toolbar-bar a, .admin-toolbar a, .toolbar-item",
    els => els.map(e => ({ label: e.textContent.trim(), href: e.href })).filter(e => e.label && e.href)
  ).catch(() => []);

  // Screenshot du menu admin
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `audit-menu-admin-${Date.now()}.png`), fullPage: false });

  return menuItems.slice(0, 20); // top 20 items
}

// ── GÉNÉRATION DU RAPPORT MARKDOWN ───────────────────────────────────────────
function generateReport(env, contentResults, mediaResults, menuItems) {
  const date     = new Date().toLocaleString("fr-FR");
  const fullAuto = contentResults.filter(r => r.automatable === "✅ COMPLET").length;
  const partial  = contentResults.filter(r => r.automatable === "⚠️ PARTIEL").length;
  const limited  = contentResults.filter(r => r.automatable === "❌ LIMITÉ" || r.automatable === "❌ ERREUR").length;

  let report = `# Audit BO Drupal - ${env.name.toUpperCase()}
> Généré par Aby QA V2 le ${date}

---

## 📊 RÉSUMÉ EXÉCUTIF

| Catégorie | Nombre |
|---|---|
| Types de contenu découverts | ${contentResults.length} |
| ✅ Automatisation complète | ${fullAuto} |
| ⚠️ Automatisation partielle | ${partial} |
| ❌ Automatisation limitée | ${limited} |
| Types de médias | ${mediaResults.length} |

---

## 📋 TYPES DE CONTENU

`;

  for (const r of contentResults) {
    report += `### ${r.automatable} ${r.name}
- **URL :** \`${r.url}\`
- **Onglets :** ${r.hasTabs.length ? r.hasTabs.join(", ") : "Aucun"}
- **Champs détectés :** ${r.fields.length} (texte: ${r.fields.filter(f => ["text","email","text","textarea"].includes(f.type)).length}, select: ${r.fields.filter(f => f.type === "select").length})
- **CKEditor :** ${r.hasCKEditor ? "✅ Oui" : "Non"}
- **Upload fichier :** ${r.hasFileUpload ? "⚠️ Oui" : "Non"}
- **Media Library :** ${r.hasMedia ? "⚠️ Oui" : "Non"}
${r.blockers.length ? `- **Blockers :** ${r.blockers.join(", ")}` : "- **Blockers :** Aucun"}
- **Screenshot :** \`${r.screenshot || "N/A"}\`

`;
  }

  report += `---

## 🖼️ TYPES DE MÉDIAS

`;

  for (const r of mediaResults) {
    report += `### ${r.automatable} ${r.name}
- **URL :** \`${r.url}\`
- **Upload fichier :** ${r.hasFileUpload ? "⚠️ Oui (blocker)" : "Non"}
- **Blockers :** ${r.blockers.length ? r.blockers.join(", ") : "Aucun"}

`;
  }

  report += `---

## 🎯 COMMANDES DISPONIBLES

### ✅ Automatisation complète
\`\`\`bash
${contentResults.filter(r => r.automatable === "✅ COMPLET").map(r => {
  const type = r.url.split("/node/add/")[1] || r.name.toLowerCase().replace(/\s+/g, "_");
  return `node agent-drupal.js "Créer 3 ${r.name}" ${env.name}`;
}).join("\n")}
\`\`\`

### ⚠️ Automatisation partielle (champs texte seulement, médias à ajouter manuellement)
\`\`\`bash
${contentResults.filter(r => r.automatable === "⚠️ PARTIEL").map(r =>
  `node agent-drupal.js "Créer 1 ${r.name}" ${env.name}  # médias à compléter manuellement`
).join("\n")}
\`\`\`

### ❌ Non automatisables (nécessitent une intervention manuelle)
${contentResults.filter(r => r.automatable === "❌ LIMITÉ" || r.automatable === "❌ ERREUR").map(r =>
  `- **${r.name}** : ${r.blockers.join(", ")}`
).join("\n")}

---

## 🔧 MENU ADMIN DÉCOUVERT

${menuItems.slice(0, 10).map(m => `- ${m.label} → \`${m.href}\``).join("\n")}

---

## 📸 SCREENSHOTS

Tous les screenshots sont dans : \`${SCREENSHOTS_DIR}\`
${contentResults.map(r => `- ${r.name} : \`${r.screenshot}\``).join("\n")}
`;

  const filename = `AUDIT-BO-Drupal-${env.name}-${Date.now()}.md`;
  const filepath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filepath, report, "utf8");
  return filepath;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const envArg = (process.argv[2] || "sophie").toLowerCase();

  if (envArg === "prod") {
    console.error("[SÉCURITÉ] ❌ Audit non autorisé sur PROD.");
    process.exit(1);
  }

  const env = ENVS[envArg];
  if (!env) {
    console.error(`[ERR] Environnement inconnu : ${envArg}. Utilise sophie ou paulo.`);
    process.exit(1);
  }
  env.name = envArg;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AGENT DRUPAL AUDIT - ABY QA V2`);
  console.log(`  Environnement : ${envArg} → ${env.url}`);
  console.log(`${"═".repeat(60)}\n`);
  console.log("[INFO] Le navigateur va s'ouvrir en mode visible.");
  console.log("[INFO] Une pause sera faite pour le code 2FA.\n");

  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const page    = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  let contentResults = [];
  let mediaResults   = [];
  let menuItems      = [];

  try {
    // 1. Connexion
    await login(page, env);

    // 2. Découvrir les types de contenu
    const contentTypes = await discoverContentTypes(page, env);
    console.log("\n[AUDIT] Analyse des formulaires de contenu...");
    for (const ct of contentTypes) {
      process.stdout.write(`  → ${ct.name}... `);
      const result = await analyzeForm(page, ct.url, ct.name);
      contentResults.push(result);
      console.log(result.automatable);
    }

    // 3. Découvrir les types de médias
    const mediaTypes = await discoverMediaTypes(page, env);
    console.log("\n[AUDIT] Analyse des formulaires de médias...");
    for (const mt of mediaTypes) {
      process.stdout.write(`  → ${mt.name}... `);
      const result = await analyzeForm(page, mt.url, mt.name);
      mediaResults.push(result);
      console.log(result.automatable);
    }

    // 4. Menu admin
    menuItems = await auditAdminMenu(page, env);

  } catch (e) {
    console.error("[ERR]", e.message);
  } finally {
    await page.waitForTimeout(2000);
    await browser.close();
  }

  // 5. Générer le rapport
  const reportPath = generateReport(env, contentResults, mediaResults, menuItems);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AUDIT TERMINÉ`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Contenu  : ${contentResults.length} types analysés`);
  console.log(`  Médias   : ${mediaResults.length} types analysés`);
  console.log(`  ✅ Complet  : ${contentResults.filter(r => r.automatable === "✅ COMPLET").length}`);
  console.log(`  ⚠️ Partiel  : ${contentResults.filter(r => r.automatable === "⚠️ PARTIEL").length}`);
  console.log(`  ❌ Limité   : ${contentResults.filter(r => r.automatable?.includes("❌")).length}`);
  console.log(`\n  📄 Rapport  : ${reportPath}`);
  console.log(`  📸 Screenshots : ${SCREENSHOTS_DIR}`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(e => { console.error("[ERR FATAL]", e.message); process.exit(1); });