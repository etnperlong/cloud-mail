import { env } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { dbInit } from '../src/init/init';
import service from '../src/service/account-forward-service';
import app from '../src/hono/webs';
import jwtUtils from '../src/utils/jwt-utils';
import { email as receive } from '../src/email/email';
import emailService from '../src/service/email-service';
import settingService from '../src/service/setting-service';
import roleService from '../src/service/role-service';
import telegramService from '../src/service/telegram-service';
import webhookService from '../src/service/webhook-service';
import { settingConst } from '../src/const/entity-const';

const c = { env: { ...env, db: env.db, domain: ['local.example'], cf_account_id: 'test-account', cf_api_token: 'test-token', admin: 'admin@local.example' } };
const api = (result, result_info) => new Response(JSON.stringify({ success: true, result, result_info }));
const add = (email, accountId = 1, userId = 1) => service.add(c, { accountId, email }, userId);

beforeEach(async () => {
	await dbInit.intDB(c);
	await dbInit.v1_1DB(c);
	await dbInit.initAccountName(c);
	await env.db.batch([
		env.db.prepare('ALTER TABLE account ADD COLUMN all_receive INTEGER DEFAULT 0'),
		env.db.prepare('ALTER TABLE account ADD COLUMN sort INTEGER DEFAULT 0'),
		env.db.prepare("INSERT INTO user (user_id, email, type, password, salt) VALUES (1, 'one@local.example', 1, '', ''), (2, 'two@local.example', 1, '', '')"),
		env.db.prepare("INSERT INTO account (account_id, email, user_id) VALUES (1, 'one@local.example', 1), (2, 'two@local.example', 2), (3, 'alias@local.example', 1)")
	]);
	await dbInit.v3_3UserForwardDB(c);
	await env.db.prepare("INSERT INTO role_perm (role_id, perm_id) SELECT 1, perm_id FROM perm WHERE perm_key = 'account:forward'").run();
	vi.stubGlobal('fetch', vi.fn(async () => api({ verified: null })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mailbox forwarding with D1', () => {
	it('migration is repeatable and does not regrant revoked permissions', async () => {
		await dbInit.v3_3UserForwardDB(c);
		expect(await env.db.prepare("SELECT count(*) AS n FROM perm WHERE perm_key = 'account:forward'").first('n')).toBe(1);
		await env.db.prepare("DELETE FROM role_perm WHERE perm_id IN (SELECT perm_id FROM perm WHERE perm_key = 'account:forward')").run();
		await dbInit.v3_3UserForwardDB(c);
		expect(await env.db.prepare("SELECT count(*) AS n FROM role_perm WHERE perm_id IN (SELECT perm_id FROM perm WHERE perm_key = 'account:forward')").first('n')).toBe(0);
	});
	it('checks ownership before CF calls for every user action', async () => {
		await expect(add('dest@example.com', 2)).rejects.toMatchObject({ code: 403 });
		for (const method of ['list', 'remove', 'resend']) {
			await expect(service[method](c, { accountId: 2, forwardId: 1 }, 1)).rejects.toMatchObject({ code: 403 });
		}
		await expect(add('dest@example.com', -1)).rejects.toMatchObject({ code: 403 });
		expect(fetch).not.toHaveBeenCalled();
	});
	it('rejects invalid and local-domain addresses including JSON domain variables', async () => {
		for (const address of ['bad', '.x@example.com', 'x..y@example.com', 'x@-bad.example.com', 'Name <x@example.com>', 'x@LOCAL.EXAMPLE', 'x'.repeat(80) + '@example.com']) await expect(add(address)).rejects.toThrow();
		expect(() => service.validate({ env: { domain: '["LOCAL.EXAMPLE"]' } }, 'x@local.example')).toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it('normalizes and deduplicates per mailbox but permits shared destinations', async () => {
		await add(' Dest@Example.COM ');
		await expect(add('dest@example.com')).rejects.toThrow();
		await add('dest@example.com', 3);
		expect((await service.rows(c, 1))[0].email).toBe('dest@example.com');
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it('enforces the limit atomically during concurrent additions', async () => {
		const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => add(`dest${i}@example.com`)));
		expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(3);
		expect(await service.rows(c, 1)).toHaveLength(3);
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it('rolls back reserved capacity when CF rejects creation', async () => {
		fetch.mockResolvedValue(new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 }));
		await expect(add('dest@example.com')).rejects.toThrow();
		expect(await service.rows(c, 1)).toHaveLength(0);
	});
	it('finds existing destinations across CF pages without claiming a new email was sent', async () => {
		fetch.mockImplementation(async (url, options) => {
			if (options.method === 'POST') return new Response(JSON.stringify({ success: false, errors: [{ code: 1234 }] }), { status: 400 });
			if (url.endsWith('page=1')) return api(Array.from({ length: 50 }, (_, i) => ({ email: `other${i}@example.com`, verified: null })), { total_pages: 2 });
			return api([{ email: 'DEST@example.com', verified: 'verified' }], { total_pages: 2 });
		});
		expect(await add('dest@example.com')).toEqual({ sent: false, verified: 'verified' });
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it('retains cached state on API failure and clears removed destinations after refresh', async () => {
		fetch.mockResolvedValue(api({ verified: 'verified' }));
		await add('dest@example.com');
		fetch.mockRejectedValue(new Error('network'));
		const stale = await service.list(c, { accountId: 1 }, 1);
		expect(stale.refreshFailed).toBe(true);
		expect(stale.list[0].verified).toBe('verified');
		fetch.mockResolvedValue(api([]));
		await service.refreshAll(c);
		expect((await service.rows(c, 1))[0].verified).toBeNull();
	});
	it('resends via POST with a persistent cooldown', async () => {
		await add('dest@example.com');
		const [row] = await service.rows(c, 1);
		await expect(service.resend(c, { accountId: 1, forwardId: row.forwardId }, 1)).rejects.toThrow();
		await env.db.prepare('UPDATE account_forward SET last_requested = 0').run();
		await service.resend(c, { accountId: 1, forwardId: row.forwardId }, 1);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1][1].method).toBe('POST');
	});
	it('scopes deletion and cascades physical account deletion without deleting from CF', async () => {
		await add('dest@example.com');
		await add('dest@example.com', 2, 2);
		const [other] = await service.rows(c, 2);
		await service.remove(c, { accountId: 1, forwardId: other.forwardId }, 1);
		expect(await service.rows(c, 2)).toHaveLength(1);
		await env.db.prepare('DELETE FROM account WHERE account_id = 2').run();
		expect(await service.rows(c, 2)).toHaveLength(0);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it('forwards only verified cached addresses and isolates delivery failures', async () => {
		fetch.mockResolvedValueOnce(api({ verified: 'verified' })).mockResolvedValueOnce(api({ verified: 'verified' }));
		await add('first@example.com');
		await add('second@example.com');
		await add('pending@example.com');
		fetch.mockClear();
		const message = { forward: vi.fn().mockRejectedValueOnce(new Error('delivery failed')).mockResolvedValue(undefined) };
		await service.forward(c, message, { accountId: 1, userId: 1, isDel: 0 });
		expect(message.forward.mock.calls).toEqual([['first@example.com'], ['second@example.com']]);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('skips missing recipients, deleted accounts, revoked roles and missing config', async () => {
		fetch.mockResolvedValue(api({ verified: 'verified' }));
		await add('dest@example.com');
		const message = { forward: vi.fn() };
		await service.forward(c, message, null);
		await service.forward(c, message, { accountId: 1, userId: 1, isDel: 1 });
		const unconfigured = { env: { ...c.env, cf_api_token: '' } };
		await service.forward(unconfigured, message, { accountId: 1, userId: 1, isDel: 0 });
		expect((await service.list(unconfigured, { accountId: 1 }, 1)).configured).toBe(false);
		await env.db.prepare("DELETE FROM role_perm WHERE perm_id IN (SELECT perm_id FROM perm WHERE perm_key = 'account:forward')").run();
		await service.forward(c, message, { accountId: 1, userId: 1, isDel: 0 });
		expect(message.forward).not.toHaveBeenCalled();
	});
	it('admin view includes primary and alias destinations only for the selected user', async () => {
		await add('dest@example.com');
		await add('alias@example.com', 3);
		await add('other@example.com', 2, 2);
		expect((await service.adminList(c, { userId: 1 })).list.map(row => row.source).sort()).toEqual(['alias@local.example', 'one@local.example']);
	});
});


describe('forwarding entry points', () => {
	it('enforces RBAC on every HTTP endpoint and ownership even for an administrator', async () => {
		const ctx = { env: { ...c.env, jwt_secret: 'test-secret' } };
		const auth = { user: { userId: 1, email: 'one@local.example' }, tokens: ['session'], refreshTime: new Date().toISOString() };
		ctx.env.kv = { get: vi.fn(async () => auth) };
		const token = await jwtUtils.generateToken(ctx, { userId: 1, token: 'session' }, 60);
		const request = async (path, method = 'GET', body) => {
			const response = await app.request(path, { method, headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }, ctx.env);
			return response.json();
		};
		await env.db.prepare("DELETE FROM role_perm WHERE perm_id IN (SELECT perm_id FROM perm WHERE perm_key = 'account:forward')").run();
		for (const [path, method] of [['/account/forward?accountId=1', 'GET'], ['/account/forward', 'POST'], ['/account/forward?accountId=1', 'DELETE'], ['/account/forward/refresh', 'POST'], ['/account/forward/resend', 'POST'], ['/user/forward?userId=2', 'GET']]) {
			expect((await request(path, method, method === 'POST' ? { accountId: 1 } : undefined)).code).toBe(403);
		}
		auth.user.email = c.env.admin;
		expect((await request('/account/forward?accountId=2')).code).toBe(403);
		expect((await request('/user/forward?userId=2')).code).toBe(200);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('runs user forwarding after storage and before global filtering; preserves global integrations', async () => {
		fetch.mockResolvedValue(api({ verified: 'verified' }));
		await add('dest@example.com');
		const settings = {
			receive: settingConst.receive.OPEN, noRecipient: settingConst.noRecipient.OPEN,
			ruleType: settingConst.ruleType.RULE, ruleEmail: 'different@local.example',
			forwardStatus: settingConst.forwardStatus.OPEN, forwardEmail: 'global@example.com',
			tgBotStatus: settingConst.tgBotStatus.OPEN, tgChatId: 'test',
			webhookStatus: settingConst.webhookStatus.OPEN, webhookUrl: 'https://example.com/webhook'
		};
		vi.spyOn(settingService, 'query').mockResolvedValue(settings);
		vi.spyOn(roleService, 'selectByUserId').mockResolvedValue({ banEmail: '', availDomain: '' });
		vi.spyOn(emailService, 'receive').mockResolvedValue({ emailId: 1 });
		const complete = vi.spyOn(emailService, 'completeReceive').mockResolvedValue({ emailId: 1 });
		const tg = vi.spyOn(telegramService, 'sendEmailToBot').mockResolvedValue();
		const webhook = vi.spyOn(webhookService, 'sendEmail').mockResolvedValue();
		const message = to => ({ to, raw: new Response('From: sender@example.com\r\nTo: ' + to + '\r\nSubject: test\r\n\r\nhello').body,
			forward: vi.fn(async () => { expect(complete).toHaveBeenCalled(); }), setReject: vi.fn() });
		const filtered = message('one@local.example');
		await receive(filtered, c.env, {});
		expect(filtered.forward.mock.calls).toEqual([['dest@example.com']]);
		expect(tg).not.toHaveBeenCalled();
		expect(webhook).not.toHaveBeenCalled();
		settings.ruleEmail = 'one@local.example';
		const normal = message('one@local.example');
		await receive(normal, c.env, {});
		expect(normal.forward.mock.calls).toEqual([['dest@example.com'], ['global@example.com']]);
		expect(tg).toHaveBeenCalledTimes(1);
		expect(webhook).toHaveBeenCalledTimes(1);
		settings.ruleEmail = 'missing@local.example';
		const noRecipient = message('missing@local.example');
		await receive(noRecipient, c.env, {});
		expect(noRecipient.forward.mock.calls).toEqual([['global@example.com']]);
		complete.mockRejectedValue(new Error('storage failed'));
		const failed = message('one@local.example');
		await expect(receive(failed, c.env, {})).rejects.toThrow('storage failed');
		expect(failed.forward).not.toHaveBeenCalled();
	});
});
