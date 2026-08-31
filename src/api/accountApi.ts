import { apiRequest } from './api';
import type { MarketplaceSettings } from '../settings';

export interface Account {
	userId: string;
	username: string;
	/** Devices currently signed in, and the cap. The server owns the limit; the UI just reports it. */
	devices: number;
	deviceLimit: number;
}

/** Checks whether the token still works, and who the server thinks we are. */
export async function fetchMe(settings: MarketplaceSettings): Promise<Account> {
	const response = await apiRequest(settings, { path: '/me', auth: true });

	const data = response.json as { user_id?: string; username?: string; tokens?: number; token_limit?: number };
	return {
		userId: data.user_id ?? '',
		username: data.username ?? '',
		devices: data.tokens ?? 1,
		deviceLimit: data.token_limit ?? 5,
	};
}

/** Revokes the current token on the server. */
export async function revokeToken(settings: MarketplaceSettings): Promise<void> {
	await apiRequest(settings, { path: '/tokens', method: 'DELETE', auth: true });
}

/** Deletes the account along with all its packages. Irreversible. */
export async function closeAccount(settings: MarketplaceSettings): Promise<number> {
	const response = await apiRequest(settings, {
		path: '/account',
		method: 'DELETE',
		auth: true,
	});

	const data = response.json as { deleted_packages?: number };
	return data.deleted_packages ?? 0;
}
