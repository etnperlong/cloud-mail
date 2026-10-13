# 用户自助邮件转发

每个邮箱独立配置外部转发地址，默认最多 3 个。入口位于邮箱侧栏的设置菜单；个人设置也提供主邮箱入口。用户管理的“邮件转发”可以查看该用户主邮箱及附加邮箱的缓存状态，仅供查看。

## 配置与升级

1. 为目标 Cloudflare 账号创建 API Token，授予账号级 **Email Routing Addresses Write** 权限（控制台中为 Email Routing Addresses 的 Edit）。该权限支持创建、删除和列表查询；此功能不需要修改域名路由规则的权限。
2. 由于部署使用 `wrangler-action.toml` 且未启用 `keep_vars`，`cf_account_id` 和 `cf_api_token` 必须作为 Worker secrets 提供（代码分别从 `c.env.cf_account_id` 和 `c.env.cf_api_token` 读取；部署不会删除已有 secrets）。任选一种方式：
   - **GitHub Actions（推荐）**：在仓库 Settings → Secrets and variables → Actions 中添加 secret `CF_API_TOKEN`；`CF_ACCOUNT_ID` 可选，未设置时使用部署用的 `CLOUDFLARE_ACCOUNT_ID`。可选 `FORWARD_MAX_ADDRESSES`（secret 或 variable）。部署步骤会通过 `wrangler deploy --secrets-file` 把它们与本次部署一起上传为 Worker secrets；未设置的项不会上传，也不会覆盖已有值。
   - **手动**：在 `mail-worker` 目录中运行 `pnpm wrangler secret put cf_account_id --name <deployed-worker-name>` 和 `pnpm wrangler secret put cf_api_token --name <deployed-worker-name>`，或在 Cloudflare Dashboard 的 Worker Variables and Secrets 中添加为 Secret。

   `cf_api_token` 会进入 Worker 运行时，不要复用部署用的 `CLOUDFLARE_API_TOKEN`（权限过大），应单独创建只含上一步权限的 token。可选 `forward_max_addresses` 为正整数，默认 `3`；降低上限不会删除原有记录，但收信只尝试上限内的已验证地址。
3. 按项目原流程构建前端并发布 Worker。凭据缺失时禁止添加和重发，界面显示“未配置”；仍允许删除本地转发关联，原收信流程不受影响。
4. 请求现有初始化入口 `GET https://<站点域名>/api/init/<jwt_secret>`，响应应为 `success`。`v3_3UserForwardDB` 在原升级链之后创建表、索引和权限，可以重复运行；失败不会被吞掉或报告成功。此入口包含敏感 JWT secret，应按现有运维方式使用。
5. 管理员在“权限控制”中为需要使用的角色勾选“邮箱侧栏 → 邮箱转发”，权限 key 为 `account:forward`。升级不自动授权已有角色，也不会重新授予已撤销权限。用户刷新页面或重新登录以更新入口。
6. 用户添加外部地址，在目标邮箱点击 Cloudflare 验证链接，然后点击“刷新状态”。状态成为“已生效”后，用一封实际来信确认投递。保留既有每小时 cron `0 * * * *`，用于同步验证状态。

生产发布、真实验证邮件和实际投递需要另行执行；本功能测试使用本地 D1 和模拟 Cloudflare API。

