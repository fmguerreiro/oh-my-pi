import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerExternalLoginProvider, unregisterExternalLoginProvider } from "@oh-my-pi/pi-ai/oauth";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const PROVIDER_ID = "selector-controller-external-test-provider";

/** `ui` stub with the overlay members `showSelector` drives, plus the `stop`/`start` pair `#handleExternalLogin` toggles around the foreground command. */
function externalLoginContext() {
	const uiStop = vi.fn();
	const uiStart = vi.fn();
	const ctx = createInteractiveModeContext({
		ui: {
			getFocused: () => null,
			stop: uiStop,
			start: uiStart,
		},
	});
	return { ctx, uiStop, uiStart };
}

describe("external login via the TUI provider selector", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		unregisterExternalLoginProvider(PROVIDER_ID);
		vi.restoreAllMocks();
	});

	it("reports success and presents it only once the status check confirms authentication", async () => {
		registerExternalLoginProvider({
			id: PROVIDER_ID,
			name: "Selector External Test",
			loginCommand: [process.execPath, "-e", "process.exit(0)"],
			statusCommand: [process.execPath, "-e", "process.exit(0)"],
		});
		const { ctx, uiStop, uiStart } = externalLoginContext();
		const controller = new SelectorController(ctx);
		await controller.showOAuthSelector("login", PROVIDER_ID);
		expect(uiStop).toHaveBeenCalledTimes(1);
		expect(uiStart).toHaveBeenCalledTimes(1);
		expect(ctx.present).toHaveBeenCalledTimes(1);
		expect(ctx.showWarning).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("never reports success for a nonzero exit code, and still restarts the ui", async () => {
		registerExternalLoginProvider({
			id: PROVIDER_ID,
			name: "Selector External Test",
			loginCommand: [process.execPath, "-e", "process.exit(7)"],
			statusCommand: [process.execPath, "-e", "process.exit(0)"],
		});
		const { ctx, uiStop, uiStart } = externalLoginContext();
		const controller = new SelectorController(ctx);
		await controller.showOAuthSelector("login", PROVIDER_ID);
		expect(uiStop).toHaveBeenCalledTimes(1);
		expect(uiStart).toHaveBeenCalledTimes(1);
		expect(ctx.present).not.toHaveBeenCalled();
		expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("exited with code 7"));
	});

	it("restarts the ui from a finally block even when the login command fails to spawn", async () => {
		registerExternalLoginProvider({
			id: PROVIDER_ID,
			name: "Selector External Test",
			loginCommand: ["/no/such/external-login-binary-xyz"],
			statusCommand: [process.execPath, "-e", "process.exit(0)"],
		});
		const { ctx, uiStop, uiStart } = externalLoginContext();
		const controller = new SelectorController(ctx);
		await controller.showOAuthSelector("login", PROVIDER_ID);
		expect(uiStop).toHaveBeenCalledTimes(1);
		expect(uiStart).toHaveBeenCalledTimes(1);
		expect(ctx.present).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Failed to run"));
	});
});
