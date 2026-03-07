// scenario-executor.js — Exécuteur universel de scénarios Playwright
// Structure normalisée d'un scénario :
// {
//   id: "scenario-1",
//   titre: "...",
//   type: "AUTO" | "MANUEL",
//   actions: [ { type: "navigate"|"click"|"fill"|"waitForEvent"|"waitForURL"|"select"|"hover"|"press", ... } ],
//   assertions: [ { type: "url"|"element"|"popup"|"title"|"text", operator: "toBe"|"toContain"|..., value: "...", selector: "..." } ]
// }
"use strict";

/**
 * Valide qu'un scénario AUTO a des actions ET des assertions exécutables.
 * Retourne { valid: true } ou { valid: false, reason: "..." }
 */
function validateScenario(scenario) {
  if (!scenario) return { valid: false, reason: "Scénario null" };
  if (!scenario.actions || !Array.isArray(scenario.actions) || scenario.actions.length === 0) {
    return { valid: false, reason: "Aucune action définie" };
  }
  if (!scenario.assertions || !Array.isArray(scenario.assertions) || scenario.assertions.length === 0) {
    return { valid: false, reason: "Aucune assertion définie" };
  }
  // Vérifier que les actions ont un type reconnu
  var validActions = ["navigate", "click", "fill", "waitForEvent", "waitForURL", "select", "hover", "press", "wait", "scroll"];
  for (var i = 0; i < scenario.actions.length; i++) {
    var a = scenario.actions[i];
    if (!a.type || validActions.indexOf(a.type) === -1) {
      return { valid: false, reason: "Action inconnue : " + (a.type || "vide") };
    }
    if (a.type === "navigate" && !a.url) return { valid: false, reason: "Action navigate sans url" };
    if ((a.type === "click" || a.type === "fill" || a.type === "hover") && !a.selector) {
      return { valid: false, reason: "Action " + a.type + " sans selector" };
    }
    if (a.type === "fill" && a.value === undefined) return { valid: false, reason: "Action fill sans value" };
  }
  return { valid: true };
}

/**
 * Exécute un scénario normalisé sur une page Playwright.
 * @param {import('playwright').Page} page — page Playwright ouverte
 * @param {object} scenario — scénario normalisé
 * @param {object} [opts] — { timeout: 10000, screenshotDir: "..." }
 * @returns {Promise<{ pass: boolean, error: string|null, actionsExecuted: Array, assertionsChecked: Array, screenshot: string|null }>}
 */
