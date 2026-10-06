// 五位分层码表（#312 最终准据 + #319 转译码 + #333 执行期新增 10005）。
// 单一来源：所有信封码在此定义，路由/中间件引用常量名而非裸数字。
//
// 段：0 成功 · 1xxxx 通用/鉴权/账号 · 2xxxx 容器 · 3xxxx wiki · 4xxxx models ·
//     5xxxx 会话/run（#747 C 节；chat/pairing 的 WS close codes 为另一传输面不在此列）·
//     6xxxx files · 7xxxx figures · 9xxxx 系统/校验。完整表见 docs/research/319-api-contract.md §1。

export const CODE = {
  OK: 0,
  // 1xxxx 通用 / 鉴权
  UNAUTHENTICATED: 10001, // 无/坏 access token（转译 401）
  LOGIN_FAILED: 10002, // 用户名/密码错（转译 401）
  REFRESH_INVALID: 10003, // refresh 缺失/无效/已撤销/重放
  FORBIDDEN: 10004, // 角色不足（user 调 admin-only / 跨用户，转译 403）
  MUST_CHANGE_PASSWORD: 10005, // #333 新增：mustChangePassword 拦截（规格未定义码，执行期微调）
  // 1xxxx 账号管理（#328）
  USER_NOT_FOUND: 10041, // 用户不存在 / 越权（同码防探测）
  USERNAME_INVALID: 10042, // 用户名格式非法
  QUOTA_INVALID: 10043, // 配额非法
  CANNOT_DISABLE_SELF: 10044, // 不可禁用自己
  // 3xxxx wiki（#335 平移 wiki 域；#319 §1.3 转译码）
  WIKI_PAGE_NOT_FOUND: 30040, // 页不存在 / 越权（同码防探测）
  WIKI_PAGE_EXISTS: 30041, // 新建页已存在（POST 409 转译）
  // #790（#747·20 · G 节 wiki 三通道③）：wiki 全量更新独立 run 在飞互斥——对齐 20043 busy
  // 「42+ 域专用」锁式（30040/30041 之后续号）。
  WIKI_UPDATE_IN_PROGRESS: 30042, // wiki 全量更新已在进行（独立 run 全局串行，PUT 触发面）
  // 4xxxx models（#336 平移 models 域；#319 §1.3 转译码）
  PROVIDER_NOT_FOUND: 40040, // provider 不存在 / 越权（同码防探测）；#775 起端点白名单管理域
  // 复用同码（models 配置段「40 不存在」锁式）：provider_endpoint 不存在（DELETE）。
  PROVIDER_ID_CONFLICT: 40041, // 同 owner provider_id 冲突（POST/PUT，unique(ownerId, providerId) 约束；#771 归属上移）；
  // #775 起端点白名单管理域复用同码（models 配置段「41 冲突」锁式）：provider_endpoint origin 冲突
  //（POST，含 NULL-port 等价语义查重——SQLite UNIQUE NULL 不判重）。
  // #775（731 §5.1/§5.3 + #747 C 节错误码新增）：40042 运行时白名单未命中（实例构造复验 / fetch
  // wrapper 验最终请求 origin / redirect 禁随）；40043 并发配额已满（per-user maxConcurrentRuns
  // 或全局 RUNNER_MAX_CONCURRENT_RUNS）。注意 40042 仅运行时层——CRUD 层白名单未命中是 90002
  // 字段级（731 §5.1 第一层），两层的错误面刻意不同。
  PROVIDER_ENDPOINT_NOT_ALLOWED: 40042, // 端点不在白名单（运行时双层校验第二层）
  CONCURRENCY_QUOTA_EXCEEDED: 40043, // 并发配额已满（per-user 或全局在飞 run 上限）
  // 6xxxx files（#589 统一文件 CRUD；6xxxx 段为 319 §1.1 未分配段，按「40 不存在 / 41 冲突」锁式）
  FILE_NOT_FOUND: 60040, // 文件不存在（GET/PUT/DELETE）
  FILE_EXISTS: 60041, // 新建文件已存在（POST 冲突）
  // 7xxxx figures（AutoFigure，docs/autofigure/tickets/）：
  // T05 读路径（T05-figure-history-ownership.md）：70040 = 不存在/越权同码防探测（镜像各域
  // 20040/30040/40040/60040 的 getInstanceForUser 锁式）。T02 幂等冲突 70041（对齐「41 冲突」锁）。
  // T06 PNG 下载（T06-artifact-persistence-png.md · spec §3「未完成/失败给明确应用级响应，不返回
  // 模糊 500」）：70042/70043 为 70040/70041 之后的域专用续号（对齐 20042 quota/20043 busy 的
  // 「40 不存在 / 41 冲突 / 42+ 域专用」锁式；确切码值经 spec §4 / grilling §9 委托实现定准）。
  FIGURE_NOT_FOUND: 70040, // Figure 不存在 / 越权（同码防探测，T05）
  IDEMPOTENCY_CONFLICT: 70041, // 同用户 + 同 key + 不同输入 → 稳定幂等冲突（不建任何行）
  FIGURE_PNG_NOT_READY: 70042, // PNG 未就绪（queued/running 未完成，明确应用级「未就绪」响应）
  FIGURE_PNG_NOT_AVAILABLE: 70043, // PNG 不可用（failed / succeeded 但产物缺失，明确应用级「不可用」响应）
  // 8xxxx plugins（#788 · #752 R8；对齐「40 不存在」锁式，01 校验段专用——参数校验缺省走
  // 90002，80001 仅插件域语义化校验失败如未知 pluginId 启用请求外的域内约束）
  PLUGINS_VALIDATION_FAILED: 80001, // 插件域参数校验失败（#752 R8）
  PLUGIN_NOT_FOUND: 80040, // 插件不存在（目录外 id）/ 越权（同码防探测，#752 R8）
  // 2xxxx 容器（20041 锁 = name 全局唯一冲突；register/users 用户名冲突复用，契约 §2.2）
  CONTAINER_NOT_FOUND: 20040, // 容器不存在 / 越权（同码防探测，#312 锁）
  NAME_CONFLICT: 20041,
  QUOTA_EXCEEDED: 20042, // 配额超限（User.maxContainers，#312/#311 锁）
  CONTAINER_BUSY: 20043, // 目标在 provisioning（delete 改取消标志后仅作在飞冲突备用，#313）
  ORPHAN_DIR: 20044, // create 撞残留 orphan 目录（转译）
  CLEANUP_FAILED: 20045, // home 清理失败（delete 行标 REMOVING 可重试，转译）
  CONTAINER_NOT_RUNNING: 20046, // #13：容器非 running（creating/stopped/removing）——bootstrap-token 前置
  // 5xxxx 会话/run 域（#747 C 节错误码新增；#776 起 50002 进信封面——chat/pairing 的 WS close
  // codes 是另一传输面，不受影响）：50002 = 会话不存在。
  RUN_ALREADY_RESUMED: 50001, // run 已被 resume（先到先得，败方拒绝；#777 runService 互斥面）
  SESSION_NOT_FOUND: 50002, // 会话不存在 / 越权（同码防探测；root=lab 读面 #776，#778 会话 REST 同款）
  RUN_INTERRUPT_PENDING: 50003, // interrupted 态禁输入（#747 C 节「interrupt 全端可审批」内核防御面——须先 resume 决策）
  APPROVAL_NOT_FOUND: 50004, // 审批不存在 / escalationId 不匹配（同码防探测；#783 审批漏斗 resolve 面）
  // #778（#747·08）会话 REST 域新增（50004 已被 #783 先占——顺移 50005 起；码值执行期续号，
  // 对齐「03 interrupted 专用 / 04+ 域专用」惯例）：
  RUN_IN_PROGRESS: 50005, // run 进行中（running/queued）禁新输入 + 非终态拒删会话（在飞互斥）——#747 C 节「running 全端禁输入」REST 门禁面
  RUN_NOT_ABORTABLE: 50006, // 无在飞 run 可中断（abort 目标缺失；#777 aborts 条目仅在飞期存在）
  MESSAGE_KEY_CONFLICT: 50007, // 同幂等 key 已用于不同 content（对齐 figures 70041「同 key 不同输入」稳定冲突锁式）
  FILE_REPLAY_IN_PROGRESS: 50008, // 文件状态重放中（#782 会话写围栏超时——rewind 逆放持有围栏，等待有界报持有者）
  // 9xxxx 系统 / 校验
  OAUTH_NOT_CONFIGURED: 90001, // OAuth provider 未配置（原 501）
  VALIDATION_FAILED: 90002, // 参数校验失败（字段明细进 data）；Idempotency-Key 缺/超长特例 data=null（figures 前置中间件）
  LLM_NOT_CONFIGURED: 90003, // LLM key 未配置 / 写盘失败（create 前置，转译）
  PORT_POOL_EXHAUSTED: 90004, // 端口池耗尽 / 持续分配冲突（转译，复用系统域）
  ROUTE_NOT_FOUND: 90005, // 路由不存在（404 信封兜底）
  INTERNAL: 90000, // 未知错误兜底
} as const

