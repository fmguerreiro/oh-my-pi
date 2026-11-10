import { afterEach, describe, expect, test } from "bun:test";
import {
	checkExternalLoginStatus,
	getExternalLoginProvider,
	getOAuthProviders,
	registerExternalLoginProvider,
	runExternalLoginCommand,
	unregisterExternalLoginProvider,
	unregisterExternalLoginProviders,
} from "../../../src/registry/oauth";

const exitWith = (code: number): string[] => [process.execPath, "-e", `process.exit(${code})`];
const hang = (): string[] => [process.execPath, "-e", "setInterval(() => {}, 1000)"];

describe("external login providers", () => {
	const id = "external-login-test-provider";

	afterEach(() => {
		unregisterExternalLoginProvider(id);
	});

	test("registration is listed by getOAuthProviders with external: true and no storeCredentialsAs", () => {
		registerExternalLoginProvider({
			id,
			name: "External Test",
			loginCommand: exitWith(0),
			statusCommand: exitWith(0),
		});
		const entry = getOAuthProviders().find(p => p.id === id);
		expect(entry).toBeDefined();
		expect(entry?.external).toBe(true);
		expect(entry?.storeCredentialsAs).toBeUndefined();
		expect(getExternalLoginProvider(id)).toBeDefined();
	});

	test("checkExternalLoginStatus is true only when statusCommand exits 0", async () => {
		registerExternalLoginProvider({
			id,
			name: "External Test",
			loginCommand: exitWith(0),
			statusCommand: exitWith(0),
		});
		expect(await checkExternalLoginStatus(id)).toBe(true);

		registerExternalLoginProvider({
			id,
			name: "External Test",
			loginCommand: exitWith(0),
			statusCommand: exitWith(1),
		});
		expect(await checkExternalLoginStatus(id)).toBe(false);
	});

	test("checkExternalLoginStatus is false for an unregistered provider", async () => {
		expect(await checkExternalLoginStatus("no-such-external-provider")).toBe(false);
	});

	test("checkExternalLoginStatus is false when the status command hangs past the timeout", async () => {
		registerExternalLoginProvider({ id, name: "External Test", loginCommand: exitWith(0), statusCommand: hang() });
		expect(await checkExternalLoginStatus(id, { timeoutMs: 50 })).toBe(false);
	});

	test("runExternalLoginCommand reports the login command's exit code", async () => {
		registerExternalLoginProvider({
			id,
			name: "External Test",
			loginCommand: exitWith(7),
			statusCommand: exitWith(0),
		});
		expect(await runExternalLoginCommand(id)).toBe(7);
	});

	test("runExternalLoginCommand is undefined for an unregistered provider", async () => {
		expect(await runExternalLoginCommand("no-such-external-provider")).toBeUndefined();
	});

	test("unregisterExternalLoginProviders(sourceId) removes only that source's registrations", () => {
		registerExternalLoginProvider({
			id,
			name: "External Test",
			loginCommand: exitWith(0),
			statusCommand: exitWith(0),
			sourceId: "ext://a",
		});
		const otherId = `${id}-other`;
		registerExternalLoginProvider({
			id: otherId,
			name: "External Test Other",
			loginCommand: exitWith(0),
			statusCommand: exitWith(0),
			sourceId: "ext://b",
		});
		unregisterExternalLoginProviders("ext://a");
		expect(getExternalLoginProvider(id)).toBeUndefined();
		expect(getExternalLoginProvider(otherId)).toBeDefined();
		unregisterExternalLoginProvider(otherId);
	});
});
