# ChatGPT web userscript bridge

This patch reuses `@page-agent/mcp`'s existing localhost process. It adds a token-protected task API and an OpenAI-compatible local endpoint whose requests are answered by a logged-in ChatGPT web tab through ScriptCat. Page Agent therefore needs no model API key.

## 1. Start the patched Page Agent MCP process

Use one stable local token:

```powershell
$env:PAGE_AGENT_BRIDGE_TOKEN = "replace-with-a-long-random-string"
node packages/mcp/src/index.js
```

Or, after publishing/installing the fork:

```powershell
$env:PAGE_AGENT_BRIDGE_TOKEN = "replace-with-a-long-random-string"
npx -y @page-agent/mcp
```

The default LLM configuration sent to the Page Agent extension is:

```json
{
  "baseURL": "http://localhost:38401/v1",
  "model": "chatgpt-web",
  "apiKey": "PAGE_AGENT_BRIDGE_TOKEN"
}
```

The API-key provider path remains available only when explicitly started with `PAGE_AGENT_LLM_MODE=api` plus the existing `LLM_BASE_URL`, `LLM_MODEL_NAME`, and optional `LLM_API_KEY` variables.

## 2. Install and arm the ScriptCat userscript

Install `userscripts/chatgpt-page-agent.user.js` in ScriptCat.

In the userscript menu:

1. Choose **Configure Page Agent token** and paste `PAGE_AGENT_BRIDGE_TOKEN`.
2. Choose **Enable ChatGPT-web LLM in this tab**. This tab now answers Page Agent's internal tool-selection requests through the ChatGPT webpage.
3. Choose **Enable automatic command execution** when this chat is dedicated to automation.

The same tab can be both controller and LLM provider. A separate dedicated provider chat is cleaner for manual use, but is not required.

## 3. Command protocol

Tell ChatGPT or a ChatGPT Automation to emit an exact code block whenever it wants Page Agent to act:

```text
PAGE_AGENT/1
{"id":"open-settings-1","task":"Open the settings page, report the current language, and do not change anything."}
```

The userscript executes each `id` once per loaded tab. Page Agent's internal LLM turns are routed back through ChatGPT web. When the task finishes, the userscript sends:

```text
PAGE_AGENT_RESULT/1
{"id":"open-settings-1","success":true,"data":"The current language is English."}
```

Use this instruction in the controlling ChatGPT Automation:

```text
When browser interaction is required, output only a PAGE_AGENT/1 code block containing one JSON object with a unique id and a precise task. After receiving PAGE_AGENT_RESULT/1, continue from that result. Do not claim the browser action occurred before the result arrives.
```

## Local endpoints

All endpoints require `Authorization: Bearer <PAGE_AGENT_BRIDGE_TOKEN>`.

- `GET /api/status`
- `POST /api/execute` with `{"task":"..."}`
- `POST /api/stop`
- `GET /api/llm/next?wait=25000`
- `POST /api/llm/:id/respond`
- `POST /api/llm/:id/error`
- `POST /v1/chat/completions` — used by Page Agent's existing OpenAI-compatible client

## Present boundary

The bridge itself is complete, but the final browser acceptance test requires the local Chrome/ScriptCat/Page Agent extension environment. A scheduled ChatGPT Automation also cannot wake a closed local browser: the MCP process, Page Agent hub, and a ChatGPT tab with **ChatGPT-web LLM in this tab** enabled must remain running.
