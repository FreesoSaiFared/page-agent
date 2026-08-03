#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const EXT_ID = 'akldabonmimlicnjlflnapfeklbfemhj'
const STORE_URL = `https://chromewebstore.google.com/detail/page-agent-ext/${EXT_ID}`
const LOOPBACK_HOST = 'localhost'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const LLM_JOB_TIMEOUT_MS = 10 * 60 * 1000

const launcherTemplate = readFileSync(
	fileURLToPath(new URL('./launcher.html', import.meta.url)),
	'utf-8'
)

/**
 * HTTP + WebSocket bridge to the hub.html extension tab.
 * - HTTP serves the launcher page (triggers extension to open hub)
 * - REST lets a local userscript execute/status/stop tasks
 * - /v1/chat/completions turns a ChatGPT web tab into Page Agent's LLM
 * - WS carries execute/stop commands and result/error responses
 */
export class HubBridge {
	/** @type {number} */
	port

	/** @type {string} */
	bridgeToken

	/** @type {Record<string, unknown> | undefined} */
	defaultConfig

	/** @type {http.Server} */
	#httpServer

	/** @type {WebSocketServer} */
	#wss

	/** @type {import('ws').WebSocket | null} */
	#hub = null

	/** @type {{ resolve: (r: {success: boolean, data: string}) => void, reject: (e: Error) => void } | null} */
	#pendingTask = null

	/** @type {Array<{ id: string, request: Record<string, unknown> }>} */
	#llmQueue = []

	/** @type {Map<string, { request: Record<string, unknown>, resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
	#llmPending = new Map()

	/** @type {Array<{ resolve: (job: { id: string, request: Record<string, unknown> } | null) => void, timer: NodeJS.Timeout }>} */
	#llmWaiters = []

