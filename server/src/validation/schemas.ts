import { z } from 'zod'
import {
  API_CHOICES,
  API_KEY_ENV_ID_REGEX,
  ALLOWED_API_KEY_ENV_IDS,
  MODEL_INPUT_MODALITIES,
  PROVIDER_ID_REGEX,
} from '../models/values'
import { parseHttpOrigin } from '../runner/allowlist'
import { MESSAGE_CONTENT_MAX, REWIND_SCOPES, TITLE_MAX } from '../sessions/values'

// 请求体 schema（zod）。校验失败 → 90002 + flatten().fieldErrors（{field:[errors]}）。
// username 格式：字母/数字/下划线/连字符，3–30 字符（近似 Django UnicodeUsernameValidator，更严）。
export const USERNAME_REGEX = /^[A-Za-z0-9_-]{3,30}$/
// bcryptjs 截断 >72 字节的输入（72 字节后丢弃）。若不对密码设 UTF-8 字节上限，首 72 字节
// 相同而后续不同的两个密码可互登（碰撞面）。共享此校验：login / 建号 / 改密一律拒绝 >72 字节。
// Codex #342 四轮 P2。
const BYTE72_MAX = 72
const BYTE72_ERR = `密码不能超过 ${BYTE72_MAX} 字节`

function max72Bytes(v: string): boolean {
  return Buffer.byteLength(v, 'utf8') <= BYTE72_MAX
}

export const loginSchema = z.object({
  username: z.string().min(1, '不能为空'),
  password: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
})

export const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
  newPassword: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
})

// 建账号（admin register / users POST 共用）：用户名格式 + 密码≥8 + 可选 email + 可选配额。
export const userCreateSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, '用户名仅允许字母、数字、下划线、连字符（3-30 位）'),
  password: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
  email: z.string().email('email 格式非法').optional(),
  maxContainers: z.number().int().optional(),
})

// 改账号（users PATCH）：可改 active / 配额。
export const userPatchSchema = z.object({
  isActive: z.boolean().optional(),
  maxContainers: z.number().int().optional(),
})

// 容器名 DNS-label（#334 / 平移 NAME_VALIDATOR）：小写字母开头，3–30 位，仅 [a-z0-9-]。
// 防路径分隔符 / .. / 空格 / 大写（同时防 instances/<name>/ 目录穿越与 docker-name 注入）。
export const CONTAINER_NAME_REGEX = /^[a-z][a-z0-9-]{2,29}$/

// 建容器（containers POST）：仅需 name（端口/token/home 由编排器决定）。校验失败 → 90002 + data.name。
export const containerCreateSchema = z.object({
  name: z
    .string()
    .regex(CONTAINER_NAME_REGEX, 'name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'),
})

// AutoFigure（T01，docs/autofigure/tickets/T01-authenticated-figure-creation.md）：
// Figure 创建请求体。仅 prompt 一项；ownerId 不接收——zod object 默认 strip 未知字段，客户端
// 随请求提交的 userId（若有）被丢弃，绝不作为归属来源（ownerId 只来自认证身份，见 figures/routes.ts）。
// trim 对齐 modelProviderWriteSchema.base_url 先例（纯空白语义为空 → 拒）；上限 4000 字符。
export const figureCreateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt 不能为空').max(4000, 'prompt 过长（≤4000 字符）'),
})

// base_url URL 形态门（#775，731 §5.1 第一层 ①）：.refine 复用 runner/allowlist parseHttpOrigin
// 权威解析（scheme/凭证/端口域全量校验与 service 层同源，#812 打捞）——消除 zod 阶段与
// service 阶段两份 URL 定义漂移面（本地正则曾放行 :99999 端口越界，service 层 parse 才拒）。
// 同 schema 内 api_key_env_id / models 已有 .refine 先例，openapi 生成面无增量影响。
const httpUrlShape = (v: string): boolean => {
  try {
    parseHttpOrigin(v)
    return true
  } catch {
    return false
  }
}

