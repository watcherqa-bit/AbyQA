# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AbyQA V2** is an AI-powered QA automation platform for Safran Group. It is a Node.js multi-agent system that integrates Playwright, Jira/Xray, Drupal, and a local Ollama LLM to automate testing, test management, and QA reporting.

## Commands

```bash
# Install dependencies
npm install

# Start the web dashboard (http://localhost:3210)
node agent-server.js

# Reconfigure all agents to use config.js/.env
node setup.js

# Run individual agents directly
node agent.js "<request>"                          # User story / bug / test intent detection
node agent-playwright-direct.js <mode> <source>   # Direct Playwright execution
node agent-xray-full.js                           # Full QA pipeline (Jira XML → Xray → Playwright)
node agent-jira-reader.js                         # Parse Jira XML exports
node agent-drupal.js                              # Generate Drupal test data
node agent-router.js "<request>"                  # LLM-based agent routing
node agent-reporter.js                            # Generate QA reports
node agent-matrix.js                              # Generate traceability matrix (Excel)
node agent-css-audit.js                           # Cross-browser visual/CSS audit
```

## Architecture

All agents are standalone CommonJS `.js` files. There is no bundler or build step.

### Configuration

- **`config.js`** — Central config module; reads `.env` and exports typed config objects for Jira, Drupal, environments, server, Ollama, Xray, and file paths. Use `config.required('KEY')` for mandatory values.
- **`.env`** — All secrets and environment settings (Jira host/token, Drupal credentials, env URLs, Ollama model, Xray version, output paths).

### Request Flow

```
Web Dashboard (agent-server.js :3210)
  → agent-router.js        LLM routes request to correct agent(s)
  → agent.js               Intent detection (US / BUG / TEST / CSV)
  → agent-jira-reader.js   Parses Jira XML, builds test plan
  → agent-playwright-direct.js  Runs browser tests
  → agent-xray-full.js     Creates/updates Xray test executions, uploads evidence
  → agent-drupal.js        Creates Drupal content for test data
  → agent-reporter.js      Aggregates results → release notes
```

Communication between server and browser UI uses **Server-Sent Events (SSE)** for live streaming output.

### Key Agents

| File | Role |
|---|---|
| `agent-server.js` | HTTP server + SSE dashboard on port 3210; orchestrates agents |
| `agent-router.js` | LLM-based routing via Ollama; fallback rule-based routing |
| `agent-xray-full.js` | End-to-end pipeline: Jira XML → Xray tests → Playwright → PASS/FAIL + bug creation |
| `agent-playwright-direct.js` | Playwright runner; modes: `ui`, `api`, `fix`, `tnr`; sources: `url`, `jira-key`, `xml`, `text` |
| `agent.js` | Intent detection for user stories, bugs, test cases; calls Ollama LLM |
| `agent-jira-reader.js` | Parses Jira XML exports; generates CSV matrices for Xray import |
| `agent-drupal.js` | Automates Drupal BO content creation (32 content types) across Sophie/Paulo environments |
| `agent-matrix.js` | Generates Excel traceability matrices from Jira release tickets |
| `setup.js` | Auto-patches all agent files to use `config.js` instead of hardcoded values |

### External Integrations

- **Jira Cloud** (`eurelis.atlassian.net`) — Issue creation, evidence attachment, REST API
- **Xray** — Test plan/execution creation, PASS/FAIL updates (Jira plugin)
- **Drupal BO** — Two staging environments: Sophie and Paulo (`DRUPAL_SOPHIE_URL`, `DRUPAL_PAULO_URL`)
- **Ollama** — Local LLM at `127.0.0.1:11434`, default model `llama3`; used for routing and intent analysis
- **Playwright 1.58.2** — Cross-browser automation; login state persisted via `login-save-state.js`

### Output Directories

Configured via `.env` and `config.js`:
- `reports/` — Test reports and analytics
- `screenshots/` — Playwright evidence screenshots
- `uploads/` — Files attached to Jira tickets
- `errors/` — Error logs

### Node.js Compatibility

The codebase was written for older Node.js versions. Known issues fixed for Node.js v24:
- `process.stdout.setEncoding("utf8")` — removed from all agents (method no longer exists on Writable streams in v24)
- Literal newline characters inside double-quoted strings in `agent-xray-full.js` — replaced with `\n` escape sequences

### Code Conventions

- All agents use CommonJS (`require`/`module.exports`), not ES modules.
- Comments and variable names are primarily in **French** throughout the codebase.
- Agents stream output line-by-line to stdout; `agent-server.js` captures this via `child_process.spawn` and forwards it over SSE.
- Environment validation happens in `config.js` at startup — missing required vars throw immediately.
