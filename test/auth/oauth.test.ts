import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createLoginContext,
	decryptLoginState,
	encryptLoginState,
	GoogleOAuth,
	generatePkcePair,
	OAuthFlowError,
} from "../../src/modules/auth/oauth.js";

// Locally generated RSA key pair so signature verification is exercised
// without touching Google. The fake certs endpoint serves the public JWK.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const publicJwk = publicKey.export({ format: "jwk" }) as {
	kty: string;
	n: string;
	e: string;
};
const KID = "test-key-1";

function base64UrlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Signs a JWT-shaped { header, payload } with the test private key. */
function signJwt(payload: Record<string, unknown>, kid: string = KID): string {
	const header = base64UrlJson({ alg: "RS256", kid, typ: "JWT" });
	const body = base64UrlJson(payload);
	const signingInput = `${header}.${body}`;
	const signature = createSign("RSA-SHA256")
		.update(signingInput)
		.sign(privateKey)
		.toString("base64url");
	return `${signingInput}.${signature}`;
}

function validPayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		iss: "https://accounts.google.com",
		aud: "test-audience",
		exp: Math.floor(Date.now() / 1000) + 3600,
		nonce: "expected-nonce",
		sub: "google-subject-123",
		email: "User@Example.com",
		email_verified: true,
		name: "Alice Example",
		picture: "https://example.com/avatar.png",
		...overrides,
	};
}

function createOAuth(): GoogleOAuth {
	const fetchFn = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		if (url.includes("oauth2/v3/certs")) {
			return new Response(
				JSON.stringify({
					keys: [
						{
							kty: publicJwk.kty,
							use: "sig",
							alg: "RS256",
							kid: KID,
							n: publicJwk.n,
							e: publicJwk.e,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response("not found", { status: 404 });
	};
	return new GoogleOAuth({
		clientId: "test-audience",
		clientSecret: "test-secret",
		redirectUri: "http://localhost:3000/auth/google/callback",
		fetchFn,
	});
}

describe("PKCE + login context", () => {
	it("generates an S256 verifier/challenge pair", () => {
		const { codeVerifier, codeChallenge } = generatePkcePair();
		expect(codeVerifier).toBeTruthy();
		expect(codeVerifier).not.toBe(codeChallenge);
	});

	it("creates distinct state/nonce per login context", () => {
		const a = createLoginContext();
		const b = createLoginContext();
		expect(a.state).not.toBe(b.state);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.codeChallenge).toBeTruthy();
	});

	it("round-trips the encrypted login-state cookie and rejects tampering", () => {
		const secret = "0123456789abcdef0123456789abcdef0123456789";
		const context = createLoginContext();
		const cookie = encryptLoginState(context, secret);
		expect(decryptLoginState(cookie, secret)).toEqual(context);
		// Flip a character -> AES-GCM auth tag must fail.
		const tampered = `${cookie.slice(0, -2)}zz`;
		expect(() => decryptLoginState(tampered, secret)).toThrow();
		// Wrong secret -> must fail.
		expect(() =>
			decryptLoginState(cookie, "fedcba9876543210fedcba9876543210fedcba98"),
		).toThrow();
	});
});

describe("GoogleOAuth.verifyIdToken", () => {
	const oauth = createOAuth();

	it("accepts a valid ID token and normalizes the profile", async () => {
		const profile = await oauth.verifyIdToken(
			signJwt(validPayload()),
			"expected-nonce",
		);
		expect(profile).toEqual({
			googleSubject: "google-subject-123",
			email: "user@example.com", // lowercased
			displayName: "Alice Example",
			avatarUrl: "https://example.com/avatar.png",
		});
	});

	it("rejects a mismatched audience", async () => {
		await expect(
			oauth.verifyIdToken(
				signJwt(validPayload({ aud: "other-app" })),
				"expected-nonce",
			),
		).rejects.toBeInstanceOf(OAuthFlowError);
	});

	it("rejects a mismatched nonce", async () => {
		await expect(
			oauth.verifyIdToken(signJwt(validPayload()), "other-nonce"),
		).rejects.toBeInstanceOf(OAuthFlowError);
	});

	it("rejects a bad issuer", async () => {
		await expect(
			oauth.verifyIdToken(
				signJwt(validPayload({ iss: "https://evil.example" })),
				"expected-nonce",
			),
		).rejects.toBeInstanceOf(OAuthFlowError);
	});

	it("rejects an expired token", async () => {
		await expect(
			oauth.verifyIdToken(
				signJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 120 })),
				"expected-nonce",
			),
		).rejects.toBeInstanceOf(OAuthFlowError);
	});

	it("rejects a token signed with an unknown key", async () => {
		await expect(
			oauth.verifyIdToken(
				signJwt(validPayload(), "unknown-kid"),
				"expected-nonce",
			),
		).rejects.toBeInstanceOf(OAuthFlowError);
	});

	it("rejects an unsupported algorithm", async () => {
		const header = base64UrlJson({ alg: "HS256", kid: KID, typ: "JWT" });
		const body = base64UrlJson(validPayload());
		const token = `${header}.${body}.bogus-signature`;
		await expect(
			oauth.verifyIdToken(token, "expected-nonce"),
		).rejects.toBeInstanceOf(OAuthFlowError);
	});
});