// 建/改 model provider（models POST/PUT，#336）：snake_case wire（平移 Django
// ModelProviderWriteSerializer）。provider_id / api_key_env_id 经格式 + 成员校验（r28 §1），
// api 限两值（r28 §1.3），models 至少一条且每条含非空 id（无 model 无法派生默认模型引用）。
// models 条目形状校验（#366 codex 三轮 P2）：已知字段类型严格校验（name/reasoning/input/cost/
// contextWindow/maxTokens，对齐前端 ModelEntryDTO），未知扩展字段 passthrough 透传（前端表单
// 收集的其余字段原样保留）。原来 `z.record(z.string(), z.unknown())` 让 {id:'m', name:{}} 这种
// 非法形状入库——ProviderConfigBuilder 把 name 对象原样落盘为 alias/model 名（应为 string）→
// 热加载拒绝、运行时落后 DB。入站校验拒绝，生成文件才可能符合 OpenClaw 形状。
// base_url trim 后校验（#366 codex P2）：zod min(1) 不 trim，纯空格 '   ' 语义为空仍通过——
// 对齐 Django CharField 默认 trim_whitespace，防「空 baseUrl 入库 + 写盘报成功热加载」。
// 校验失败 → 90002 + 各字段明细（api_key_env_id 非法格式/未注入 env 同入 data.api_key_env_id）。
export const modelProviderWriteSchema = z.object({
  provider_id: z
    .string()
    .regex(PROVIDER_ID_REGEX, 'provider_id 须以小写字母开头，1–64 位，仅含小写字母、数字、连字符'),
  api: z.enum(API_CHOICES),
  base_url: z
    .string()
    .trim()
    .min(1, 'base_url 不能为空')
    .max(512, 'base_url 过长')
    .refine(httpUrlShape, 'base_url 须为 http(s)://<host>[:<port>][/<path>] 完整 URL'),
  api_key_env_id: z
    .string()
    .regex(API_KEY_ENV_ID_REGEX, 'api_key_env_id 须大写字母开头，仅含大写字母、数字、下划线（1–128 位）')
    .refine(
      (v) => ALLOWED_API_KEY_ENV_IDS.has(v),
      'api_key_env_id 须为容器已注入的 env（当前仅：LLM_API_KEY）',
    ),
  auth_header: z.boolean().default(true),
  models: z
    .array(
      z
        .object({
          id: z.string().min(1, '每条 model 须含非空 id'),
          name: z.string().optional(),
          reasoning: z.boolean().optional(),
          // #366 codex 四轮 P2：input 限 r28 §1.2 枚举（text/image/audio/video/pdf）——非法取值
          // （如 "bogus"）原样落盘会被 OpenClaw 热加载校验拒绝，DB 却已提交报成功。
          input: z.array(z.enum(MODEL_INPUT_MODALITIES)).optional(),
          cost: z
            .object({
              input: z.number(),
              output: z.number(),
              cacheRead: z.number(),
              cacheWrite: z.number(),
            })
            .optional(),
          contextWindow: z.number().optional(),
          maxTokens: z.number().optional(),
        })
        .passthrough(), // 未知扩展字段透传（前端表单收集的其余字段原样保留）
    )
    .min(1, '须至少一条 model（用于派生默认模型引用）')
    // #366 codex 五轮 P2：同 provider 内 model id 须唯一。重复 id 让 ProviderConfigBuilder 生成相同
    // <pid>/<mid> ref —— primary 自指进 fallbacks + aliases 键覆盖，盘上配置歧义、DB 却报成功
    // （与 input 枚举同根：入站拒，生成文件才可能符合 OpenClaw 形状）。path 落 models → 90002 明细。
    .refine(
      (models) => new Set(models.map((m) => String(m.id))).size === models.length,
      { message: '同 provider 内 model id 须唯一', path: ['models'] },
    ),
})

// ---------------------------------------------------------------------------
// provider_endpoints admin CRUD（#775，731 §3.1——端点白名单，admin 管理，面板级）。
// wire snake_case 对齐 models 域：scheme/host/port/note。匹配语义 = origin 精确匹配
// （scheme+host+port；port 缺省/NULL = scheme 默认端口），禁路径/子域通配——host 只收精确
// hostname（点分标签，小写；全数字标签天然覆盖 IPv4 字面量，IPv6 字面量 V1 不收）。
// 'http' 限 dev 的生产门在 service 层（zod 保持纯净不读 env）。校验失败 → 90002 字段级。
// ---------------------------------------------------------------------------

