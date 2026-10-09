import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import account from './account';

export const accountForward = sqliteTable('account_forward', {
	forwardId: integer('forward_id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull().references(() => account.accountId, { onDelete: 'cascade' }),
	email: text('email').notNull(),
	verified: text('verified'),
	lastRequested: integer('last_requested').notNull().default(0)
}, table => [uniqueIndex('idx_account_forward_email').on(table.accountId, table.email)]);
export default accountForward;
