// 会话域常量（#778 · #747 C 节）：幂等 key 形态、消息/标题上限、自动标题截断。
// 单一来源：路由中间件（32-hex 校验）、zod schema（长度上限）、service（自动标题）共用。

// 发消息幂等 key（story 7 · #747 C 节「32-hex 幂等 key」钉死形态）。
export const MESSAGE_KEY_REGEX = /^[0-9a-f]{32}$/

// 消息内容上限（字符；全局 body limit 256KB 之内的域级护栏）。
export const MESSAGE_CONTENT_MAX = 65536

// 会话标题上限（story 5 手改标题）。
export const TITLE_MAX = 200

// 自动生成标题截断（story 5：首条用户消息前缀派生）。
export const TITLE_AUTO_MAX = 30

// 恢复菜单三态（#747 UX · #782）：all = 对话+文件同回（缺省）；chat = 只回对话（文件保持
// 现状永久化——水位推进）；files = 只回文件（对话面零改动）。单点派生（对齐 JOURNAL_OPS
// 先例）：zod schema 与 RewindScope 类型同源，防双处手写漂移。
export const REWIND_SCOPES = ['all', 'chat', 'files'] as const
export type RewindScope = (typeof REWIND_SCOPES)[number]
