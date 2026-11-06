import { readFile } from "node:fs/promises";
import { type Api, type Context, contentText, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type ModelFields = {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

export type ProviderRuntimeOutput = {
	result:
		| {
				validRequestReceived: boolean;
				model: ModelFields;
				response: { text: string; stopReason: string; inputTokens: number; outputTokens: number };
		  }
		| { error: string };
};

export type AddedModelOutput = {
	result: { model: ModelFields; existingModelsPreserved: boolean } | { error: string };
};

export type ProviderScenario = {
	providerId: string;
	modelId: string;
	createContext(): Context;
	options?: ModelsSimpleStreamOptions;
	validRequestReceived(): boolean;
};

function modelFields(model: Model<Api>): ModelFields {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export async function inspectProvider(
	runtime: ModelRuntime,
	scenario: ProviderScenario,
): Promise<ProviderRuntimeOutput> {
	await runtime.refresh({ allowNetwork: false });
	const configurationError = runtime.getError();
	if (configurationError) return { result: { error: configurationError } };
	const model = runtime.getModel(scenario.providerId, scenario.modelId);
	if (!model) {
		return { result: { error: `Model ${scenario.providerId}/${scenario.modelId} is unavailable after reload.` } };
	}
	try {
		const response = await runtime.completeSimple(model, scenario.createContext(), scenario.options);
		return {
			result: {
				validRequestReceived: scenario.validRequestReceived(),
				model: modelFields(model),
				response: {
					text: contentText(response.content),
					stopReason: response.stopReason,
					inputTokens: response.usage.input,
					outputTokens: response.usage.output,
				},
			},
		};
	} catch (error) {
		return { result: { error: error instanceof Error ? error.message : String(error) } };
	}
}

export async function inspectAddedModel(
	runtime: ModelRuntime,
	providerId: string,
	modelId: string,
	modelsJsonPath?: string,
): Promise<AddedModelOutput> {
	// MarsAI-only fork: built-in providers are stripped, so the "existing models" baseline is the
	// provider's models.json definition rather than a pristine built-in registry.
	let existingModelIds: string[] = [];
	if (modelsJsonPath) {
		try {
			const parsed = JSON.parse(await readFile(modelsJsonPath, "utf-8")) as {
				providers?: Record<string, { models?: Array<{ id: string }> }>;
			};
			existingModelIds = (parsed.providers?.[providerId]?.models ?? []).map((model) => model.id);
		} catch {
			// Unreadable models.json: refresh below reports the configuration error.
		}
	}
	await runtime.refresh({ allowNetwork: false });
	const configurationError = runtime.getError();
	if (configurationError) return { result: { error: configurationError } };
	const model = runtime.getModel(providerId, modelId);
	if (!model) {
		return { result: { error: `Model ${providerId}/${modelId} is unavailable after reload.` } };
	}
	if (existingModelIds.length === 0) {
		const reloaded = runtime.getProvider(providerId)?.getModels() ?? [];
		existingModelIds = reloaded.map(({ id }) => id);
	}
	return {
		result: {
			model: modelFields(model),
			existingModelsPreserved: existingModelIds.every((id) => runtime.getModel(providerId, id) !== undefined),
		},
	};
}
