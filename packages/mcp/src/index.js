#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { exec } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import * as z from 'zod/v4'

import { HubBridge } from './hub-bridge.js'

const env = process.env
const port = parseInt(env.PORT || '38401')
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const bridgeToken = env.PAGE_AGENT_BRIDGE_TOKEN || randomBytes(24).toString('base64url')

/** @type {Record<string, string>} */
const apiLlmConfig = {}
if (env.LLM_BASE_URL) apiLlmConfig.baseURL = env.LLM_BASE_URL
if (env.LLM_MODEL_NAME) apiLlmConfig.model = env.LLM_MODEL_NAME
if (env.LLM_API_KEY) apiLlmConfig.apiKey = env.LLM_API_KEY

const browserLlmConfig = {
	baseURL: `http://localhost:${port}/v1`,
	model: 'chatgpt-web',
	apiKey: bridgeToken,
}
const useApiLlm = env.PAGE_AGENT_LLM_MODE === 'api'
if (useApiLlm && (!apiLlmConfig.baseURL || !apiLlmConfig.model)) {
	throw new Error('PAGE_AGENT_LLM_MODE=api requires LLM_BASE_URL and LLM_MODEL_NAME.')
}
const defaultConfig = useApiLlm ? apiLlmConfig : browserLlmConfig

// --- Hub bridge (HTTP + WebSocket + ChatGPT web LLM) ---

const hub = new HubBridge(port, { bridgeToken, defaultConfig })
await hub.start()
console.error(`[page-agent-mcp] Userscript bridge token: ${bridgeToken}`)
console.error(
	useApiLlm
		? '[page-agent-mcp] LLM mode: OpenAI-compatible API'
		: '[page-agent-mcp] LLM mode: ChatGPT web userscript'
)

// Open launcher in default browser
const url = `http://localhost:${port}`
const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start ""' : 'xdg-open'
exec(`${cmd} "${url}"`, (err) => {
	if (err) console.error(`[page-agent-mcp] Could not open browser: ${err.message}`)
})

// --- MCP server (stdio) ---

const mcpServer = new McpServer({ name: 'page-agent', version })

mcpServer.registerTool(
	'execute_task',
	{
		description: "Execute a task in user's browser.",
		inputSchema: {
			task: z
				.string()
				.describe(
					'Task description. Give specific instructions for the task. Steps preferable. And the information you want to get after the task is done.'
				),
		},
	},
	async ({ task }) => {
		try {
			const result = await hub.executeTask(task, defaultConfig)
			return {
				content: [
					{
						type: 'text',
						text: result.success
							? `Task completed.\n\n${result.data}`
							: `Task failed.\n\n${result.data}`,
					},
				],
			}
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Error: ${err.message}` }],
				isError: true,
			}
		}
	}
)

mcpServer.registerTool(
	'get_status',
	{
		description: 'Check the current status of the Page Agent hub.',
	},
	async () => ({
		content: [
			{
				type: 'text',
				text: JSON.stringify({ connected: hub.connected, busy: hub.busy }, null, 2),
			},
		],
	})
)

mcpServer.registerTool(
	'stop_task',
	{
		description: 'Stop the currently running browser automation task.',
	},
	async () => {
		hub.stopTask()
		return { content: [{ type: 'text', text: 'Stop signal sent.' }] }
	}
)

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error('[page-agent-mcp] MCP server ready (stdio)')
