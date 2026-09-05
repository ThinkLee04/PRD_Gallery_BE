import { createSign, generateKeyPairSync } from "node:crypto";

/**
 * Test-only Google fixtures: a locally generated RSA key pair and helpers to
 * mint signed OIDC ID tokens plus a fake Google JWKS/token fetch handler.
 * Never used outside tests.
 */
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});

export const GOOGLE_TEST_KID = "itest-key-1";

const publicJwk = publicKey.export({ format: "jwk" }) as {
	kty: string;
	n: string;
	e: string;
};

function base64UrlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signTestIdToken(
	claims: Record<string, unknown>,
	kid: string = GOOGLE_TEST_KID,
): string {
	const header = base64UrlJson({ alg: "RS256", kid, typ: "JWT" });
	const body = base64UrlJson(claims);
	const signingInput = `${header}.${body}`;
	const signature = createSign("RSA-SHA256")
		.update(signingInput)
		.sign(privateKey)
		.toString("base64url");
	return `${signingInput}.${signature}`;
}

export interface FakeGoogleClaims {
	sub: string;
	email: string;
	nonce: string;
	audience: string;
	name?: string;
	picture?: string;
}

export function signGoogleIdToken(claims: FakeGoogleClaims): string {
	return signTestIdToken({
		iss: "https://accounts.google.com",
		aud: claims.audience,
		exp: Math.floor(Date.now() / 1000) + 3600,
		iat: Math.floor(Date.now() / 1000),
		nonce: claims.nonce,
		sub: claims.sub,
		email: claims.email,
		email_verified: true,
		name: claims.name ?? "Test User",
		picture: claims.picture ?? null,
	});
}

/** Fake fetch handler: serves the JWKS for /certs and an id_token for /token. */
export function fakeGoogleFetch(
	idToken: string,
): (input: string | URL | Request) => Promise<Response> {
	return async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		if (url.includes("oauth2/v3/certs")) {
			return new Response(
				JSON.stringify({
					keys: [
						{
							kty: publicJwk.kty,
							use: "sig",
							alg: "RS256",
							kid: GOOGLE_TEST_KID,
							n: publicJwk.n,
							e: publicJwk.e,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url.includes("oauth2.googleapis.com/token")) {
			return new Response(
				JSON.stringify({
					access_token: "fake-access-token",
					token_type: "Bearer",
					expires_in: 3600,
					id_token: idToken,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response("not found", { status: 404 });
	};
}
