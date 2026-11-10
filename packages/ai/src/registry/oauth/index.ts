// ============================================================================
// High-level API
// ============================================================================

import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import * as AIError from "../../error";
import { jwtExpiryMs, NEVER_EXPIRES } from "../engine/common";
import { getProviderDefinition, PROVIDER_REGISTRY } from "../registry";
import type {
	ExternalLoginProviderInterface,
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./types";

export * from "./anthropic";
export * from "./device-code";
export type * from "./types";

const builtInOAuthProviders: OAuthProviderInfo[] = PROVIDER_REGISTRY.filter(
	provider => provider.login && provider.showInLoginList !== false,
).map(provider => ({
	id: provider.id,
	name: provider.name,
	available: provider.available ?? true,
	storeCredentialsAs: provider.storeCredentialsAs,
}));

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/**
 * Register a custom OAuth provider.
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
}

/**
 * Remove a custom OAuth provider by ID.
 */
export function unregisterOAuthProvider(id: string): void {
	customOAuthProviders.delete(id);
}

/**
 * Get a custom OAuth provider by ID.
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

/**
 * Remove all custom OAuth providers registered by a source.
 */
export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customOAuthProviders.delete(id);
		}
	}
}

const customExternalLoginProviders = new Map<string, ExternalLoginProviderInterface>();

/** Bearer value model streaming can ignore: an externally managed provider's own CLI/daemon holds the credential. */
export const EXTERNAL_LOGIN_SENTINEL = "<externally-managed>";

const EXTERNAL_LOGIN_STATUS_TIMEOUT_MS = 10_000;

const EXTERNAL_LOGIN_STATUS_FORCE_KILL_GRACE_MS = 2_000;

/** External providers own their credentials; status is checked through their CLI. */
export function registerExternalLoginProvider(provider: ExternalLoginProviderInterface): void {
	customExternalLoginProviders.set(provider.id, provider);
}

export function unregisterExternalLoginProvider(id: string): void {
	customExternalLoginProviders.delete(id);
}

export function unregisterExternalLoginProviders(sourceId: string): void {
	for (const [id, provider] of customExternalLoginProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customExternalLoginProviders.delete(id);
		}
	}
}

export function getExternalLoginProvider(id: string): ExternalLoginProviderInterface | undefined {
	return customExternalLoginProviders.get(id);
}

