import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

/**
 * Providers registered by the helper: the CLI ships MarsAI-only, but tests
 * exercise the generic machinery with catalog fixtures of real providers.
 */
export function testProviders(): Provider[] {
	return [
		anthropicProvider(),
		openaiProvider(),
		openrouterProvider(),
		googleProvider(),
		googleVertexProvider(),
		amazonBedrockProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		deepseekProvider(),
		githubCopilotProvider(),
		kimiCodingProvider(),
		openaiCodexProvider(),
		zaiProvider(),
		typesafeProvider(),
	];
}

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

/** Load optional models.json configuration without introducing file-backed catalog locks into unit tests. */
export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			providers: testProviders(),
		}),
	);
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
			providers: testProviders(),
		}),
	);
}

/** ModelRuntime with the test provider set registered; otherwise identical to ModelRuntime.create. */
export function createTestModelRuntime(options: Parameters<typeof ModelRuntime.create>[0] = {}) {
	return ModelRuntime.create({ providers: testProviders(), ...options });
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
