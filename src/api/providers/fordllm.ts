import { Anthropic } from "@anthropic-ai/sdk"
import https from "node:https"
import type { ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"

const FORD_DEFAULT_TOKEN_URL =
	"https://login.microsoftonline.com/c990bb7a-51f4-439b-bd36-9c07fb1041c0/oauth2/v2.0/token"
const FORD_DEFAULT_CHAT_URL = "https://api.pivpn.core.ford.com/fordllmapi/api/v1/chat/completions"
const FORD_DEFAULT_SCOPE = "api://6af47983-2540-43ae-89ff-4b93bf4eeb33/.default"
const FORD_DEFAULT_MODEL = "gemini-2.5-pro"

// Maximum context size (conservative limit to avoid 413 errors)
const MAX_CONTEXT_SIZE_BYTES = 100 * 1024 // 100KB

interface FordTokenResponse {
	access_token: string
	token_type: string
	expires_in: number
}

interface FordChatCompletionResponse {
	id: string
	choices: Array<{
		finish_reason: string
		index: number
		message: {
			role: string
			content: string
			tool_calls: null | any
		}
	}>
	created: number
	model: string
	object: string
	usage?: {
		completion_tokens: number
		prompt_tokens: number
		total_tokens: number
	}
}

export class FordLlmHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private readonly providerName = "FordLLM"

	// OAuth2 token cache
	private accessToken: string | null = null
	private tokenExpiresAt: number = 0

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
	}

	/**
	 * Get Ford access token using OAuth2 client_credentials flow.
	 * Caches the token and reuses it until expiry.
	 */
	private async getFordAccessToken(): Promise<string> {
		console.log("[FordLLM] getFordAccessToken: Starting OAuth token acquisition")

		// Return cached token if still valid (with 5min buffer)
		const now = Date.now() / 1000
		if (this.accessToken && this.tokenExpiresAt > now + 300) {
			console.log(
				"[FordLLM] getFordAccessToken: Using cached token (expires in",
				Math.round(this.tokenExpiresAt - now),
				"seconds)",
			)
			return this.accessToken
		}

		console.log("[FordLLM] getFordAccessToken: Cached token expired or not present, requesting new token")

		// Get configuration from VS Code settings or env vars
		const clientId = this.options.fordAiClientId || process.env.FORDLLM_CLIENT_ID || process.env.FORD_AI_CLIENT_ID
		const clientSecret =
			this.options.fordAiClientSecret || process.env.FORDLLM_CLIENT_SECRET || process.env.FORD_AI_CLIENT_SECRET
		const tokenUrl = this.options.fordAiTokenUrl || FORD_DEFAULT_TOKEN_URL
		const scope = this.options.fordAiScope || FORD_DEFAULT_SCOPE

		console.log("[FordLLM] getFordAccessToken: Token URL:", tokenUrl)
		console.log("[FordLLM] getFordAccessToken: Client ID:", clientId ? `${clientId.substring(0, 8)}...` : "MISSING")
		console.log("[FordLLM] getFordAccessToken: Client Secret:", clientSecret ? "***SET***" : "MISSING")
		console.log("[FordLLM] getFordAccessToken: Scope:", scope)

		if (!clientId || !clientSecret) {
			throw new Error(
				`Ford AI: Missing credentials. Please configure fordAi.clientId and fordAi.clientSecret in VS Code settings, or set FORDLLM_CLIENT_ID and FORDLLM_CLIENT_SECRET environment variables.`,
			)
		}

		// Build form-encoded body
		const params = new URLSearchParams({
			grant_type: "client_credentials",
			client_id: clientId,
			client_secret: clientSecret,
			scope,
		})

		try {
			console.log("[FordLLM] getFordAccessToken: Sending token request to", tokenUrl)

			// WORKAROUND: Node.js fetch may not trust Ford's SSL certificate
			// Temporarily disable SSL verification for this request
			// PROPER FIX: Set NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt before starting VS Code
			const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
			console.log("[FordLLM] getFordAccessToken: SSL verification disabled (workaround for certificate trust)")

			try {
				const response = await fetch(tokenUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: params.toString(),
				})

				// Restore SSL verification
				if (originalRejectUnauthorized !== undefined) {
					process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized
				} else {
					delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
				}

				console.log(
					"[FordLLM] getFordAccessToken: Token response status:",
					response.status,
					response.statusText,
				)

				if (!response.ok) {
					const errorText = await response.text()
					console.error("[FordLLM] getFordAccessToken: Token request failed with error:", errorText)
					throw new Error(
						`Ford AI: Failed to obtain access token (${response.status} ${response.statusText}). Check clientId/clientSecret/scope. Error: ${errorText}`,
					)
				}

				const data: FordTokenResponse = await response.json()

				if (!data.access_token) {
					console.error("[FordLLM] getFordAccessToken: No access_token in response")
					throw new Error("Ford AI: No access_token in response from token endpoint.")
				}

				// Cache the token
				this.accessToken = data.access_token
				this.tokenExpiresAt = now + data.expires_in

				console.log(
					"[FordLLM] getFordAccessToken: Successfully obtained token (length:",
					this.accessToken.length,
					", expires in",
					data.expires_in,
					"seconds)",
				)

				return this.accessToken
			} catch (innerError) {
				// Restore SSL verification on error
				if (originalRejectUnauthorized !== undefined) {
					process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized
				} else {
					delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
				}
				throw innerError
			}
		} catch (error) {
			console.error("[FordLLM] getFordAccessToken: Exception during token request:", error)

			// Log detailed error information to diagnose network issues
			if (error instanceof Error) {
				console.error("[FordLLM] getFordAccessToken: Error name:", (error as any).name)
				console.error("[FordLLM] getFordAccessToken: Error code:", (error as any).code)
				console.error("[FordLLM] getFordAccessToken: Error syscall:", (error as any).syscall)
				console.error("[FordLLM] getFordAccessToken: Error cause:", (error as any).cause)

				// If there's a cause, log its details too
				if ((error as any).cause) {
					const cause = (error as any).cause
					console.error("[FordLLM] getFordAccessToken: Cause type:", typeof cause)
					console.error("[FordLLM] getFordAccessToken: Cause message:", cause.message)
					console.error("[FordLLM] getFordAccessToken: Cause code:", cause.code)
					console.error("[FordLLM] getFordAccessToken: Cause syscall:", cause.syscall)
					console.error("[FordLLM] getFordAccessToken: Cause errno:", cause.errno)
				}

				throw new Error(`Ford AI: OAuth2 token request failed: ${error.message}`)
			}
			throw error
		}
	}

	/**
	 * Call Ford LLM chat completions endpoint.
	 */
	private async callFordAi(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
	): Promise<FordChatCompletionResponse> {
		console.log("[FordLLM] callFordAi: Starting chat API call")
		console.log("[FordLLM] callFordAi: System prompt length:", systemPrompt.length)
		console.log("[FordLLM] callFordAi: Messages count:", messages.length)

		const accessToken = await this.getFordAccessToken()
		console.log("[FordLLM] callFordAi: Access token obtained, length:", accessToken.length)

		const chatUrl = this.options.fordAiChatUrl || FORD_DEFAULT_CHAT_URL
		const modelName = this.options.fordAiModel || FORD_DEFAULT_MODEL

		console.log("[FordLLM] callFordAi: Chat URL:", chatUrl)
		console.log("[FordLLM] callFordAi: Model:", modelName)

		// Convert Anthropic messages to OpenAI format
		const openAiMessages = [
			{ role: "system" as const, content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		console.log("[FordLLM] callFordAi: Converted to", openAiMessages.length, "OpenAI messages")

		// Context size guardrail
		const requestBody = {
			model: modelName,
			messages: openAiMessages,
		}
		const requestSize = JSON.stringify(requestBody).length

		console.log("[FordLLM] callFordAi: Request body size:", requestSize, "bytes (max:", MAX_CONTEXT_SIZE_BYTES, ")")

		if (requestSize > MAX_CONTEXT_SIZE_BYTES) {
			throw new Error(
				`Ford AI: Context too large (${Math.round(requestSize / 1024)}KB). Try fewer files or a smaller prompt. Max: ${Math.round(MAX_CONTEXT_SIZE_BYTES / 1024)}KB.`,
			)
		}

		try {
			// WORKAROUND: Use https module instead of fetch to bypass undici's SSL handling
			// This allows us to directly control SSL certificate verification
			const data: FordChatCompletionResponse = await new Promise((resolve, reject) => {
				console.log("[FordLLM] callFordAi: Sending POST request to", chatUrl)
				console.log(
					"[FordLLM] callFordAi: Authorization header: Bearer [token length:",
					accessToken.length,
					"]",
				)
				console.log("[FordLLM] callFordAi: Using https module with rejectUnauthorized: false and proxy bypass")

				const url = new URL(chatUrl)
				const postData = JSON.stringify(requestBody)

				const options: https.RequestOptions = {
					hostname: url.hostname,
					port: url.port || 443,
					path: url.pathname + url.search,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(postData),
						Authorization: `Bearer ${accessToken}`,
					},
					// Disable SSL certificate verification (workaround for Ford internal cert)
					rejectUnauthorized: false,
					// Bypass corporate proxy for internal Ford domains
					// This prevents "DNS_FAIL" errors from proxy trying to resolve internal domains
					agent: false,
				}

				const req = https.request(options, (res) => {
					console.log("[FordLLM] callFordAi: Response received - Status:", res.statusCode, res.statusMessage)

					let responseBody = ""

					res.on("data", (chunk) => {
						responseBody += chunk
					})

					res.on("end", () => {
						if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
							console.error("[FordLLM] callFordAi: Error response body:", responseBody)

							let errorMessage = `Ford AI: Chat API request failed (${res.statusCode} ${res.statusMessage}).`

							// Provide helpful error messages
							if (res.statusCode === 401 || res.statusCode === 403) {
								errorMessage +=
									" Unauthorized or Forbidden. Check that your credentials and subscription are correct."
							} else if (res.statusCode === 429) {
								errorMessage += " Rate limit exceeded. Try again later."
							} else if (res.statusCode === 413) {
								errorMessage += " Request too large. Reduce the context size."
							}

							errorMessage += ` Error: ${responseBody}`
							reject(new Error(errorMessage))
							return
						}

						try {
							const data: FordChatCompletionResponse = JSON.parse(responseBody)
							console.log("[FordLLM] callFordAi: Successfully parsed response")
							console.log("[FordLLM] callFordAi: Response has", data.choices?.length || 0, "choices")
							console.log(
								"[FordLLM] callFordAi: First choice content length:",
								data.choices?.[0]?.message?.content?.length || 0,
							)
							resolve(data)
						} catch (parseError) {
							console.error("[FordLLM] callFordAi: JSON parse error:", parseError)
							reject(new Error(`Ford AI: Failed to parse response: ${parseError}`))
						}
					})
				})

				req.on("error", (error) => {
					console.error("[FordLLM] callFordAi: Request error:", error)
					reject(error)
				})

				req.write(postData)
				req.end()
			})

			return data
		} catch (error) {
			console.error("[FordLLM] callFordAi: Exception caught:", error)
			console.error("[FordLLM] callFordAi: Error type:", error instanceof Error ? "Error" : typeof error)
			console.error(
				"[FordLLM] callFordAi: Error message:",
				error instanceof Error ? error.message : String(error),
			)

			// Log detailed error information to diagnose network issues
			if (error instanceof Error) {
				console.error("[FordLLM] callFordAi: Error name:", (error as any).name)
				console.error("[FordLLM] callFordAi: Error code:", (error as any).code)
				console.error("[FordLLM] callFordAi: Error syscall:", (error as any).syscall)
				console.error("[FordLLM] callFordAi: Error cause:", (error as any).cause)

				// If there's a cause, log its details too
				if ((error as any).cause) {
					const cause = (error as any).cause
					console.error("[FordLLM] callFordAi: Cause type:", typeof cause)
					console.error("[FordLLM] callFordAi: Cause message:", cause.message)
					console.error("[FordLLM] callFordAi: Cause code:", cause.code)
					console.error("[FordLLM] callFordAi: Cause syscall:", cause.syscall)
					console.error("[FordLLM] callFordAi: Cause errno:", cause.errno)
					console.error("[FordLLM] callFordAi: Cause address:", cause.address)
					console.error("[FordLLM] callFordAi: Cause port:", cause.port)
				}

				throw new Error(`Ford AI: Chat request failed: ${error.message}`)
			}
			throw error
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		try {
			console.log("[FordLLM] createMessage: Called with", messages.length, "messages")

			// Call Ford AI (non-streaming)
			const response = await this.callFordAi(systemPrompt, messages)

			// Extract the assistant's reply
			const assistantMessage = response.choices?.[0]?.message?.content

			if (!assistantMessage) {
				console.error("[FordLLM] createMessage: No assistant message in response")
				throw new Error("Ford AI: No message content in response.")
			}

			console.log("[FordLLM] createMessage: Yielding text response (length:", assistantMessage.length, ")")

			// Yield the full text as a single chunk
			yield {
				type: "text",
				text: assistantMessage,
			}

			// Yield usage information if available
			if (response.usage) {
				console.log(
					"[FordLLM] createMessage: Yielding usage info - input:",
					response.usage.prompt_tokens,
					"output:",
					response.usage.completion_tokens,
				)
				yield {
					type: "usage",
					inputTokens: response.usage.prompt_tokens || 0,
					outputTokens: response.usage.completion_tokens || 0,
					totalCost: 0, // Ford API doesn't provide cost info
				}
			}

			console.log("[FordLLM] createMessage: Completed successfully")
		} catch (error) {
			console.error("[FordLLM] createMessage: Error occurred:", error)
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error("[FordLLM] createMessage: Yielding error:", errorMessage)
			yield {
				type: "error",
				error: errorMessage,
				message: errorMessage,
			}
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		// Simple implementation for single completion - call the Ford API with a simple user message
		const response = await this.callFordAi("", [{ role: "user", content: prompt }])
		return response.choices?.[0]?.message?.content || ""
	}

	override getModel(): { id: string; info: ModelInfo } {
		const modelName = this.options.fordAiModel || FORD_DEFAULT_MODEL

		// Define basic model info for Ford LLM
		const modelInfo: ModelInfo = {
			maxTokens: 1000000, // Gemini 2.5 Pro context window
			contextWindow: 1000000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 0, // Unknown, set to 0
			outputPrice: 0, // Unknown, set to 0
		}

		return {
			id: modelName,
			info: modelInfo,
		}
	}
}
