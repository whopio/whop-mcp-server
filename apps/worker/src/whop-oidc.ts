export interface WhopTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch ms after which the access token must not be used. */
	expiresAt: number;
}

export interface WhopUserinfo {
	sub: string;
	name?: string;
	preferred_username?: string;
}

/** The public client ID for Whop MCP's registered OAuth application. */
export const WHOP_MCP_CLIENT_ID = "app_3bVb7SdAznaxnW";

export interface WhopOidcConfig {
	apiOrigin: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallengeS256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(verifier),
	);
	return toBase64Url(new Uint8Array(digest));
}

export class WhopOidcError extends Error {
	readonly status: number;

	constructor(message: string, status = 502) {
		super(message);
		this.status = status;
	}
}

/**
 * The worker's upstream OAuth client against Whop's OIDC server. The worker is
 * ONE registered confidential Whop app: it drives the browser authorize flow
 * with its own PKCE pair (Whop mandates S256), exchanges and refreshes tokens
 * server-side, and never exposes them to MCP clients.
 */
export class WhopOidcClient {
	constructor(private readonly config: WhopOidcConfig) {}

	authorizeUrl(options: {
		state: string;
		codeChallenge: string;
		scopes: string[];
	}): string {
		const url = new URL("/oauth/authorize", this.config.apiOrigin);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUri,
			scope: options.scopes.join(" "),
			state: options.state,
			code_challenge: options.codeChallenge,
			code_challenge_method: "S256",
			nonce: crypto.randomUUID(),
		}).toString();
		return url.toString();
	}

	async exchangeCode(code: string, codeVerifier: string): Promise<WhopTokens> {
		return this.tokenRequest({
			grant_type: "authorization_code",
			code,
			redirect_uri: this.config.redirectUri,
			code_verifier: codeVerifier,
		});
	}

	async refresh(refreshToken: string): Promise<WhopTokens> {
		return this.tokenRequest({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		});
	}

	async userinfo(accessToken: string): Promise<WhopUserinfo> {
		const response = await fetch(
			new URL("/oauth/userinfo", this.config.apiOrigin),
			{
				headers: { Authorization: `Bearer ${accessToken}` },
				redirect: "error",
			},
		);
		if (!response.ok) {
			throw new WhopOidcError(`userinfo failed with ${response.status}`);
		}
		const body = (await response
			.json()
			.catch(() => null)) as WhopUserinfo | null;
		// A grant without a sub would authorize now and fail every /mcp call.
		if (!body || typeof body.sub !== "string" || body.sub.length === 0) {
			throw new WhopOidcError("Whop userinfo response is missing sub");
		}
		return body;
	}

	private async tokenRequest(
		params: Record<string, string>,
	): Promise<WhopTokens> {
		const response = await fetch(
			new URL("/oauth/token", this.config.apiOrigin),
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				redirect: "error",
				body: new URLSearchParams({
					client_id: this.config.clientId,
					client_secret: this.config.clientSecret,
					...params,
				}),
			},
		);
		const body = (await response.json().catch(() => ({}))) as TokenResponse;
		if (!response.ok || !body.access_token) {
			throw new WhopOidcError(
				`Whop token endpoint returned ${response.status}: ${body.error ?? "unknown"}`,
				response.status === 400 || response.status === 401 ? 401 : 502,
			);
		}
		if (!body.refresh_token) {
			throw new WhopOidcError("Whop token response is missing refresh_token");
		}
		// A NaN/negative expiresAt would silently disable the expiry gate.
		const expiresIn = body.expires_in ?? 3600;
		if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
			throw new WhopOidcError("Whop token response has an invalid expires_in");
		}
		return {
			accessToken: body.access_token,
			refreshToken: body.refresh_token,
			expiresAt: Date.now() + expiresIn * 1000,
		};
	}
}
