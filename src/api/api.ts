import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import type { MarketplaceSettings } from '../settings';
import { API_BASE_URL } from '../constants';

/** Token format issued by the server: 'omp_' + 64 lowercase hex characters. */
export const TOKEN_RE = /^omp_[0-9a-f]{64}$/;

/**
 * The server rejected the token, or we don't have one. A separate class so
 * the UI can tell "log in" apart from a plain network failure.
 */
export class UnauthorizedError extends Error {}

/** Any other HTTP error — the status is kept so callers can react to it. */
export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(`${status}: ${message}`);
		this.status = status;
	}
}

interface ApiRequest {
	path: string;
	method?: 'GET' | 'POST' | 'DELETE';
	contentType?: string;
	body?: string | ArrayBuffer;
	/** Attaches the Authorization header and requires a valid token. */
	auth?: boolean;
}

/**
 * The single place every marketplace request goes through, so
 * trailing-slash handling, `throw: false`, and status checks live once
 * instead of being copy-pasted per call site.
 *
 * Returns the raw response — callers read the body themselves, because
 * `response.json` is a getter that calls JSON.parse, and that throws on a
 * ZIP archive starting with "PK".
 */
export async function apiRequest(
	settings: MarketplaceSettings,
	req: ApiRequest,
): Promise<RequestUrlResponse> {
	// The address is a build-time constant now, so there's nothing left to
	// defend against here. This just normalizes the trailing slash and acts
	// as a last line of defense — esbuild.config.mjs runs the same checks
	// before this address ever reaches main.js.
	const apiBaseUrl = assertSafeApiUrl(API_BASE_URL);

	const headers: Record<string, string> = {};
	if (req.auth) {
		const token = settings.token.trim();
		// Catch a malformed token locally — no point making a round trip
		// for a 401 when the user can be told immediately what's wrong.
		if (!TOKEN_RE.test(token)) {
			throw new UnauthorizedError('Log in from the plugin settings');
		}
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await requestUrl({
		url: `${apiBaseUrl}${req.path}`,
		method: req.method ?? 'GET',
		...(req.contentType ? { contentType: req.contentType } : {}),
		...(req.body ? { body: req.body } : {}),
		headers,
		// requestUrl throws by default and discards the server's response body
		throw: false,
	});

	if (response.status === 401) {
		throw new UnauthorizedError(extractError(response.text));
	}
	if (response.status < 200 || response.status >= 300) {
		throw new ApiError(response.status, extractError(response.text));
	}

	return response;
}

/**
 * Validates the server address before the token is sent to it.
 *
 * This used to be a settings field, which made it a one-message phishing
 * vector: "set the API address to ... to get package X" would hand over
 * the account, since the token rides along on every authenticated request.
 * The address now comes from the build; this check stays as a last line of
 * defense and to normalize the trailing slash.
 */
export function assertSafeApiUrl(raw: string): string {
	const value = raw.trim();
	if (!value) {
		// A user should never see this — it means the build didn't inject
		// the constant. The message is aimed at whoever is building the plugin.
		throw new Error('The API address was not compiled in - rebuild the plugin');
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`The API address is not a valid URL: ${value}`);
	}

	if (url.protocol !== 'https:' && !isLocalhost(url.hostname)) {
		// http:// sends the token in plaintext, and it never expires — one
		// sniff on a public network gives permanent access. Localhost is
		// exempt because that's just `wrangler dev`, and the traffic never
		// leaves the machine.
		throw new Error('The API address must use https:// (localhost is the exception)');
	}

	// Credentials in the URL would end up alongside our token in the Authorization header.
	if (url.username || url.password) {
		throw new Error('The API address cannot contain a username or password');
	}

	// We append the endpoint path ourselves; a base URL with its own path
	// or query string would redirect every endpoint somewhere unexpected.
	if (url.search || url.hash) {
		throw new Error('The API address cannot contain query parameters or a fragment');
	}

	return url.origin + url.pathname.replace(/\/+$/, '');
}

function isLocalhost(hostname: string): boolean {
	return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

/** On error the server returns {"error": "..."} — this pulls out just the message. */
function extractError(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && 'error' in parsed) {
			return String(parsed.error);
		}
	} catch {
		// not JSON — fall back to the raw text
	}
	return text;
}