	/**
	 * @param {number} port
	 * @param {{ bridgeToken?: string, defaultConfig?: Record<string, unknown> }} [options]
	 */
	constructor(port, options = {}) {
		this.port = port
		this.bridgeToken = options.bridgeToken ?? ''
		this.defaultConfig = options.defaultConfig
		this.#httpServer = http.createServer((req, res) => {
			void this.#handleHttp(req, res).catch((err) => {
				console.error(`[page-agent-mcp] HTTP error: ${err.message}`)
				if (!res.headersSent) this.#sendJson(res, 500, { error: err.message })
				else res.end()
			})
		})
		this.#wss = new WebSocketServer({ server: this.#httpServer })
		this.#wss.on('connection', (ws) => this.#onConnection(ws))
	}

	/** @returns {Promise<void>} */
	async start() {
		return new Promise((resolve, reject) => {
			this.#httpServer.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
				if (err.code === 'EADDRINUSE') {
					reject(
						new Error(`Port ${this.port} is in use. Another Page Agent MCP server may be running.`)
					)
				} else {
					reject(err)
				}
			})
			this.#httpServer.listen(this.port, LOOPBACK_HOST, () => {
				console.error(`[page-agent-mcp] HTTP + WS on http://${LOOPBACK_HOST}:${this.port}`)
				resolve()
			})
		})
	}

	get connected() {
		return this.#hub?.readyState === 1
	}

	get busy() {
		return this.#pendingTask !== null
	}

	/**
	 * @param {string} task
	 * @param {Record<string, unknown>} [config]
	 * @returns {Promise<{success: boolean, data: string}>}
	 */
	async executeTask(task, config) {
		if (!this.connected) throw new Error('Hub is not connected. Is the extension running?')
		if (this.#pendingTask) throw new Error('Agent is already running a task.')

		return new Promise((resolve, reject) => {
			this.#pendingTask = { resolve, reject }
			this.#hub.send(JSON.stringify({ type: 'execute', task, config }))
		})
	}

	stopTask() {
		if (this.connected) {
			this.#hub.send(JSON.stringify({ type: 'stop' }))
		}
	}

	/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
	async #handleHttp(req, res) {
		const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${this.port}`)
		const isBridgeRequest =
			url.pathname.startsWith('/api/') || url.pathname === '/v1/chat/completions'
		if (!isBridgeRequest) {
			const html = launcherTemplate
				.replaceAll('__EXT_ID__', EXT_ID)
				.replaceAll('__STORE_URL__', STORE_URL)
				.replaceAll('__WS_PORT__', String(this.port))
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(html)
			return
		}

		this.#setCors(res)
		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			res.end()
			return
		}
		if (!this.#isAuthorized(req)) {
			this.#sendJson(res, 401, { error: 'Invalid or missing Page Agent bridge token.' })
			return
		}

		if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
			const body = await this.#readJson(req)
			if (!Array.isArray(body.messages) || !Array.isArray(body.tools)) {
				this.#sendOpenAiError(res, 400, 'Expected messages and tools arrays.')
				return
			}
			try {
				const result = await this.#enqueueLlmRequest(body)
				this.#sendJson(res, 200, result)
			} catch (err) {
				this.#sendOpenAiError(res, 502, err instanceof Error ? err.message : String(err))
			}
			return
		}

		if (req.method === 'GET' && url.pathname === '/api/status') {
			this.#sendJson(res, 200, {
				connected: this.connected,
				busy: this.busy,
				llmQueued: this.#llmQueue.length,
				llmPending: this.#llmPending.size,
			})
			return
		}
		if (req.method === 'POST' && url.pathname === '/api/stop') {
			this.stopTask()
			this.#sendJson(res, 200, { ok: true })
			return
		}
		if (req.method === 'POST' && url.pathname === '/api/execute') {
			const body = await this.#readJson(req)
			const task = typeof body.task === 'string' ? body.task.trim() : ''
			if (!task) {
				this.#sendJson(res, 400, { error: 'Expected a non-empty string field named task.' })
				return
			}
			const config =
				body.config && typeof body.config === 'object' ? body.config : this.defaultConfig
			try {
				const result = await this.executeTask(task, config)
				this.#sendJson(res, 200, result)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				const status = message.includes('not connected') ? 503 : message.includes('already running') ? 409 : 500
				this.#sendJson(res, status, { error: message })
			}
			return
		}
		if (req.method === 'GET' && url.pathname === '/api/llm/next') {
			const requestedWait = Number(url.searchParams.get('wait') ?? 25000)
			const waitMs = Math.min(Math.max(Number.isFinite(requestedWait) ? requestedWait : 25000, 0), 30000)
			const job = await this.#nextLlmJob(waitMs)
			if (!job) {
				res.writeHead(204)
				res.end()
			} else {
				this.#sendJson(res, 200, job)
			}
			return
		}

		const llmResultMatch = url.pathname.match(/^\/api\/llm\/([^/]+)\/(respond|error)$/)
		if (req.method === 'POST' && llmResultMatch) {
			const id = decodeURIComponent(llmResultMatch[1])
			const body = await this.#readJson(req)
			if (llmResultMatch[2] === 'respond') {
				try {
					this.#resolveLlmJob(id, body)
					this.#sendJson(res, 200, { ok: true })
				} catch (err) {
					this.#sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
				}
			} else {
				const message = typeof body.error === 'string' ? body.error : 'ChatGPT web provider failed.'
				if (!this.#rejectLlmJob(id, new Error(message))) {
					this.#sendJson(res, 404, { error: 'Unknown or expired LLM job.' })
				} else {
					this.#sendJson(res, 200, { ok: true })
				}
			}
			return
		}

		this.#sendJson(res, 404, { error: 'Unknown Page Agent bridge endpoint.' })
	}

	/** @param {Record<string, unknown>} request */
	#enqueueLlmRequest(request) {
		const id = randomUUID()
		const job = { id, request }
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#rejectLlmJob(id, new Error('Timed out waiting for the ChatGPT web provider.'))
			}, LLM_JOB_TIMEOUT_MS)
			this.#llmPending.set(id, { request, resolve, reject, timer })

			const waiter = this.#llmWaiters.shift()
			if (waiter) {
				clearTimeout(waiter.timer)
				waiter.resolve(job)
			} else {
				this.#llmQueue.push(job)
			}
		})
	}

	/** @param {number} waitMs */
	#nextLlmJob(waitMs) {
		const queued = this.#llmQueue.shift()
		if (queued) return Promise.resolve(queued)
		if (waitMs === 0) return Promise.resolve(null)

		return new Promise((resolve) => {
			const waiter = {
				resolve,
				timer: setTimeout(() => {
					const index = this.#llmWaiters.indexOf(waiter)
					if (index >= 0) this.#llmWaiters.splice(index, 1)
					resolve(null)
				}, waitMs),
			}
			this.#llmWaiters.push(waiter)
		})
	}

	/** @param {string} id @param {Record<string, unknown>} response */
	#resolveLlmJob(id, response) {
		const pending = this.#llmPending.get(id)
		if (!pending) throw new Error('Unknown or expired LLM job.')

		const name = typeof response.name === 'string' ? response.name : ''
		const args = response.args
		const tools = Array.isArray(pending.request.tools) ? pending.request.tools : []
		const allowedNames = tools
			.map((tool) => tool?.function?.name)
			.filter((toolName) => typeof toolName === 'string')
		if (!name || !allowedNames.includes(name)) {
			throw new Error(`Expected one of these tool names: ${allowedNames.join(', ')}`)
		}

		clearTimeout(pending.timer)
		this.#llmPending.delete(id)
		const argumentString = typeof args === 'string' ? args : JSON.stringify(args ?? {})
		pending.resolve({
			id: `chatgpt-web-${id}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: 'chatgpt-web',
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: null,
						tool_calls: [
							{
								id: `call_${id.replaceAll('-', '').slice(0, 24)}`,
								type: 'function',
								function: { name, arguments: argumentString },
							},
						],
					},
					finish_reason: 'tool_calls',
				},
			],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		})
	}

	/** @param {string} id @param {Error} error */
	#rejectLlmJob(id, error) {
		const pending = this.#llmPending.get(id)
		if (!pending) return false
		clearTimeout(pending.timer)
		this.#llmPending.delete(id)
		const queueIndex = this.#llmQueue.findIndex((job) => job.id === id)
		if (queueIndex >= 0) this.#llmQueue.splice(queueIndex, 1)
		pending.reject(error)
		return true
	}

	/** @param {http.IncomingMessage} req */
	#isAuthorized(req) {
		return Boolean(
			this.bridgeToken && req.headers.authorization === `Bearer ${this.bridgeToken}`
		)
	}

	/** @param {http.ServerResponse} res */
	#setCors(res) {
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	}

	/** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
	#sendJson(res, status, body) {
		this.#setCors(res)
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
		res.end(JSON.stringify(body))
	}

	/** @param {http.ServerResponse} res @param {number} status @param {string} message */
	#sendOpenAiError(res, status, message) {
		this.#sendJson(res, status, { error: { message, type: 'browser_provider_error' } })
	}

	/** @param {http.IncomingMessage} req @returns {Promise<Record<string, any>>} */
	async #readJson(req) {
		let size = 0
		const chunks = []
		for await (const chunk of req) {
			size += chunk.length
			if (size > MAX_REQUEST_BYTES) throw new Error('Request body is too large.')
			chunks.push(chunk)
		}
		if (chunks.length === 0) return {}
		try {
			const value = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
			return value && typeof value === 'object' ? value : {}
		} catch {
			throw new Error('Request body must be valid JSON.')
		}
	}

	// TODO: Add version checking

	/** @param {import('ws').WebSocket} ws */
	#onConnection(ws) {
		if (this.#hub && this.#hub.readyState === 1) {
			ws.close(4000, 'Another hub is already connected')
			return
		}

		this.#hub = ws
		console.error('[page-agent-mcp] Hub connected')

		ws.on('message', (/** @type {Buffer} */ rawData) => {
			/** @type {{ type: string, success?: boolean, data?: string, message?: string }} */
			let msg
			try {
				msg = JSON.parse(rawData.toString('utf-8'))
			} catch {
				return
			}

			if (msg.type === 'result') {
				this.#pendingTask?.resolve({ success: msg.success ?? false, data: msg.data ?? '' })
				this.#pendingTask = null
			} else if (msg.type === 'error') {
				this.#pendingTask?.reject(new Error(msg.message ?? 'Unknown error from hub'))
				this.#pendingTask = null
			}
		})

		ws.on('close', () => {
			console.error('[page-agent-mcp] Hub disconnected')
			if (this.#hub === ws) this.#hub = null
			if (this.#pendingTask) {
				this.#pendingTask.reject(new Error('Hub disconnected while task was running'))
				this.#pendingTask = null
			}
		})
	}
}
