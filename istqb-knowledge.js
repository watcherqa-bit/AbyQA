// istqb-knowledge.js — Base de connaissances ISTQB Foundation Level v4.0
// Module centralisé injecté dans tous les agents AbyQA
// Source : Syllabus ISTQB CTFL v4.0 (2023)
// Usage : const ISTQB = require("./istqb-knowledge");

"use strict";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAPITRE 1 — FONDAMENTAUX DU TEST (FL-1)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CH1_FONDAMENTAUX = `
## ISTQB — Chapitre 1 : Fondamentaux du test

### 1.1 Qu'est-ce que le test ?
- Le test logiciel évalue la qualité du logiciel et aide à réduire le risque de défaillances en opération.
- Tester ne se limite pas à l'exécution : cela inclut la planification, l'analyse, la conception, l'implémentation, le reporting et la clôture.
- Le test inclut la vérification (le produit est-il bien construit ?) et la validation (le bon produit est-il construit ?).
- Le test est à la fois statique (revues, analyse statique sans exécution) et dynamique (exécution du logiciel).

### 1.2 Pourquoi le test est-il nécessaire ?
- Détection précoce des défauts → réduit le coût de correction (règle du 10x).
- Évalue la qualité : fonctionnelle (ce que le système fait) et non-fonctionnelle (comment il le fait).
- Vérifie la conformité aux exigences contractuelles, légales et réglementaires.
- Le test est un moyen de **réduire le risque**, pas de prouver l'absence de défauts.

### 1.3 Les 7 principes du test
1. **Le test montre la présence de défauts, pas leur absence** — Le test réduit la probabilité de défauts non découverts mais ne peut pas prouver qu'il n'y en a pas.
2. **Le test exhaustif est impossible** — Sauf pour les cas triviaux, tester toutes les combinaisons est impossible. Utiliser l'analyse de risques et les techniques de test pour concentrer l'effort.
3. **Tester tôt économise du temps et de l'argent** — Le shift-left : commencer le test dès le début du cycle (exigences, conception).
4. **Les défauts se regroupent** — La majorité des défauts se concentre dans un petit nombre de modules (principe de Pareto).
5. **Le paradoxe du pesticide** — Répéter les mêmes tests finit par ne plus trouver de défauts. Il faut régulièrement mettre à jour et enrichir les tests.
6. **Le test dépend du contexte** — Les stratégies de test varient selon le domaine (aéronautique ≠ site web ≠ mobile).
7. **L'absence d'erreurs est un leurre** — Un logiciel sans défauts mais ne répondant pas aux besoins utilisateurs est inutile.

### 1.4 Activités et processus de test
Le processus de test comprend :
- **Planification** : définir les objectifs, l'approche, les ressources, le calendrier.
- **Analyse** : identifier les conditions de test à partir des bases de test (exigences, spécifications).
- **Conception** : créer les cas de test, identifier les données de test, concevoir l'environnement.
- **Implémentation** : préparer les scripts, les suites de test, l'environnement de test.
- **Exécution** : exécuter les tests, comparer résultats obtenus vs attendus, enregistrer les anomalies.
- **Clôture** : rapports de synthèse, leçons apprises, archivage des testware.

### 1.5 Compétences essentielles du testeur
- Esprit critique, curiosité, attention aux détails, communication, pensée analytique.
- Le testeur apporte une perspective **indépendante** du développeur.
- L'indépendance du test varie : auto-test (faible) → équipe dédiée (modérée) → externe (forte).
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAPITRE 2 — TESTER DANS LE CYCLE DE VIE DU DÉVELOPPEMENT LOGICIEL (FL-2)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CH2_CYCLE_DE_VIE = `
## ISTQB — Chapitre 2 : Le test dans le cycle de vie

