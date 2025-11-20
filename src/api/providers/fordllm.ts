import { Anthropic } from "@anthropic-ai/sdk"
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
		// Return cached token if still valid (with 5min buffer)
		const now = Date.now() / 1000
		if (this.accessToken && this.tokenExpiresAt > now + 300) {
			return this.accessToken
		}

		// Get configuration from VS Code settings or env vars
		const clientId = this.options.fordAiClientId || process.env.FORDLLM_CLIENT_ID || process.env.FORD_AI_CLIENT_ID
		const clientSecret =
			this.options.fordAiClientSecret || process.env.FORDLLM_CLIENT_SECRET || process.env.FORD_AI_CLIENT_SECRET
		const tokenUrl = this.options.fordAiTokenUrl || FORD_DEFAULT_TOKEN_URL
		const scope = this.options.fordAiScope || FORD_DEFAULT_SCOPE

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
			const response = await fetch(tokenUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: params.toString(),
			})

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(
					`Ford AI: Failed to obtain access token (${response.status} ${response.statusText}). Check clientId/clientSecret/scope. Error: ${errorText}`,
				)
			}

			const data: FordTokenResponse = await response.json()

			if (!data.access_token) {
				throw new Error("Ford AI: No access_token in response from token endpoint.")
			}

			// Cache the token
			this.accessToken = data.access_token
			this.tokenExpiresAt = now + data.expires_in

			return this.accessToken
		} catch (error) {
			if (error instanceof Error) {
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
		console.log("[FordLLM] callFordAi - Getting access token")
		const accessToken = await this.getFordAccessToken()
		console.log("[FordLLM] callFordAi - Access token obtained:", accessToken ? "✓" : "✗")

		const chatUrl = this.options.fordAiChatUrl || FORD_DEFAULT_CHAT_URL
		const modelName = this.options.fordAiModel || FORD_DEFAULT_MODEL

		console.log("[FordLLM] callFordAi - Chat URL:", chatUrl)
		console.log("[FordLLM] callFordAi - Model:", modelName)

		// Convert Anthropic messages to OpenAI format
		const openAiMessages = [
			{ role: "system" as const, content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		console.log("[FordLLM] callFordAi - Converted messages:", JSON.stringify(openAiMessages, null, 2))

		// Context size guardrail
		const requestBody = {
			model: modelName,
			messages: openAiMessages,
		}
		const requestSize = JSON.stringify(requestBody).length

		console.log("[FordLLM] callFordAi - Request size:", requestSize, "bytes")

		if (requestSize > MAX_CONTEXT_SIZE_BYTES) {
			throw new Error(
				`Ford AI: Context too large (${Math.round(requestSize / 1024)}KB). Try fewer files or a smaller prompt. Max: ${Math.round(MAX_CONTEXT_SIZE_BYTES / 1024)}KB.`,
			)
		}

		try {
			console.log("[FordLLM] callFordAi - Sending request to:", chatUrl)
			const response = await fetch(chatUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken.substring(0, 20)}...`,
				},
				body: JSON.stringify(requestBody),
			})

			console.log("[FordLLM] callFordAi - Response status:", response.status, response.statusText)
			console.log("[FordLLM] callFordAi - Response ok:", response.ok)

			if (!response.ok) {
				const errorText = await response.text()
				console.error("[FordLLM] callFordAi - Error response body:", errorText)

				let errorMessage = `Ford AI: Chat API request failed (${response.status} ${response.statusText}).`

				// Provide helpful error messages
				if (response.status === 401 || response.status === 403) {
					errorMessage +=
						" Unauthorized or Forbidden. Check that your credentials and subscription are correct."
				} else if (response.status === 429) {
					errorMessage += " Rate limit exceeded. Try again later."
				} else if (response.status === 413) {
					errorMessage += " Request too large. Reduce the context size."
				}

				errorMessage += ` Error: ${errorText}`
				throw new Error(errorMessage)
			}

			const responseText = await response.text()
			console.log("[FordLLM] callFordAi - Raw response:", responseText)

			const data: FordChatCompletionResponse = JSON.parse(responseText)
			console.log("[FordLLM] callFordAi - Parsed response:", JSON.stringify(data, null, 2))

			return data
		} catch (error) {
			console.error("[FordLLM] callFordAi - Exception:", error)
			if (error instanceof Error) {
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
			console.log("[FordLLM] Starting API call")
			console.log("[FordLLM] System prompt length:", systemPrompt.length)
			console.log("[FordLLM] Messages count:", messages.length)

			// Call Ford AI (non-streaming)
			const response = await this.callFordAi(systemPrompt, messages)

			console.log("[FordLLM] Received response:", JSON.stringify(response, null, 2))
			console.log("[FordLLM] Response type:", typeof response)
			console.log("[FordLLM] Response keys:", Object.keys(response || {}))
			console.log("[FordLLM] Choices:", response.choices)
			console.log("[FordLLM] First choice:", response.choices?.[0])

			// Extract the assistant's reply
			const assistantMessage = response.choices?.[0]?.message?.content

			console.log("[FordLLM] Assistant message:", assistantMessage)
			console.log("[FordLLM] Assistant message type:", typeof assistantMessage)
			console.log("[FordLLM] Assistant message length:", assistantMessage?.length)

			if (!assistantMessage) {
				console.error("[FordLLM] No message content in response!")
				console.error("[FordLLM] Full response:", JSON.stringify(response, null, 2))
				throw new Error("Ford AI: No message content in response.")
			}

			// Yield the full text as a single chunk
			yield {
				type: "text",
				text: assistantMessage,
			}

			// Yield usage information if available
			if (response.usage) {
				yield {
					type: "usage",
					inputTokens: response.usage.prompt_tokens || 0,
					outputTokens: response.usage.completion_tokens || 0,
					totalCost: 0, // Ford API doesn't provide cost info
				}
			}

			console.log("[FordLLM] Message creation completed successfully")
		} catch (error) {
			console.error("[FordLLM] Error in createMessage:", error)
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error("[FordLLM] Error message:", errorMessage)
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
