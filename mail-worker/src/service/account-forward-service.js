import { and, eq, sql } from 'drizzle-orm';
import orm from '../entity/orm';
import account from '../entity/account';
import accountForward from '../entity/account-forward';
import accountService from './account-service';
import userService from './user-service';
import permService from './perm-service';
import cfAddressService from './cf-address-service';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import { isDel, userConst } from '../const/entity-const';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const accountForwardService = {
	limit(c) {
		const limit = Number(c.env.forward_max_addresses ?? 3);
		return Number.isSafeInteger(limit) && limit > 0 ? limit : 3;
	},

	validate(c, value) {
		const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
		const name = emailUtils.getName(email);
		const domain = emailUtils.getDomain(email);
		if (email.length > 90 || !verifyUtils.isEmail(email) || name.length > 64 || name.startsWith('.') ||
			name.endsWith('.') || name.includes('..') || domain.split('.').some(label =>
				label.length > 63 || label.startsWith('-') || label.endsWith('-'))) throw new BizError(t('notEmail'));
		const domains = typeof c.env.domain === 'string' ? JSON.parse(c.env.domain) : c.env.domain;
		if (!Array.isArray(domains)) throw new BizError(t('noDomainVariable'));
		if (domains.some(domain => domain.trim().replace(/^@/, '').toLowerCase() === emailUtils.getDomain(email))) {
			throw new BizError(t('forwardOwnDomain'));
		}
		return email;
	},

	async owner(c, value, userId) {
		const accountId = Number(value);
		if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new BizError(t('noUserAccount'), 403);
		const row = await accountService.selectById(c, accountId);
		if (!row || row.userId !== userId) throw new BizError(t('noUserAccount'), 403);
		return row;
	},

	rows(c, accountId) {
		return orm(c).select().from(accountForward).where(eq(accountForward.accountId, accountId)).all();
	},

	async sync(c, rows) {
		if (!rows.length || !cfAddressService.configured(c)) return;
		const addresses = await cfAddressService.list(c);
		// Update only the snapshot: a concurrent add must not be marked unverified.
		for (let offset = 0; offset < rows.length; offset += 50) {
			await orm(c).batch(rows.slice(offset, offset + 50).map(row =>
				orm(c).update(accountForward).set({ verified: addresses.get(row.email) || null })
					.where(eq(accountForward.forwardId, row.forwardId))));
		}
	},

	async list(c, params, userId) {
		const row = await this.owner(c, params.accountId, userId);
		const configured = cfAddressService.configured(c);
		let refreshFailed = false;
		try {
			await this.sync(c, await this.rows(c, row.accountId));
		} catch (error) {
			console.error('刷新用户转发状态失败:', error);
			refreshFailed = true;
		}
		return { configured, limit: this.limit(c), refreshFailed, list: await this.rows(c, row.accountId) };
	},

	async add(c, params, userId) {
		const row = await this.owner(c, params.accountId, userId);
		if (!cfAddressService.configured(c)) throw new BizError(t('forwardNotConfigured'));
		const email = this.validate(c, params.email);
		// A single D1 statement reserves capacity before contacting CF, including concurrent requests.
		const inserted = await orm(c).get(sql`INSERT INTO account_forward (account_id, email, last_requested)
			SELECT ${row.accountId}, ${email}, ${Date.now()}
			WHERE (SELECT COUNT(*) FROM account_forward WHERE account_id = ${row.accountId}) < ${this.limit(c)}
			ON CONFLICT(account_id, email) DO NOTHING RETURNING forward_id`);
		if (!inserted) throw new BizError(t('forwardDuplicateOrLimit', { count: this.limit(c) }));
		try {
			const result = await cfAddressService.create(c, email);
			await orm(c).update(accountForward).set({ verified: result.verified })
				.where(eq(accountForward.forwardId, inserted.forward_id)).run();
			return result;
		} catch (error) {
			await orm(c).delete(accountForward).where(eq(accountForward.forwardId, inserted.forward_id)).run();
			throw error;
		}
	},

	async remove(c, params, userId) {
		const row = await this.owner(c, params.accountId, userId);
		// Never delete the shared CF destination; other mailboxes may still use it.
		await orm(c).delete(accountForward).where(and(eq(accountForward.accountId, row.accountId),
			eq(accountForward.forwardId, Number(params.forwardId)))).run();
	},

	async resend(c, params, userId) {
		const row = await this.owner(c, params.accountId, userId);
		if (!cfAddressService.configured(c)) throw new BizError(t('forwardNotConfigured'));
		const now = Date.now();
		const target = await orm(c).update(accountForward).set({ lastRequested: now })
			.where(and(eq(accountForward.accountId, row.accountId), eq(accountForward.forwardId, Number(params.forwardId)),
				sql`${accountForward.lastRequested} <= ${now - 60000}`)).returning().get();
		if (!target) throw new BizError(t('forwardResendWait'));
		this.validate(c, target.email);
		const result = await cfAddressService.create(c, target.email);
		await orm(c).update(accountForward).set({ verified: result.verified })
			.where(eq(accountForward.forwardId, target.forwardId)).run();
		return result;
	},

	async adminList(c, params) {
		const rows = await orm(c).select({
			forwardId: accountForward.forwardId, accountId: account.accountId, source: account.email,
			email: accountForward.email, verified: accountForward.verified
		}).from(accountForward).innerJoin(account, eq(account.accountId, accountForward.accountId))
			.where(eq(account.userId, Number(params.userId))).all();
		return { configured: cfAddressService.configured(c), list: rows };
	},

	async refreshAll(c) {
		if (!cfAddressService.configured(c)) return;
		try {
			await this.sync(c, await orm(c).select().from(accountForward).all());
		} catch (error) {
			console.error('定时刷新用户转发状态失败:', error);
		}
	},

	async forward(c, message, recipient) {
		if (!recipient || recipient.isDel !== isDel.NORMAL || !cfAddressService.configured(c)) return;
		try {
			const user = await userService.selectById(c, recipient.userId);
			if (!user || user.status === userConst.status.BAN) return;
			if (user.email !== c.env.admin && !(await permService.userPermKeys(c, user.userId)).includes('account:forward')) return;
			const rows = await this.rows(c, recipient.accountId);
			for (const row of rows.filter(row => row.verified).slice(0, this.limit(c))) {
				try {
					this.validate(c, row.email);
					await message.forward(row.email);
				} catch (error) {
					console.error(`用户转发邮箱 ${row.email} 失败:`, error);
				}
			}
		} catch (error) {
			console.error('用户邮件转发失败:', error);
		}
	}
};
export default accountForwardService;