### 2.1 Le test dans le contexte du SDLC
- Chaque modèle SDLC (séquentiel, itératif, incrémental, Agile) nécessite une adaptation du test.
- **Shift-left** : intégrer le test le plus tôt possible (revues d'exigences, TDD, BDD).
- Bonnes pratiques SDLC :
  - Chaque activité de développement a une activité de test correspondante.
  - Chaque niveau de test a des objectifs spécifiques.
  - L'analyse et la conception des tests commencent pendant l'activité de développement correspondante.

### 2.2 Niveaux de test
| Niveau | Objectif | Base de test | Responsable |
|--------|----------|-------------|-------------|
| **Composant (unitaire)** | Tester les composants isolément | Code, conception détaillée | Développeur |
| **Intégration de composants** | Tester les interfaces entre composants | Architecture, flux de données | Développeur / Testeur |
| **Système** | Tester le système complet dans un environnement représentatif | Exigences système, cas d'utilisation | Testeur QA |
| **Intégration de systèmes** | Tester les interactions entre systèmes | Interfaces, protocoles, APIs | Testeur QA |
| **Acceptation** | Valider que le système répond aux besoins métier | Besoins utilisateur, critères d'acceptation | Client / PO / Utilisateurs |

Sous-types d'acceptation :
- **UAT** (User Acceptance Testing) — validation par l'utilisateur final.
- **OAT** (Operational Acceptance Testing) — backup, migration, reprise après incident.
- **Alpha** : par les utilisateurs dans l'environnement de développement.
- **Beta** : par les utilisateurs dans leur propre environnement.

### 2.3 Types de test
| Type | Ce qu'on teste | Exemples |
|------|---------------|----------|
| **Fonctionnel** | Ce que le système fait (comportement) | Validation de formulaire, calculs, workflows |
| **Non-fonctionnel** | Comment le système fonctionne (qualité) | Performance, sécurité, utilisabilité, accessibilité |
| **Boîte noire** | Basé sur les spécifications, sans voir le code | Partitions d'équivalence, valeurs limites |
| **Boîte blanche** | Basé sur la structure interne du code | Couverture d'instructions, de branches |
| **Lié aux changements** | Après modification | Test de confirmation (re-test), test de régression |
| **Test de confirmation** | Vérifier que le défaut corrigé est bien résolu | Re-exécuter le test qui a échoué |
| **Test de régression** | Vérifier que les changements n'ont pas cassé autre chose | Suite de régression automatisée |

### 2.4 Test de maintenance
- Déclenché par : modifications, migrations, retrait du système.
- Analyse d'impact nécessaire pour déterminer l'étendue des tests de régression.
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAPITRE 3 — TESTS STATIQUES (FL-3)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CH3_TESTS_STATIQUES = `
## ISTQB — Chapitre 3 : Tests statiques

### 3.1 Test statique — Principes
- Le test statique examine les produits d'activité (exigences, code, plans de test) **sans exécuter le logiciel**.
- Trouve des défauts plus tôt et à moindre coût que le test dynamique.
- Types : revues manuelles et analyse statique automatisée (linters, analyseurs de code).

### 3.2 Processus de revue
Phases : Planification → Lancement → Revue individuelle → Discussion/Communication → Correction → Suivi.

Types de revues (du moins au plus formel) :
| Type | Formalisme | Animateur | Objectif |
|------|-----------|-----------|----------|
| **Revue informelle** | Aucun | Non | Détection rapide de défauts |
| **Walkthrough** | Faible | Auteur | Partage de connaissances |
| **Revue technique** | Modéré | Animateur formé | Consensus technique, défauts |
| **Inspection** | Élevé | Animateur formé + métriques | Défauts, amélioration processus |

### 3.3 Ce que le test statique détecte
- Exigences ambiguës, incomplètes, contradictoires.
- Défauts de conception : couplage excessif, mauvaise modularité.
- Défauts de code : variables non initialisées, code mort, violations de standards.
- Écarts par rapport aux standards et conventions de codage.
- Vulnérabilités de sécurité identifiables sans exécution.
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAPITRE 4 — TECHNIQUES DE TEST (FL-4)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CH4_TECHNIQUES = `
## ISTQB — Chapitre 4 : Techniques de test

### 4.1 Techniques boîte noire (basées sur les spécifications)

#### Partitions d'équivalence (EP)
- Diviser les données d'entrée en partitions traitées de manière identique.
- Tester au moins 1 valeur par partition (valide et invalide).
- Réduit le nombre de cas de test tout en couvrant le domaine.
- Exemple : champ âge [0-17] mineur, [18-65] adulte, [66+] senior, [<0] invalide.

#### Analyse des valeurs limites (BVA)
- Tester aux frontières des partitions (valeur limite, limite ± 1).
- Les défauts se concentrent aux limites des plages.
- Deux approches : 2 valeurs par frontière (à la limite, juste au-delà) ou 3 valeurs (limite-1, limite, limite+1).
- Exemple : pour [1-99], tester 0, 1, 99, 100.

#### Tables de décision (DT)
- Pour les combinaisons de conditions menant à des actions différentes.
- Chaque colonne = une règle (combinaison de conditions → actions).
- Réduit les combinaisons en éliminant les règles impossibles.
- Idéal pour : logique métier complexe, règles d'éligibilité, tarification.

#### Transition d'états (ST)
- Modélise le comportement du système comme des états et des transitions déclenchées par des événements.
- Diagramme d'états + table de transition.
- Couvre : transitions valides (le système change d'état correctement) et transitions invalides (le système rejette les événements non autorisés dans un état donné).
- Idéal pour : workflows Jira, processus de commande, authentification (verrouillage après N tentatives).

#### Test par paires (Pairwise / Combinatorial)
- Réduit les combinaisons en couvrant toutes les paires de paramètres.
- Détecte les défauts causés par l'interaction de 2 facteurs (la majorité).

### 4.2 Techniques boîte blanche (basées sur la structure)

#### Couverture d'instructions (Statement Coverage)
- Chaque instruction du code exécutée au moins une fois.
- Métrique : (instructions exécutées / total instructions) × 100%.
- Minimum : 100% de couverture d'instructions.

#### Couverture de branches (Branch Coverage)
- Chaque branche (vrai/faux) de chaque décision exécutée au moins une fois.
- Plus forte que la couverture d'instructions (100% branches → 100% instructions, mais pas l'inverse).
- Métrique : (branches exécutées / total branches) × 100%.

### 4.3 Techniques basées sur l'expérience

#### Estimation d'erreurs (Error Guessing)
- Anticiper les défauts basés sur l'expérience du testeur.
- Checklist : valeurs nulles/vides, division par zéro, caractères spéciaux, limites de taille, injection SQL/XSS, timeouts.

#### Test exploratoire
- Conception et exécution simultanées, guidées par une charte de test.
- Sessions timeboxées (60-120 min) avec objectif précis.
- Complète les tests scriptés en trouvant des défauts non anticipés.
- Particulièrement utile quand la spécification est insuffisante ou le temps limité.

#### Test basé sur des checklists
- Les tests sont dérivés d'une checklist de conditions à vérifier.
- Couvre les aspects critiques connus (sécurité, accessibilité, performance).

### 4.4 Approche de test collaborative
- Rédaction collaborative de user stories avec critères d'acceptation.
- ATDD (Acceptance Test-Driven Development) : tests d'acceptation écrits avant le code.
- BDD (Behavior-Driven Development) : Given/When/Then — le format Gherkin.
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAPITRE 5 — GESTION DES TESTS (FL-5)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CH5_GESTION = `
## ISTQB — Chapitre 5 : Gestion des tests

### 5.1 Planification des tests
- **Plan de test** : document décrivant périmètre, objectifs, approche, ressources, planning, critères d'entrée/sortie.
- **Stratégie de test** : approche organisationnelle du test (analytique, basée sur les risques, méthodique, réactive, consultative).
- Critères d'entrée : conditions pour commencer le test (environnement prêt, testware disponible, code compilé).
- Critères de sortie : conditions pour arrêter le test (couverture atteinte, densité de défauts acceptable, délai).

### 5.2 Estimation de l'effort de test
Techniques d'estimation :
- **Basée sur les métriques** : utiliser les données historiques de projets similaires.
- **Basée sur l'expertise** : jugement d'experts (Wideband Delphi, Planning Poker).
- Facteurs influençant : complexité du produit, qualité du processus de dev, compétences de l'équipe, pression des délais.

### 5.3 Pilotage et contrôle des tests
Métriques de test essentielles :
| Métrique | Ce qu'elle mesure |
|----------|------------------|
| **Taux d'exécution** | % de cas de test exécutés vs planifiés |
| **Taux de réussite** | % PASS / total exécutés |
| **Densité de défauts** | Nombre de défauts / taille du module (KLOC, points de fonction) |
| **Taux de détection** | Défauts trouvés en test / total défauts (y compris production) |
| **Couverture des exigences** | % d'exigences couvertes par au moins 1 cas de test |
| **Couverture du code** | % d'instructions ou branches exécutées |
| **Coût de correction** | Coût moyen de correction par défaut selon la phase de détection |

Reporting :
- **Rapport d'avancement** : état actuel des tests (en cours).
- **Rapport de synthèse** : bilan final, décision go/no-go.

### 5.4 Gestion de la configuration
- Versioning des éléments de test (cas de test, scripts, données).
- Traçabilité : exigence → cas de test → exécution → défaut.

### 5.5 Gestion des défauts
Cycle de vie d'un défaut :
1. **Nouveau** → 2. **Ouvert/Assigné** → 3. **En correction** → 4. **Corrigé** → 5. **Re-testé** → 6. **Fermé** (ou Rejeté/Différé)

Rapport de défaut (contenu minimum) :
- Identifiant unique, titre, description, étapes de reproduction.
- Résultat attendu vs résultat obtenu.
- Sévérité (impact technique), priorité (urgence métier).
- Environnement, version, composant affecté.
- Preuves : captures d'écran, logs, vidéos.

### 5.6 Test basé sur les risques
Risque = Probabilité × Impact.

Types de risques :
- **Risques produit** : le logiciel ne fait pas ce qu'il devrait (fonctionnel, performance, sécurité).
- **Risques projet** : menaces sur le planning, budget, ressources, périmètre.

Processus :
1. **Identification** des risques (ateliers, checklists, historique).
2. **Évaluation** : probabilité + impact → niveau de risque.
3. **Atténuation** : prioriser les tests sur les zones à risque élevé.

Matrice de risques :
| Impact \\ Probabilité | Haute | Moyenne | Faible |
|---|---|---|---|
| **Élevé** | Critique | Majeur | Modéré |
| **Moyen** | Majeur | Modéré | Mineur |
| **Faible** | Modéré | Mineur | Négligeable |
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHAPITRE 6 — OUTILS DE TEST (FL-6)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CH6_OUTILS = `
## ISTQB — Chapitre 6 : Outils de test

### 6.1 Catégories d'outils de test
| Catégorie | Exemples | Usage |
|-----------|----------|-------|
| **Gestion des tests** | Jira + Xray, TestRail, Zephyr | Planification, traçabilité, reporting |
| **Test statique** | ESLint, SonarQube, PMD | Analyse de code sans exécution |
| **Conception de tests** | Outils de modélisation, générateurs pairwise | Génération de cas de test |
| **Exécution de tests UI** | Playwright, Selenium, Cypress, Appium | Automatisation des tests UI web/mobile |
| **Exécution de tests API** | Postman/Newman, REST Assured, SoapUI | Tests d'endpoints, contrats API |
| **Performance** | k6, JMeter, Gatling, Artillery | Tests de charge, stress, endurance |
| **CI/CD** | Jenkins, GitHub Actions, GitLab CI | Intégration continue des tests |
| **Couverture** | Istanbul/nyc, JaCoCo | Mesure de couverture de code |
| **Monitoring** | Grafana, Datadog, New Relic | Surveillance en production |

### 6.2 Choix de l'outil selon le contexte
Critères de sélection :
- **Type de test** : UI → Playwright/Appium, API → Postman/Newman, Performance → k6
- **Technologie cible** : Web → Playwright, Mobile natif → Appium, API REST → Postman
- **Niveau de test** : Composant → framework de test unitaire, Système → Playwright/Postman, Acceptation → BDD
- **Compétences de l'équipe** : complexité de l'outil vs courbe d'apprentissage
- **Intégration CI/CD** : compatibilité avec la pipeline existante
- **Coût** : open-source vs commercial

### 6.3 Avantages de l'automatisation des tests
- Exécution rapide et répétable (régression, smoke tests).
- Feedback immédiat dans la CI/CD.
- Couverture accrue avec le même effort.
- Réduction des erreurs humaines (tests scriptés = reproductibles).
- Libère du temps pour le test exploratoire (à valeur ajoutée humaine).

### 6.4 Risques de l'automatisation
- Attentes irréalistes (tout automatiser n'est ni possible ni souhaitable).
- Sous-estimation de l'effort de maintenance des scripts.
- Faux sentiment de sécurité si les tests ne couvrent pas les bons risques.
- Scripts fragiles (dépendants de l'UI, sélecteurs instables).

### 6.5 Sélection de l'outil dans AbyQA
| Besoin | Outil recommandé | Justification ISTQB |
|--------|-----------------|---------------------|
| Test UI web (E2E) | **Playwright** | Multi-navigateur, auto-wait, CI-friendly, parallélisme natif |
| Test API REST | **Postman / Newman** | Collections réutilisables, assertions intégrées, environnements variables |
| Test mobile natif | **Appium** | Cross-platform (iOS/Android), compatible Selenium WebDriver |
| Audit CSS/visuel | **Playwright** (screenshots) | Comparaison pixel-perfect cross-browser |
| Régression | **Playwright + Postman** | Suites automatisées dans CI/CD |
| Exploratoire | **Manuel** | Créativité humaine, scénarios non anticipés |
| Performance API | **Postman + k6** | Montée en charge, temps de réponse |
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GLOSSAIRE ISTQB — Termes clés
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const GLOSSAIRE = `
## ISTQB — Glossaire des termes clés

| Terme | Définition |
|-------|-----------|
| **Erreur (error)** | Action humaine produisant un résultat incorrect (le développeur se trompe) |
| **Défaut (defect/bug)** | Imperfection dans un produit d'activité (le code contient un bug) |
| **Défaillance (failure)** | Le système ne fait pas ce qu'il devrait en exécution (le bug se manifeste) |
| **Cause racine (root cause)** | Raison fondamentale du défaut (processus, compétence, outil) |
| **Base de test** | Documents à partir desquels les tests sont dérivés (exigences, specs, user stories) |
| **Testware** | Tous les artefacts de test (cas de test, scripts, données, rapports) |
| **Condition de test** | Aspect testable d'un composant (dérivé de la base de test) |
| **Cas de test** | Ensemble de préconditions, entrées, actions, résultats attendus |
| **Traçabilité** | Lien entre exigences, cas de test, exécutions et défauts |
| **Oracle de test** | Source permettant de déterminer le résultat attendu |
| **Régression** | Défaut introduit par un changement dans une zone précédemment fonctionnelle |
| **Faux positif** | Test qui signale un défaut alors qu'il n'y en a pas |
| **Faux négatif** | Test qui ne détecte pas un défaut existant |
| **Couverture** | Degré auquel un élément a été exercé par des tests (en %) |
| **Critère d'entrée** | Condition préalable pour démarrer une activité de test |
| **Critère de sortie** | Condition pour considérer une activité de test comme terminée |
| **Shift-left** | Démarrer les activités de test plus tôt dans le cycle de vie |
| **Smoke test** | Sous-ensemble de tests vérifiant les fonctionnalités essentielles après un déploiement |
| **Sanity test** | Sous-ensemble ciblé vérifiant qu'un correctif/changement spécifique fonctionne |
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTS — Modules par chapitre + combinaisons prêtes à injecter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Connaissance complète (pour le cerveau IA et le chat)
const FOUNDATION_FULL = [
  "# RÉFÉRENTIEL ISTQB FOUNDATION LEVEL v4.0",
  "Tu appliques systématiquement les principes, techniques et terminologie ISTQB dans toutes tes réponses QA.\n",
  CH1_FONDAMENTAUX,
  CH2_CYCLE_DE_VIE,
  CH3_TESTS_STATIQUES,
  CH4_TECHNIQUES,
  CH5_GESTION,
  CH6_OUTILS,
  GLOSSAIRE
].join("\n");

// Sous-ensembles adaptés par agent
const FOR_ROUTER = [
  "# RÉFÉRENTIEL ISTQB — Contexte de routage",
  "Utilise ces connaissances pour choisir le bon agent et le bon outil de test.\n",
  CH2_CYCLE_DE_VIE,
  CH6_OUTILS
].join("\n");

const FOR_GENERATION = [
  "# RÉFÉRENTIEL ISTQB — Génération de tickets",
  "Applique ces techniques pour générer des tickets de qualité professionnelle.\n",
  CH4_TECHNIQUES,
  CH5_GESTION,
  GLOSSAIRE
].join("\n");

const FOR_REPORTER = [
  "# RÉFÉRENTIEL ISTQB — Reporting QA",
  "Utilise ces métriques et cette terminologie dans les rapports.\n",
  CH5_GESTION,
  GLOSSAIRE
].join("\n");

const FOR_DRUPAL = [
  "# RÉFÉRENTIEL ISTQB — Données de test",
  "Applique ces principes pour générer des données de test pertinentes.\n",
  CH4_TECHNIQUES
].join("\n");

module.exports = {
  // Chapitres individuels
  ch1: CH1_FONDAMENTAUX,
  ch2: CH2_CYCLE_DE_VIE,
  ch3: CH3_TESTS_STATIQUES,
  ch4: CH4_TECHNIQUES,
  ch5: CH5_GESTION,
  ch6: CH6_OUTILS,
  glossaire: GLOSSAIRE,

  // Packs prêts à injecter dans les system prompts
  foundation: FOUNDATION_FULL,     // agent-lead-qa.js + chat Aby
  forRouter: FOR_ROUTER,           // agent-router.js
  forGeneration: FOR_GENERATION,   // agent.js + /api/ops-generate
  forReporter: FOR_REPORTER,       // agent-reporter.js
  forDrupal: FOR_DRUPAL            // agent-drupal.js
};