[Cloudflare 创建目标地址 API](https://developers.cloudflare.com/api/resources/email_routing/subresources/addresses/methods/create/)；[目标地址列表 API](https://developers.cloudflare.com/api/resources/email_routing/subresources/addresses/methods/list/)；[删除目标地址 API](https://developers.cloudflare.com/api/resources/email_routing/subresources/addresses/methods/delete/)。

## 数据与权限

独立表 `account_forward` 避免向上游 `account` 表增加字段：

| 字段 | 含义 |
| --- | --- |
| `forward_id` | 自增主键 |
| `account_id` | 所属邮箱，外键关联 account，物理删除邮箱时级联删除 |
| `email` | 去首尾空白、小写化的外部地址 |
| `verified` | Cloudflare 验证时间戳，未验证或 CF 中已移除为 NULL |
| `last_requested` | 最近一次验证请求的毫秒时间，用于 60 秒重发间隔 |

`(account_id, email)` 不区分大小写唯一。单条条件 INSERT 在 D1 内预留名额，保证并发新增不突破上限；CF 请求失败时释放本次名额。校验复用现有邮箱工具，补充本地点号、域名标签和 CF 90 字符长度限制；禁止目标域名匹配 `env.domain`，同时支持数组和 JSON 字符串配置。

所有 `/account/forward` 接口要求 `account:forward`，并检查正常状态的邮箱确实属于当前用户。管理员的自助接口同样不能跨用户修改。`GET /user/forward?userId=...` 沿用 `user:query`，只读返回该用户全部邮箱的关联和缓存状态，不访问 CF。

| 接口 | 用途 |
| --- | --- |
| `GET /account/forward?accountId=...` | 查看配置并尝试刷新 |
| `POST /account/forward/refresh` | 刷新，body 为 `{accountId}` |
| `POST /account/forward` | 新增，body 为 `{accountId, email}` |
| `DELETE /account/forward?accountId=...&forwardId=...` | 删除本地关联 |
| `POST /account/forward/resend` | 重发请求，body 为 `{accountId, forwardId}` |

以上路径均位于 `/api` 前缀下，沿用项目认证和结果格式。未授权按项目现有响应约定返回业务码 403。

## 投递与缓存

邮件完成入库后、现有全局规则过滤前执行用户转发；不改变全局转发、TG、webhook 的条件。单个地址投递失败以及用户转发查询失败只记录日志，不阻止后续全局流程。无匹配收件人的归档邮件不走用户转发。

收信路径只查询 D1，不调用 CF 管理 API；跳过未验证地址、已删除邮箱、已删除或禁用用户，以及已撤销 `account:forward` 的角色。管理员不受角色授权限制。收信时再次检查域名，避免域名配置变化后出现系统内转发。

查看、手动刷新及小时任务完整分页查询 CF 地址（每页 50 条），同步已验证和未验证记录，也清除已被 CF 移除的地址状态。分页全部成功后才开始更新缓存；API 失败保留原缓存，界面提示状态可能过期。小时任务失败不会中断原有定时任务。

## 限制与后续维护

- CF 的目标验证属于整个账号。同一外部地址可以被多个邮箱使用；删除转发关联或物理删除邮箱后，只有在没有其他本地转发记录或现有全局转发配置引用时，才尝试删除 CF 目标地址。CF 清理失败不会影响本地删除，也不会阻止后续全局转发。
- 目标地址删除检查只覆盖本应用的邮箱关联和全局转发配置；不要让这些地址同时被 Cloudflare 控制台中独立维护的路由规则引用，因为这类外部引用不会被查询。
- “重新发送验证”重新 POST。CF 若返回地址已存在，系统查询并同步现有状态，不删除再创建共享目标，也不宣称已发送新邮件。未验证且无法重发时，应查找原验证邮件，或由管理员在 CF 控制台处理。
- CF API 或定时任务失败时可能使用旧缓存；实际转发仍由 Cloudflare 检查目标是否允许。界面“已生效”表示缓存已验证，投递仍受角色权限、邮箱状态、域名配置以及 CF 投递限制影响。
- 用户与全局转发独立执行，配置相同目标可能收到重复邮件。不会为去重而改变现有全局转发行为。
- 同步需要扫描 CF 账号的完整目标列表；大量账号目标或大量本地关联时，应关注 Worker 运行配额，再考虑分批调度。
- 原有 `vitest.config.js` 引用未提供的 `wrangler.jsonc`，且 `test/index.spec.js` 仍是 Hello World 模板；后续应独立修复通用测试入口。现有 `package.json` 的 `test` 脚本实际执行部署，不能用于本地测试。本功能在 `mail-worker` 下使用 `npx vitest run --config vitest.forward.config.js`，不需要生产绑定或真实凭据。现有 Workers 测试运行时会将兼容日期回退至 2025-03-10，后续应随测试工具升级消除差异。
- 当前前端构建还存在上游 `NODE_ENV=release`、旧 Browserslist 数据及大于 500 kB 的分块提示，可单独处理，避免与转发功能混合修改。
