import { eq } from 'drizzle-orm';
import orm from '../entity/orm';
import accountForward from '../entity/account-forward';
import setting from '../entity/setting';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const cfAddressService = {
	configured(c) {
		return !!(c.env.cf_account_id?.trim() && c.env.cf_api_token?.trim());
	},

	async request(c, method, query = '', email) {
		if (!this.configured(c)) throw new BizError(t('forwardNotConfigured'));
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.env.cf_account_id)}/email/routing/addresses${query}`, {
			method,
			headers: { Authorization: `Bearer ${c.env.cf_api_token}`, 'Content-Type': 'application/json' },
			body: email ? JSON.stringify({ email }) : undefined,
			signal: AbortSignal.timeout(15000)
		});
		const data = await response.json();
		if (!response.ok || !data.success) {
			console.error('Cloudflare Email Routing API:', response.status, data.errors);
			const error = new BizError(t('forwardApiError'));
			error.status = response.status;
			throw error;
		}
		return data;
	},

	async list(c) {
		const addresses = new Map();
		for (let page = 1; ; page++) {
			const data = await this.request(c, 'GET', `?per_page=50&page=${page}`);
			if (!Array.isArray(data.result)) throw new BizError(t('forwardApiError'));
			for (const row of data.result) addresses.set(row.email.toLowerCase(), { id: row.id, verified: row.verified || null });
			if (data.result.length < 50 || page >= data.result_info?.total_pages) break;
		}
		return addresses;
	},

	async create(c, email) {
		try {
			const data = await this.request(c, 'POST', '', email);
			return { verified: data.result?.verified || null, sent: true };
		} catch (error) {
			// CF returns an error for an existing destination. Confirm it by listing,
			// rather than relying on an undocumented duplicate error code.
			if (error.status !== 400 && error.status !== 409) throw error;
			const addresses = await this.list(c);
			if (!addresses.has(email)) throw error;
			return { verified: addresses.get(email).verified, sent: false };
		}
	},

	async delete(c, email) {
		const address = (await this.list(c)).get(email.toLowerCase());
		if (address?.id) await this.request(c, 'DELETE', `/${encodeURIComponent(address.id)}`);
	},
	async deleteIfUnreferenced(c, email) {
		if (!this.configured(c)) return;
		const remaining = await orm(c).select({ forwardId: accountForward.forwardId }).from(accountForward)
			.where(eq(accountForward.email, email)).get();
		if (remaining) return;
		const { forwardEmail } = await orm(c).select({ forwardEmail: setting.forwardEmail }).from(setting).get() || {};
		if (forwardEmail?.split(',').some(address => address.trim().toLowerCase() === email)) return;
		await this.delete(c, email);
	}
};
export default cfAddressService;
