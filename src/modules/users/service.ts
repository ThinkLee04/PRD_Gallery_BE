import type pg from "pg";

/**
 * A Google profile normalized from a verified OIDC ID token. The OAuth module
 * guarantees these fields were validated (issuer, audience, nonce, signature).
 * `email` is lowercased at the boundary; `googleSubject` is the durable
 * identity — never email (docs/technical-spec.md §5).
 */
export interface GoogleUserProfile {
	googleSubject: string;
	email: string;
	displayName: string;
	avatarUrl: string | null;
}

export interface UserRow {
	id: string;
	googleSubject: string;
	email: string;
	displayName: string;
	avatarUrl: string | null;
}

/**
 * Upserts a user by their Google `sub`. Re-registering the same Google account
 * refreshes profile display fields and `last_login_at` but never the primary
 * key or google_subject. Returns the current users row.
 */
export async function upsertGoogleUser(
	pool: pg.Pool,
	profile: GoogleUserProfile,
): Promise<UserRow> {
	const result = await pool.query<UserRow>(
		`INSERT INTO users (google_subject, email, display_name, avatar_url, last_login_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (google_subject) DO UPDATE SET
		   email = EXCLUDED.email,
		   display_name = EXCLUDED.display_name,
		   avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
		   last_login_at = now(),
		   updated_at = now()
		 RETURNING id,
		           google_subject AS "googleSubject",
		           email,
		           display_name AS "displayName",
		           avatar_url AS "avatarUrl"`,
		[
			profile.googleSubject,
			profile.email,
			profile.displayName,
			profile.avatarUrl,
		],
	);
	const row = result.rows[0];
	if (row === undefined) {
		throw new Error("upsertGoogleUser returned no row.");
	}
	return row;
}