// 精确 hostname：点分标签（每段字母/数字/连字符、首尾非连字符）——zod .toLowerCase()
// 归一化（大写输入折叠为小写，防 'API.Example.com' 与 'api.example.com' 两行同义白名单；
// 归一化后重复建 → 40041，测试见 providerEndpoints.test.ts「大写输入归一化为小写」）。
export const ENDPOINT_HOST_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

export const providerEndpointWriteSchema = z.object({
  scheme: z.enum(['https', 'http'], {
    errorMap: () => ({ message: "scheme 仅支持 'https' 或 'http'（http 限开发环境）" }),
  }),
  host: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'host 不能为空')
    .max(253, 'host 过长（≤253 字符）')
    .regex(ENDPOINT_HOST_REGEX, 'host 须为精确域名（点分小写标签，禁通配符/路径/端口混入）'),
  port: z
    .number()
    .int('port 须为整数')
    .min(1, 'port 须为 [1, 65535]')
    .max(65535, 'port 须为 [1, 65535]')
    .nullable()
    .optional(),
  note: z.string().max(200, 'note 过长（≤200 字符）').optional(),
})

// ---------------------------------------------------------------------------
// 会话域（#778 · #747 C 节会话 REST 全件）。幂等 key 的 32-hex 形态校验在路由中间件
// requireMessageKey（header 面）；此处只管 body。
// ---------------------------------------------------------------------------
export const sessionCreateSchema = z.object({
  title: z.string().trim().max(TITLE_MAX, `title 过长（≤${TITLE_MAX} 字符）`).optional(),
})

export const sessionPatchSchema = z.object({
  title: z.string().trim().min(1, 'title 不能为空').max(TITLE_MAX, `title 过长（≤${TITLE_MAX} 字符）`),
})

export const messageSendSchema = z.object({
  content: z
    .string()
    .min(1, 'content 不能为空')
    .max(MESSAGE_CONTENT_MAX, `content 过长（≤${MESSAGE_CONTENT_MAX} 字符）`),
  // #780 附件引用（D6：单消息 ≤4 件，service.linkToMessage 权威校验 + 归属/session 门）。
  // 只存引用不存字节——字节在沙箱 /lab/uploads/<attachmentId>/，本字段是雪花 attachmentId 列表。
  attachmentIds: z.array(z.string()).max(4, '单消息最多 4 个附件').optional(),
})

// resume 决策载荷：#783 审批漏斗接构造，本票机制面直通——decisions 形状校验归 #783（此处
// 只放行可选透传，RunService 命令面 JSON 序列化兼容任意 JSON 值）。
export const sessionResumeSchema = z.object({
  decisions: z.unknown().optional(),
})

// ---------------------------------------------------------------------------
// rewind / fork（#781 · #747 story 16/18 + #782 三态）。锚点一律以消息行表达（产品面 =
// 选历史消息）；checkpoint 解析在 service（resolveRewindAnchor）。branch-switch 机制 #770 已取消。
// scope（#747 UX 恢复菜单三态）：all = 对话+文件同回（缺省）；chat = 只回对话；files = 只回文件。
// ---------------------------------------------------------------------------
export const sessionRewindSchema = z.object({
  messageId: z.string().min(1, 'messageId 不能为空'),
  scope: z.enum(REWIND_SCOPES).optional(),
})

export const sessionRewindPreviewSchema = z.object({
  messageId: z.string().min(1, 'messageId 不能为空'),
})

export const sessionForkSchema = z.object({
  messageId: z.string().min(1).optional(), // 缺省 = 当前活跃头（指针或最新锚点）
  title: z.string().trim().max(TITLE_MAX, `title 过长（≤${TITLE_MAX} 字符）`).optional(),
})

export const sessionApprovalSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(2000).optional(),
})

// ---------------------------------------------------------------------------
// plugins（#788 · #752 R8）：启用位 PUT（{enabled: boolean}；幂等 upsert）。
// pluginId = 目录 id（kebab-case，与 plugins/registry PLUGIN_ID_REGEX 同形）。
// ---------------------------------------------------------------------------
export const PLUGIN_ID_REGEX = /^[a-z][a-z0-9-]*$/

export const pluginEnablementSchema = z.object({
  enabled: z.boolean(),
})
