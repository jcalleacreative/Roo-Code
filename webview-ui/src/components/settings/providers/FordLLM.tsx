import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"

import { inputEventTransform } from "../transforms"

type FordLLMProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const FordLLM = ({ apiConfiguration, setApiConfigurationField }: FordLLMProps) => {
	const { t } = useAppTranslation()

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	return (
		<>
			<div className="text-sm text-vscode-descriptionForeground mb-4">
				Configure Ford&apos;s internal LLM service using OAuth2 authentication.
			</div>

			<VSCodeTextField
				value={apiConfiguration?.fordAiClientId || ""}
				onInput={handleInputChange("fordAiClientId")}
				placeholder="Enter Client ID"
				className="w-full">
				<label className="block font-medium mb-1">Client ID</label>
			</VSCodeTextField>

			<VSCodeTextField
				value={apiConfiguration?.fordAiClientSecret || ""}
				type="password"
				onInput={handleInputChange("fordAiClientSecret")}
				placeholder="Enter Client Secret"
				className="w-full">
				<label className="block font-medium mb-1">Client Secret</label>
			</VSCodeTextField>

			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>

			<VSCodeTextField
				value={apiConfiguration?.fordAiTokenUrl || ""}
				type="url"
				onInput={handleInputChange("fordAiTokenUrl")}
				placeholder="https://example.ford.com/oauth/token"
				className="w-full">
				<label className="block font-medium mb-1">Token URL</label>
			</VSCodeTextField>

			<VSCodeTextField
				value={apiConfiguration?.fordAiChatUrl || ""}
				type="url"
				onInput={handleInputChange("fordAiChatUrl")}
				placeholder="https://example.ford.com/api/chat"
				className="w-full">
				<label className="block font-medium mb-1">Chat API URL</label>
			</VSCodeTextField>

			<VSCodeTextField
				value={apiConfiguration?.fordAiScope || ""}
				onInput={handleInputChange("fordAiScope")}
				placeholder="api.read api.write (optional)"
				className="w-full">
				<label className="block font-medium mb-1">OAuth Scope (Optional)</label>
			</VSCodeTextField>
		</>
	)
}