export type EnvelopeCode = (typeof CODE)[keyof typeof CODE]

// 默认人类可读总述；抛 EnvelopeError 时可不传 message 走默认。
export const DEFAULT_MESSAGE: Record<number, string> = {
  [CODE.OK]: 'ok',
  [CODE.UNAUTHENTICATED]: '未登录或登录已过期',
  [CODE.LOGIN_FAILED]: '用户名或密码错误',
  [CODE.REFRESH_INVALID]: '刷新凭证无效',
  [CODE.FORBIDDEN]: '权限不足',
  [CODE.MUST_CHANGE_PASSWORD]: '需要先修改密码',
  [CODE.USER_NOT_FOUND]: '用户不存在',
  [CODE.USERNAME_INVALID]: '用户名不合法',
  [CODE.QUOTA_INVALID]: '配额不合法',
  [CODE.CANNOT_DISABLE_SELF]: '不能禁用自己的账号',
  [CODE.CONTAINER_NOT_FOUND]: '容器不存在',
  [CODE.NAME_CONFLICT]: '名称已被占用',
  [CODE.QUOTA_EXCEEDED]: '容器数量已达配额上限',
  [CODE.CONTAINER_BUSY]: '容器正在创建中，请稍候再删除',
  [CODE.ORPHAN_DIR]: '该名称存在残留数据目录，请删除同名实例或手动清理后重试',
  [CODE.CLEANUP_FAILED]: '容器已停删，但数据目录清理失败（权限/属主），请重试',
  [CODE.CONTAINER_NOT_RUNNING]: '容器未运行，请启动后再对话',
  [CODE.RUN_ALREADY_RESUMED]: '该 run 已被恢复',
  [CODE.SESSION_NOT_FOUND]: '会话不存在',
  [CODE.RUN_INTERRUPT_PENDING]: 'run 停在 interrupt，须先审批决策（approve/reject）再发消息',
  [CODE.APPROVAL_NOT_FOUND]: '审批不存在或已落定',
  [CODE.RUN_IN_PROGRESS]: 'run 进行中，请等待完成或中断后再发消息',
  [CODE.RUN_NOT_ABORTABLE]: '当前没有进行中的 run 可中断',
  [CODE.MESSAGE_KEY_CONFLICT]: '该 Idempotency-Key 已用于不同内容，请更换 key 重试',
  [CODE.OAUTH_NOT_CONFIGURED]: 'OAuth provider 未配置',
  [CODE.WIKI_PAGE_NOT_FOUND]: '页面不存在',
  [CODE.WIKI_PAGE_EXISTS]: '页面已存在',
  [CODE.WIKI_UPDATE_IN_PROGRESS]: 'wiki 全量更新正在进行中，请等待完成后再试',
  [CODE.PROVIDER_NOT_FOUND]: 'model provider 不存在',
  [CODE.PROVIDER_ID_CONFLICT]: '该用户下 provider_id 已存在',
  [CODE.PROVIDER_ENDPOINT_NOT_ALLOWED]: '端点不在白名单内，请求被拒绝',
  [CODE.CONCURRENCY_QUOTA_EXCEEDED]: '并发配额已满，请稍后再试',
  [CODE.FILE_NOT_FOUND]: '文件不存在',
  [CODE.FILE_EXISTS]: '文件已存在',
  [CODE.FIGURE_NOT_FOUND]: 'Figure 不存在',
  [CODE.IDEMPOTENCY_CONFLICT]: '幂等键已用于不同输入，请勿复用同一 Idempotency-Key 提交不同创建载荷',
  [CODE.FIGURE_PNG_NOT_READY]: 'Figure 尚未生成完成，请稍后再试',
  [CODE.FIGURE_PNG_NOT_AVAILABLE]: 'Figure 无可用 PNG（生成失败或产物缺失）',
  [CODE.PLUGINS_VALIDATION_FAILED]: '插件参数校验失败',
  [CODE.PLUGIN_NOT_FOUND]: '插件不存在',
  [CODE.VALIDATION_FAILED]: '参数校验失败',
  [CODE.LLM_NOT_CONFIGURED]: 'LLM_API_KEY 未配置',
  [CODE.PORT_POOL_EXHAUSTED]: '端口池已耗尽，暂无法创建容器，请稍后重试或删除闲置容器',
  [CODE.ROUTE_NOT_FOUND]: '路由不存在',
  [CODE.INTERNAL]: '服务器内部错误',
}

export function defaultMessage(code: number): string {
  return DEFAULT_MESSAGE[code] ?? '错误'
}
