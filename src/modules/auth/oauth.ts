import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPublicKey,
	createVerify,
	randomBytes,
} from "node:crypto";

/**
 * Google OAuth 2.0 / OIDC authorization-code + PKCE client (spec §7).
 *
 * Kept dependency-free: token exchange and RS256/JWKS ID-token verification use
 * Node's global fetch + node:crypto. Everything is validated here — issuer,
 * audience/client ID, nonce, signature, expiry — before a user is upserted.
 */

export const GOOGLE_AUTHORIZE_URL =
	"https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const ALLOWED_ISSUERS = new Set([
	"https://accounts.google.com",
	"accounts.google.com",
]);

/** Short-lived login flow values for a single authorization attempt. */
export interface LoginContext {
	state: string;
	nonce: string;
	codeVerifier: string;
	codeChallenge: string;
}

/** Profile normalized from a verified ID token. `email` is lowercased here. */
export interface NormalizedGoogleProfile {
	googleSubject: string;
	email: string;
	displayName: string;
	avatarUrl: string | null;
}

/** Deliberately non-secret auth-flow failure so callers can log/redirect safely. */
export class OAuthFlowError extends Error {
	readonly code: string;
	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OAuthFlowError";
		this.code = code;
	}
}

interface JwkRsa {
	kid?: string;
	kty?: string;
	alg?: string;
	use?: string;
	n?: string;
	e?: string;
}

interface IdTokenClaims {
	iss?: unknown;
	aud?: unknown;
	exp?: unknown;
	nonce?: unknown;
	sub?: unknown;
	email?: unknown;
	name?: unknown;
	picture?: unknown;
}

export interface GoogleOAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	/** Injectable for hermetic tests; defaults to the global fetch. */
	fetchFn?: typeof fetch;
}

