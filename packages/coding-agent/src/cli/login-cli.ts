/**
 * `omp login [provider]` — the terminal counterpart of the in-session `/login`.
 *
 * Authenticates against the same credential store sessions read (local
 * `agent.db`, or the configured auth broker), including OAuth providers
 * contributed by extensions, then re-runs that provider's model discovery so
 * the next session sees the models the credential unlocked.
 */
import * as readline from "node:readline";
import { checkExternalLoginStatus, getOAuthProviders, runExternalLoginCommand } from "@oh-my-pi/pi-ai";
import { APP_NAME, getAgentDbPath, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { formatLoginIdentity, pickOAuthProvider, runTerminalOAuthLogin } from "./oauth-terminal";

/**
 * Log in to `provider`, or to one picked interactively when omitted.
 *
 * An unknown/unavailable provider, a cancelled selection or prompt, and a
 * failed OAuth flow print `Login failed: …` to stderr and set exit code 1.
 */
export async function runLoginCommand(provider: string | undefined): Promise<void> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		// Extensions may register OAuth providers; load them so they are listed.
		await loadCliExtensionProviders(modelRegistry, settings, cwd);

		const providers = getOAuthProviders().filter(p => p.available);
		const providerId = provider ?? (await pickOAuthProvider(rl, providers));
		const info = providers.find(p => p.id === providerId);
		if (!info) {
			throw new Error(`Unknown OAuth provider '${providerId}'. Run \`${APP_NAME} login\` to pick one.`);
		}

		if (info.external) {
			rl.close();
			process.stdout.write(`Running ${info.name} login: ${APP_NAME} hands off to its own command…\n`);
			const exitCode = await runExternalLoginCommand(info.id);
			const authenticated = exitCode === 0 && (await checkExternalLoginStatus(info.id));
			if (!authenticated) {
				process.stderr.write(
					chalk.red(
						exitCode === 0
							? `Login failed: ${info.name} login finished, but its status check did not confirm authentication.\n`
							: `Login failed: ${info.name} login command exited with code ${exitCode}.\n`,
					),
				);
				process.exitCode = 1;
				return;
			}
			await modelRegistry.refreshProvider(info.id, "online");
			process.stdout.write(chalk.green(`\nLogged in to ${info.name}\n`));
			process.stdout.write(chalk.dim(`${info.name} manages its own credentials; ${APP_NAME} stores none.\n`));
			return;
		}
		const identity = await runTerminalOAuthLogin(rl, authStorage, info.id, { openBrowser: true });
		if (!identity) {
			process.stdout.write(chalk.yellow(`No credentials were stored for ${info.name}.\n`));
			return;
		}
		// A provider-scoped online refresh re-runs discovery with the new
		// credential; a fresh cache row fetched before login would otherwise hide
		// the unlocked models until its TTL expires (#5780).
		await modelRegistry.refreshProvider(info.storeCredentialsAs ?? info.id, "online");

		const who = formatLoginIdentity(identity);
		process.stdout.write(chalk.green(`\nLogged in to ${info.name}${who ? ` as ${who}` : ""}\n`));
		const broker = await resolveAuthBrokerConfig();
		process.stdout.write(
			chalk.dim(
				broker ? `Credentials saved to auth broker ${broker.url}\n` : `Credentials saved to ${getAgentDbPath()}\n`,
			),
		);
	} catch (error) {
		process.stderr.write(chalk.red(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	} finally {
		rl.close();
		authStorage.close();
	}
}
