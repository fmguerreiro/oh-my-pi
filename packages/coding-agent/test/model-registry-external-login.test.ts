import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai";
import { unregisterExternalLoginProviders } from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// `pi.registerProvider(name, { externalLogin })` delegates the credential
// entirely to an external CLI: the registry must never store a key for it
// and must report authenticated only when the configured statusCommand
// actually exits 0 — never from a stale apiKey placeholder.
describe("externalLogin provider registration", () => {
	const provider = "external-login-registry-test";
	const sourceId = "ext://external-login-registry-test";
	const exitWith = (code: number): string[] => [process.execPath, "-e", `process.exit(${code})`];

	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-external-login-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
	});

	afterEach(() => {
		clearCustomApis();
		unregisterExternalLoginProviders(sourceId);
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function register(statusExitCode: number, extra?: Partial<ProviderConfigInput>): void {
		const config: ProviderConfigInput = {
			baseUrl: "https://external-login-registry-test.example.com/v1",
			api: "openai-completions",
			externalLogin: {
				name: "External Login Test",
				loginCommand: exitWith(0),
				statusCommand: exitWith(statusExitCode),
			},
			...extra,
		};
		registry.registerProvider(provider, config, sourceId);
	}

	test("getApiKeyForProvider is truthy only when statusCommand exits 0", async () => {
		register(0);
		expect(await registry.getApiKeyForProvider(provider)).toBeDefined();

		register(1);
		expect(await registry.getApiKeyForProvider(provider)).toBeUndefined();
	});

	test("status takes precedence over a stale apiKey placeholder", async () => {
		register(1, { apiKey: "not-used" });
		expect(await registry.getApiKeyForProvider(provider)).toBeUndefined();
	});

	test("startup and scoped refresh reflect external authentication", async () => {
		register(0);
		await registry.refreshRuntimeProviders("offline");
		expect(registry.hasConcreteAuth(provider)).toBe(true);

		register(1);
		await registry.refreshProvider(provider, "offline");
		expect(registry.hasConcreteAuth(provider)).toBe(false);
	});

	test("source handoff still uses external status instead of an API key", async () => {
		register(0);
		registry.registerProvider(
			provider,
			{
				apiKey: "not-used",
				externalLogin: {
					name: "External Login Test",
					loginCommand: exitWith(0),
					statusCommand: exitWith(1),
				},
			},
			"ext://replacement",
		);
		expect(await registry.getApiKeyForProvider(provider)).toBeUndefined();
		registry.unregisterProvider(provider);
	});

	test("no credential is ever persisted for an authenticated externalLogin provider", async () => {
		register(0);
		await registry.getApiKeyForProvider(provider);
		expect(authStorage.keys.source(provider)).toBeUndefined();
		expect(authStorage.credentials.has(provider)).toBe(false);
	});

	test("rejects combining oauth with externalLogin", () => {
		expect(() =>
			registry.registerProvider(
				provider,
				{
					baseUrl: "https://external-login-registry-test.example.com/v1",
					api: "openai-completions",
					oauth: { name: "Test", login: async () => "key" },
					externalLogin: { name: "Test", loginCommand: exitWith(0), statusCommand: exitWith(0) },
				},
				sourceId,
			),
		).toThrow();
	});

	test("unregisterProvider stops consulting the status command", async () => {
		register(0);
		expect(await registry.getApiKeyForProvider(provider)).toBeDefined();
		registry.unregisterProvider(provider);
		// Unregistered: no longer a known provider, so it falls through to the
		// ordinary credential cascade, which has nothing stored for it.
		expect(await registry.getApiKeyForProvider(provider)).toBeUndefined();
	});
});