function base64UrlJson<T>(segment: string): T {
	return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

function randomUrlToken(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

/** RFC 7636 S256 PKCE pair. The verifier is never persisted server-side. */
export function generatePkcePair(): {
	codeVerifier: string;
	codeChallenge: string;
} {
	const codeVerifier = randomUrlToken(48);
	const codeChallenge = createHash("sha256")
		.update(codeVerifier)
		.digest()
		.toString("base64url");
	return { codeVerifier, codeChallenge };
}

/**
 * Creates one login context for GET /auth/google. The PKCE verifier, `state`,
 * and `nonce` are encrypted into the login-state cookie (see below) and must
 * be returned by the browser on the callback navigation.
 */
export function createLoginContext(): LoginContext {
	const { codeVerifier, codeChallenge } = generatePkcePair();
	return {
		state: randomUrlToken(16),
		nonce: randomUrlToken(16),
		codeVerifier,
		codeChallenge,
	};
}

export class GoogleOAuth {
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly redirectUri: string;
	private readonly fetchFn: typeof fetch;
	private certsCache: { keys: JwkRsa[]; fetchedAt: number } | null = null;

	constructor(config: GoogleOAuthConfig) {
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.redirectUri = config.redirectUri;
		this.fetchFn = config.fetchFn ?? fetch;
	}

	buildAuthorizeUrl(context: LoginContext): string {
		const url = new URL(GOOGLE_AUTHORIZE_URL);
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", this.redirectUri);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", "openid email profile");
		url.searchParams.set("state", context.state);
		url.searchParams.set("nonce", context.nonce);
		url.searchParams.set("code_challenge", context.codeChallenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("access_type", "online");
		return url.toString();
	}

	/** Exchanges the authorization code for tokens using the PKCE verifier. */
	async exchangeCodeForTokens(
		code: string,
		codeVerifier: string,
	): Promise<{ idToken: string }> {
		const body = new URLSearchParams({
			code,
			client_id: this.clientId,
			client_secret: this.clientSecret,
			redirect_uri: this.redirectUri,
			grant_type: "authorization_code",
			code_verifier: codeVerifier,
		});
		let response: Response;
		try {
			response = await this.fetchFn(GOOGLE_TOKEN_URL, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body,
			});
		} catch (cause) {
			throw new OAuthFlowError(
				"token_exchange_failed",
				"Google token exchange failed.",
				{ cause },
			);
		}
		const data = (await response.json().catch(() => null)) as {
			id_token?: string;
		} | null;
		if (!response.ok || data === null || typeof data.id_token !== "string") {
			throw new OAuthFlowError(
				"token_exchange_failed",
				"Google token exchange failed.",
			);
		}
		return { idToken: data.id_token };
	}

	/**
	 * Verifies the OIDC ID token (RS256 signature against Google's JWKS,
	 * issuer, audience, nonce, expiry) and normalizes the profile claims.
	 */
	async verifyIdToken(
		idToken: string,
		expectedNonce: string,
	): Promise<NormalizedGoogleProfile> {
		const parts = idToken.split(".");
		const [headerSegment, payloadSegment, signatureSegment] = parts;
		if (
			headerSegment === undefined ||
			payloadSegment === undefined ||
			signatureSegment === undefined
		) {
			throw new OAuthFlowError("invalid_id_token", "Invalid ID token.");
		}
		const signingInput = `${headerSegment}.${payloadSegment}`;
		const header = base64UrlJson<{ alg?: string; kid?: string }>(headerSegment);
		const payload = base64UrlJson<IdTokenClaims>(payloadSegment);
		const signature = Buffer.from(signatureSegment, "base64url");

		if (header.alg !== "RS256") {
			throw new OAuthFlowError("invalid_id_token", "Unsupported ID token alg.");
		}
		if (typeof payload.iss !== "string" || !ALLOWED_ISSUERS.has(payload.iss)) {
			throw new OAuthFlowError("invalid_id_token", "ID token issuer rejected.");
		}
		const audiences =
			typeof payload.aud === "string"
				? [payload.aud]
				: Array.isArray(payload.aud)
					? payload.aud.filter((a): a is string => typeof a === "string")
					: [];
		if (!audiences.includes(this.clientId)) {
			throw new OAuthFlowError(
				"invalid_id_token",
				"ID token audience rejected.",
			);
		}
		if (
			typeof payload.exp !== "number" ||
			Date.now() / 1000 > payload.exp + 30
		) {
			throw new OAuthFlowError("invalid_id_token", "ID token expired.");
		}
		if (payload.nonce !== expectedNonce) {
			throw new OAuthFlowError("invalid_id_token", "ID token nonce rejected.");
		}

		const keys = await this.getSigningKeys();
		const key = keys.find(
			(k) => k.kty === "RSA" && k.alg === "RS256" && k.kid === header.kid,
		);
		if (key === undefined || key.n === undefined || key.e === undefined) {
			throw new OAuthFlowError("invalid_id_token", "Signing key not found.");
		}

		let valid = false;
		try {
			const publicKey = createPublicKey({
				key: { kty: "RSA", n: key.n, e: key.e },
				format: "jwk",
			});
			const verifier = createVerify("RSA-SHA256");
			verifier.update(Buffer.from(signingInput, "ascii"));
			valid = verifier.verify(publicKey, signature);
		} catch {
			valid = false;
		}
		if (!valid) {
			throw new OAuthFlowError(
				"invalid_id_token",
				"ID token signature invalid.",
			);
		}

		if (typeof payload.sub !== "string" || payload.sub === "") {
			throw new OAuthFlowError("invalid_id_token", "ID token missing subject.");
		}
		return {
			googleSubject: payload.sub,
			email:
				typeof payload.email === "string"
					? payload.email.trim().toLowerCase()
					: "",
			displayName: typeof payload.name === "string" ? payload.name : "",
			avatarUrl:
				typeof payload.picture === "string" && payload.picture !== ""
					? payload.picture
					: null,
		};
	}

	private async getSigningKeys(): Promise<JwkRsa[]> {
		const cacheTtlMs = 60 * 60 * 1000;
		const now = Date.now();
		if (
			this.certsCache !== null &&
			now - this.certsCache.fetchedAt < cacheTtlMs
		) {
			return this.certsCache.keys;
		}
		let response: Response;
		try {
			response = await this.fetchFn(GOOGLE_CERTS_URL);
		} catch (cause) {
			throw new OAuthFlowError(
				"certs_unavailable",
				"Google keys unavailable.",
				{
					cause,
				},
			);
		}
		const data = (await response.json().catch(() => null)) as {
			keys?: unknown;
		} | null;
		const keys = Array.isArray(data?.keys)
			? (data.keys.filter(
					(k): k is JwkRsa => typeof k === "object" && k !== null && "kid" in k,
				) as JwkRsa[])
			: [];
		this.certsCache = { keys, fetchedAt: now };
		return keys;
	}
}

// ---- Encrypted login-state cookie (holds PKCE verifier + state + nonce) -----

/** AES-256-GCM key derived from the high-entropy session secret. */
function stateKey(secret: string): Buffer {
	return createHash("sha256").update(secret).digest();
}

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptLoginState(state: LoginContext, secret: string): string {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", stateKey(secret), iv);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(state), "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

/** Decrypts a login-state cookie; throws on tampering or malformed input. */
export function decryptLoginState(
	payload: string,
	secret: string,
): LoginContext {
	const raw = Buffer.from(payload, "base64url");
	if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
		throw new Error("Malformed login state cookie.");
	}
	const iv = raw.subarray(0, IV_LENGTH);
	const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
	const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
	const decipher = createDecipheriv("aes-256-gcm", stateKey(secret), iv);
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	]).toString("utf8");
	const parsed = JSON.parse(plaintext) as Partial<LoginContext>;
	if (
		typeof parsed.state !== "string" ||
		typeof parsed.nonce !== "string" ||
		typeof parsed.codeVerifier !== "string" ||
		typeof parsed.codeChallenge !== "string"
	) {
		throw new Error("Malformed login state cookie.");
	}
	return {
		state: parsed.state,
		nonce: parsed.nonce,
		codeVerifier: parsed.codeVerifier,
		codeChallenge: parsed.codeChallenge,
	};
}