async function executeScenario(page, scenario, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 10000;
  var result = {
    pass: true,
    error: null,
    actionsExecuted: [],
    assertionsChecked: [],
    screenshot: null
  };

  // Validation préalable
  var validation = validateScenario(scenario);
  if (!validation.valid) {
    return {
      pass: false,
      error: "Scénario invalide : " + validation.reason,
      actionsExecuted: [],
      assertionsChecked: [],
      screenshot: null
    };
  }

  // Variable pour capturer les popups/events
  var capturedPopup = null;
  var popupPromise = null;

  // ── EXÉCUTION DES ACTIONS ──────────────────────────────────────────────────
  for (var ai = 0; ai < scenario.actions.length; ai++) {
    var action = scenario.actions[ai];
    var actionResult = { type: action.type, detail: "", pass: true, error: null };

    try {
      switch (action.type) {
        case "navigate":
          await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: timeout });
          actionResult.detail = "Navigué vers " + action.url;
          break;

        case "click":
          // Si l'action suivante est waitForEvent popup, préparer la capture AVANT le click
          var nextAction = scenario.actions[ai + 1];
          if (nextAction && nextAction.type === "waitForEvent" && nextAction.event === "popup") {
            popupPromise = page.waitForEvent("popup", { timeout: timeout });
          }
          await page.locator(action.selector).click({ timeout: timeout });
          actionResult.detail = "Cliqué sur " + action.selector;
          // Attente stabilisation DOM
          await page.waitForTimeout(500);
          break;

        case "fill":
          await page.locator(action.selector).fill(action.value || "", { timeout: timeout });
          actionResult.detail = "Rempli " + action.selector + " avec \"" + (action.value || "").substring(0, 30) + "\"";
          break;

        case "select":
          await page.locator(action.selector).selectOption(action.value || "", { timeout: timeout });
          actionResult.detail = "Sélectionné " + action.value + " dans " + action.selector;
          break;

        case "hover":
          await page.locator(action.selector).hover({ timeout: timeout });
          actionResult.detail = "Hover sur " + action.selector;
          break;

        case "press":
          var pressTarget = action.selector ? page.locator(action.selector) : page;
          if (action.selector) {
            await pressTarget.press(action.key || action.value || "Enter", { timeout: timeout });
          } else {
            await page.keyboard.press(action.key || action.value || "Enter");
          }
          actionResult.detail = "Touche " + (action.key || action.value || "Enter");
          break;

        case "waitForEvent":
          if (action.event === "popup") {
            if (popupPromise) {
              capturedPopup = await popupPromise;
              popupPromise = null;
            } else {
              capturedPopup = await page.waitForEvent("popup", { timeout: timeout });
            }
            actionResult.detail = "Popup capturé : " + (capturedPopup ? capturedPopup.url() : "null");
          } else {
            await page.waitForEvent(action.event || "load", { timeout: timeout });
            actionResult.detail = "Event " + action.event + " capturé";
          }
          break;

        case "waitForURL":
          await page.waitForURL(action.pattern || action.value || "**", { timeout: timeout });
          actionResult.detail = "URL atteinte : " + page.url();
          break;

        case "wait":
          var ms = parseInt(action.value || action.ms || "1000");
          await page.waitForTimeout(ms);
          actionResult.detail = "Attente " + ms + "ms";
          break;

        case "scroll":
          await page.evaluate(function(sel) {
            var el = sel ? document.querySelector(sel) : null;
            if (el) el.scrollIntoView({ behavior: "smooth" });
            else window.scrollTo(0, document.body.scrollHeight / 2);
          }, action.selector || null);
          await page.waitForTimeout(300);
          actionResult.detail = "Scroll vers " + (action.selector || "milieu de page");
          break;

        default:
          actionResult.pass = false;
          actionResult.error = "Type d'action non supporté : " + action.type;
      }
    } catch (e) {
      actionResult.pass = false;
      actionResult.error = e.message.substring(0, 200);
      result.pass = false;
      result.error = "Action " + (ai + 1) + " (" + action.type + ") échouée : " + e.message.substring(0, 150);
      result.actionsExecuted.push(actionResult);
      // Arrêter l'exécution des actions restantes
      break;
    }

    result.actionsExecuted.push(actionResult);
  }

  // ── VÉRIFICATION DES ASSERTIONS ────────────────────────────────────────────
  // Seulement si toutes les actions ont réussi
  if (result.pass) {
    for (var asi = 0; asi < scenario.assertions.length; asi++) {
      var assertion = scenario.assertions[asi];
      var assertResult = { type: assertion.type, operator: assertion.operator, expected: assertion.value, pass: true, actual: null, error: null };

      try {
        switch (assertion.type) {
          case "url":
            // Utiliser la page du popup si on vérifie l'URL du popup
            var urlPage = (capturedPopup && assertion.context === "popup") ? capturedPopup : page;
            var currentUrl = urlPage.url();
            assertResult.actual = currentUrl;
            switch (assertion.operator) {
              case "toBe":
                if (currentUrl !== assertion.value) {
                  assertResult.pass = false;
                  assertResult.error = "URL attendue : " + assertion.value + " — obtenue : " + currentUrl;
                }
                break;
              case "toContain":
                if (!currentUrl.includes(assertion.value)) {
                  assertResult.pass = false;
                  assertResult.error = "URL devrait contenir \"" + assertion.value + "\" — obtenue : " + currentUrl;
                }
                break;
              case "notToContain":
                if (currentUrl.includes(assertion.value)) {
                  assertResult.pass = false;
                  assertResult.error = "URL ne devrait pas contenir \"" + assertion.value + "\" — obtenue : " + currentUrl;
                }
                break;
              case "toStartWith":
                if (!currentUrl.startsWith(assertion.value)) {
                  assertResult.pass = false;
                  assertResult.error = "URL devrait commencer par \"" + assertion.value + "\" — obtenue : " + currentUrl;
                }
                break;
              case "toMatch":
                var re = new RegExp(assertion.value);
                if (!re.test(currentUrl)) {
                  assertResult.pass = false;
                  assertResult.error = "URL ne matche pas /" + assertion.value + "/ — obtenue : " + currentUrl;
                }
                break;
              default:
                assertResult.pass = false;
                assertResult.error = "Opérateur URL inconnu : " + assertion.operator;
            }
            break;

          case "popup":
            assertResult.actual = capturedPopup ? capturedPopup.url() : null;
            if (assertion.operator === "toBeTruthy") {
              if (!capturedPopup) {
                assertResult.pass = false;
                assertResult.error = "Popup attendu mais non capturé";
              }
            } else if (assertion.operator === "toContain" && assertion.value) {
              if (!capturedPopup || !capturedPopup.url().includes(assertion.value)) {
                assertResult.pass = false;
                assertResult.error = "Popup URL devrait contenir \"" + assertion.value + "\"";
              }
            }
            break;

          case "element":
            if (!assertion.selector) {
              assertResult.pass = false;
              assertResult.error = "Assertion element sans selector";
              break;
            }
            var loc = page.locator(assertion.selector);
            switch (assertion.operator) {
              case "toBeVisible":
                try {
                  await loc.waitFor({ state: "visible", timeout: timeout / 2 });
                } catch (e) {
                  assertResult.pass = false;
                  assertResult.error = "Élément " + assertion.selector + " non visible";
                }
                break;
              case "toBeHidden":
                try {
                  await loc.waitFor({ state: "hidden", timeout: timeout / 2 });
                } catch (e) {
                  assertResult.pass = false;
                  assertResult.error = "Élément " + assertion.selector + " devrait être caché";
                }
                break;
              case "toHaveText":
                try {
                  var txt = await loc.textContent({ timeout: timeout / 2 });
                  assertResult.actual = (txt || "").substring(0, 100);
                  if (!(txt || "").includes(assertion.value)) {
                    assertResult.pass = false;
                    assertResult.error = "Texte attendu \"" + assertion.value + "\" non trouvé dans \"" + (txt || "").substring(0, 50) + "\"";
                  }
                } catch (e) {
                  assertResult.pass = false;
                  assertResult.error = "Impossible de lire le texte de " + assertion.selector;
                }
                break;
              case "toHaveAttribute":
                try {
                  var attr = await loc.getAttribute(assertion.attribute || "class", { timeout: timeout / 2 });
                  assertResult.actual = (attr || "").substring(0, 100);
                  if (assertion.value && !(attr || "").includes(assertion.value)) {
                    assertResult.pass = false;
                    assertResult.error = "Attribut " + (assertion.attribute || "class") + " devrait contenir \"" + assertion.value + "\"";
                  }
                } catch (e) {
                  assertResult.pass = false;
                  assertResult.error = "Impossible de lire l'attribut de " + assertion.selector;
                }
                break;
              case "toHaveCount":
                try {
                  var count = await loc.count();
                  assertResult.actual = count;
                  var expected = parseInt(assertion.value);
                  if (count !== expected) {
                    assertResult.pass = false;
                    assertResult.error = "Nombre d'éléments " + assertion.selector + " : " + count + " (attendu : " + expected + ")";
                  }
                } catch (e) {
                  assertResult.pass = false;
                  assertResult.error = "Impossible de compter " + assertion.selector;
                }
                break;
              default:
                assertResult.pass = false;
                assertResult.error = "Opérateur element inconnu : " + assertion.operator;
            }
            break;

          case "title":
            var pageTitle = await page.title();
            assertResult.actual = pageTitle;
            if (assertion.operator === "toContain") {
              if (!pageTitle.includes(assertion.value)) {
                assertResult.pass = false;
                assertResult.error = "Titre devrait contenir \"" + assertion.value + "\" — obtenu : \"" + pageTitle.substring(0, 60) + "\"";
              }
            } else if (assertion.operator === "toBe") {
              if (pageTitle !== assertion.value) {
                assertResult.pass = false;
                assertResult.error = "Titre attendu \"" + assertion.value + "\" — obtenu : \"" + pageTitle.substring(0, 60) + "\"";
              }
            }
            break;

          case "text":
            var bodyText = await page.locator(assertion.selector || "body").textContent({ timeout: timeout / 2 }).catch(function() { return ""; });
            assertResult.actual = (bodyText || "").substring(0, 100);
            if (assertion.operator === "toContain") {
              if (!(bodyText || "").includes(assertion.value)) {
                assertResult.pass = false;
                assertResult.error = "Texte \"" + assertion.value + "\" non trouvé sur la page";
              }
            } else if (assertion.operator === "notToContain") {
              if ((bodyText || "").includes(assertion.value)) {
                assertResult.pass = false;
                assertResult.error = "Texte \"" + assertion.value + "\" trouvé alors qu'il ne devrait pas";
              }
            }
            break;

          case "status":
            // HTTP status — nécessite une navigation préalable
            assertResult.actual = "N/A (vérification post-navigation)";
            break;

          default:
            assertResult.pass = false;
            assertResult.error = "Type d'assertion inconnu : " + assertion.type;
        }
      } catch (e) {
        assertResult.pass = false;
        assertResult.error = e.message.substring(0, 200);
      }

      if (!assertResult.pass) {
        result.pass = false;
        if (!result.error) result.error = assertResult.error;
      }
      result.assertionsChecked.push(assertResult);
    }
  }

  // Fermer le popup si ouvert
  if (capturedPopup) {
    try { await capturedPopup.close(); } catch (e) {}
  }

  return result;
}

module.exports = { executeScenario, validateScenario };