/** Callers must suspend their terminal UI while the login command runs. */
export async function runExternalLoginCommand(id: string): Promise<number | undefined> {
	const provider = customExternalLoginProviders.get(id);
	if (!provider || provider.loginCommand.length === 0) return undefined;
	const child = Bun.spawn([...provider.loginCommand], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	return child.exited;
}

/** Discard status output because it may contain private account details. */
export async function checkExternalLoginStatus(
	id: string,
	options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<boolean> {
	const provider = customExternalLoginProviders.get(id);
	if (!provider || provider.statusCommand.length === 0) return false;
	if (options?.signal?.aborted) return false;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	try {
		child = Bun.spawn([...provider.statusCommand], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch {
		return false;
	}
	const timeoutMs = options?.timeoutMs ?? EXTERNAL_LOGIN_STATUS_TIMEOUT_MS;
	let timedOutOrAborted = false;
	const kill = (): void => {
		timedOutOrAborted = true;
		try {
			child?.kill();
		} catch {
			// Already exited.
		}
	};
	const forceKill = (): void => {
		timedOutOrAborted = true;
		try {
			child?.kill("SIGKILL");
		} catch {
			// Already exited.
		}
	};
	const softTimer = setTimeout(kill, timeoutMs);
	const hardTimer = setTimeout(forceKill, timeoutMs + EXTERNAL_LOGIN_STATUS_FORCE_KILL_GRACE_MS);
	const onAbort = (): void => forceKill();
	options?.signal?.addEventListener("abort", onAbort);
	try {
		const exitCode = await child.exited;
		return !timedOutOrAborted && exitCode === 0;
	} catch {
		return false;
	} finally {
		clearTimeout(softTimer);
		clearTimeout(hardTimer);
		options?.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Refresh a built-in OAuth grant, cancelling provider work when refresh ownership ends.
 */
export async function refreshOAuthToken(
	provider: OAuthProvider,
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!credentials) {
		throw new AIError.OAuthError(`No OAuth credentials found for ${provider}`, {
			kind: "validation",
			provider,
		});
	}
	const def = getProviderDefinition(provider);
	if (!def?.login) {
		throw new AIError.OAuthError(`Unknown OAuth provider: ${provider}`, {
			kind: "validation",
			provider,
		});
	}
	// Providers without a real refresher (static bearer tokens / API keys that
	// don't expire) return the credentials unchanged.
	return def.refreshToken ? def.refreshToken(credentials, signal) : credentials;
}
const JWT_EXPIRY_SKEW_MS = 5 * 60_000;
export function normalizeOAuthCredentialExpiry<T extends OAuthCredentials>(provider: string, credentials: T): T {
	if (authPolicyFor(provider)?.expiry !== "jwt-or-never") return credentials;

	// Trust a JWT expiry claim when present; otherwise treat providers with
	// non-expiring sessions as such rather than honoring stale stored expiry
	// timestamps written by older login implementations.
	const normalizedExpires =
		credentials.expires > 0 && credentials.expires < 10_000_000_000
			? credentials.expires * 1000
			: credentials.expires;
	const expires = jwtExpiryMs(credentials.access, JWT_EXPIRY_SKEW_MS) ?? Math.max(normalizedExpires, NEVER_EXPIRES);
	return expires === credentials.expires ? credentials : ({ ...credentials, expires } as T);
}
/**
 * Build API-key bytes for a provider from an already-fresh OAuth credential.
 *
 * Refresh is owned by AuthStorage. This helper deliberately refuses expired
 * credentials so it cannot POST broker redaction sentinels to upstream token
 * endpoints as a side channel.
 *
 * For providers that need credential metadata at request time, returns
 * JSON-encoded credentials plus expiry metadata for diagnostics/edge guards.
 * @returns API key string, or null if no credentials
 * @throws Error if the credential is expired and must be refreshed upstream
 */
export async function getOAuthApiKey(
	provider: OAuthProvider,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	let creds = credentials[provider];
	if (!creds) {
		return null;
	}

	const policy = authPolicyFor(provider);
	creds = normalizeOAuthCredentialExpiry(provider, creds);
	// Refresh is the sole responsibility of `AuthStorage` (which calls
	// `refreshOAuthToken` directly with broker-aware single-flighting). If we
	// reach here with an expired credential, the outer pipeline failed to
	// refresh before this call OR the refresh slot is the broker sentinel —
	// either way, posting the credential to a provider endpoint would only
	// trigger a `__remote__`-against-real-provider failure that gets classified
	// as `invalid_grant` and disables the row. Refuse loudly instead.
	if (Date.now() >= creds.expires) {
		throw new AIError.OAuthError(
			`OAuth credential for ${provider} is expired and must be refreshed via AuthStorage before getOAuthApiKey is called`,
			{ kind: "validation", provider },
		);
	}
	// Providers declaring `api-key-format "structured"` need request-time
	// credential metadata, so the API key is the JSON-encoded credential.
	const apiKey =
		policy?.apiKeyFormat === "structured"
			? JSON.stringify({
					apiEndpoint: creds.apiEndpoint,
					token: creds.access,
					enterpriseUrl: creds.enterpriseUrl,
					projectId: creds.projectId,
					refreshToken: creds.refresh,
					expiresAt: creds.expires,
					email: creds.email,
					accountId: creds.accountId,
				})
			: creds.access;
	return { newCredentials: creds, apiKey };
}

/**
 * Get list of OAuth providers.
 */
export function getOAuthProviders(): OAuthProviderInfo[] {
	const customProviders = Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
		storeCredentialsAs: provider.storeCredentialsAs,
	}));
	const externalProviders = Array.from(customExternalLoginProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
		external: true as const,
	}));
	return [...builtInOAuthProviders, ...customProviders, ...externalProviders];
}

/** Provider id that stores `providerId`'s credentials: login aliases (`openai-codex-device`) map to their target (`openai-codex`). */
export function getOAuthCredentialProvider(providerId: string): string {
	return getOAuthProviders().find(provider => provider.id === providerId)?.storeCredentialsAs ?? providerId;
}
