// API client —— JWT 拦截 + 401 刷新重试/跳登录（spec §9.1）。
// 所有需认证请求经 apiFetch/apiJson：自动注入 Authorization Bearer；
// 401 时先用 httpOnly refresh cookie 换新并重试一次，刷新失败才清会话并跳登录（codex R2）。
// #312 全局信封：TS 后端所有 REST 一律 HTTP 200，错误信号在 body 信封（code!==0）——apiJson
// 对非 0 码抛携带 code 的业务 ApiError（HTTP 层 200 不代表成功，apiFetch 的 401 分支看不到错误）。
// 系统码（10001 未认证 / 10004 角色不足等）按 HTTP 401 同语义映射 apiFetch 的刷新链：
// 吊销的 token 在 body 信封里拒绝业务请求，经刷新链换新重试/确认失效跳登录（P0 code review）。
import { useAuthStore } from '@/stores/auth'
import { ApiError, parseEnvelope } from '@/api/errors'
import { fetchWithTimeout } from '@/api/request'

export { ApiError } from '@/api/errors'

// #312 信封系统码：code 以 1xxxx 开头 = 认证层错误（10001 未认证 / 10004 角色不足）——这些
// 「换新 token 可解决」（凭据失效/吊销），对 HTTP 200 信封里的它们 apiFetch 按 HTTP 401 同语义
// 触发刷新重试链（否则吊销的 token 只在业务层被拒、刷新链永不触发，用户被留在原地反复看到内部
// 错误文案——P0）。
// 10005（强制改密）**不**在此列：它是 mustChangePassword 授权门状态，非凭据失效——刷新换新 token
// 不会改变它，放进刷新集只会让改密用户每请求无谓刷新一轮再被抛 401「未登录」，且 bootstrap/
// loadInstances 对 401 静默 return 让用户永远看不到「需改密」指引（PR #370 第四轮 R4-3 P0）。
const ENVELOPE_UNAUTHENTICATED_CODES: ReadonlySet<number> = new Set([10001, 10004])

function buildHeaders(init: RequestInit, token: string): Headers {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  // FormData（multipart，如附件上传）不设 Content-Type——浏览器须自带 multipart boundary。
  if (init.body != null && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return headers
}

// #312 信封判定只在 JSON body 上有意义；二进制/非 JSON 响应（AutoFigure PNG 原生字节等）不得调用
// json()——会 drain 流，使后续 blob() 抛 Body is unusable。JSON 判定对齐仓库既有 Content-Type 约定
// （后端信封响应经 res.json()，恒带 application/json）。
function isJsonResponse(resp: Response): boolean {
  return !resp.headers.get('Content-Disposition') && (resp.headers.get('content-type') ?? '').includes('application/json')
}

// 响应 body 只可读一次（流语义）——把解析结果缓存到响应对象，envelope 判定与 apiJson 复用同一份，
// 避免对同一响应读两次 json()。导出：二进制端点（如 PNG）读错误面信封时复用缓存——apiFetch 已为
// 10001/10004 检测读取过一次 JSON body，消费方经此读取而非二次 resp.json()（流已消费会 reject）。
export function parseEnvelopeBody(resp: Response): Promise<unknown> {
  const cached = resp as Response & { __envBody?: unknown }
  if ('__envBody' in cached) return Promise.resolve(cached.__envBody ?? null)
  return resp
    .json()
    .then((body) => {
      cached.__envBody = body
      return body
    })
    .catch(() => {
      cached.__envBody = null
      return null
    })
}

async function envelopeCodeOf(resp: Response): Promise<number> {
  const env = parseEnvelope(await parseEnvelopeBody(resp))
  return env ? env.code : -1
}

// 401 刷新链：forceRefresh 换新 token 后重试一次；成功返回新响应。刷新失败（refreshExhausted 确认
// 失效）→ 清会话跳登录；瞬态失败（cookie 仍可能有效）→ 返回 null 抛错，保留会话供上层重试
// （codex R8 F2，避免 auth 服务临时中断即踢人）。
//
// PR #370 第四轮 R4-4（P1）：单飞去重——并发 401/10001（过期 access 下多 tab / 并行 apiFetch）
// 下，N 个 refreshAndRetry 各调 forceRefresh 会发 N 个同 cookie refresh POST，服务端 rotateRefresh
// 重放检测「族灭」全部 refresh（10003）→ 凭据有效的用户被强制登出。模块级 in-flight promise：首个
// 触发，并发者复用同一结果，refresh 端点只被打一次。
let inflightRefresh: Promise<void> | null = null
function singleFlightRefresh(): Promise<void> {
  if (!inflightRefresh) {
    inflightRefresh = useAuthStore()
      .forceRefresh()
      .finally(() => {
        inflightRefresh = null
      }) as Promise<void>
  }
  return inflightRefresh
}

async function refreshAndRetry(path: string, init: RequestInit): Promise<Response | null> {
  const auth = useAuthStore()
  await singleFlightRefresh()
  if (auth.token) {
    const retried = await fetchWithTimeout(path, { ...init, headers: buildHeaders(init, auth.token) })
    const rejected =
      retried.status === 401 ||
      // 非 JSON 重试响应（二进制成功）不作信封 sniff——不消费 body（见 isJsonResponse）
      (retried.status === 200 &&
        isJsonResponse(retried) &&
        ENVELOPE_UNAUTHENTICATED_CODES.has(await envelopeCodeOf(retried)))
    if (!rejected) return retried
  }
  if (auth.refreshExhausted) {
    auth.clearSession()
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.assign('/login')
    }
  }
  return null
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = useAuthStore()
  const resp = await fetchWithTimeout(path, { ...init, headers: buildHeaders(init, auth.token) })
  // HTTP 200 + 非 JSON（二进制成功，如 AutoFigure PNG 原生字节）→ 跳过信封 sniff 原样返回：
  // 绝不读 body（resp.json() 会 drain 流，使后续 blob() 不可用）。对既有 JSON 调用方行为等价——
  // 非 JSON 200 的 envelopeCodeOf 恒为 -1，本就不进 10001/10004 分支；差异仅在 body 不再被无谓消费。
  if (resp.status === 200 && !isJsonResponse(resp)) return resp
  // HTTP 200 但信封码是认证/授权层错误（TS 后端 #312 信封：吊销的 token 以 10001 拒业务请求，
  // HTTP 层恒 200）→ 与 HTTP 401 同语义触发刷新重试链。非信封响应不在此列（走 HTTP 状态）。
  if (resp.status === 200 && ENVELOPE_UNAUTHENTICATED_CODES.has(await envelopeCodeOf(resp))) {
    const retried = await refreshAndRetry(path, init)
    if (retried) return retried
    // 刷新确认失效 / 瞬态失败：与 HTTP 401 同语义抛错（清会话/跳登录已在 refreshAndRetry 内完成，
    // 不得把 10001 原响应当成功返回——上层会以为请求成功而读到错误 body）。
    throw new ApiError(401, '未登录或登录已过期')
  }
  if (resp.status !== 401) return resp
  // 服务端已拒绝当前 access；即使本地 exp 尚未到期，也必须强制用 refresh cookie 换新。
  const retried = await refreshAndRetry(path, init)
  if (retried) return retried
  throw new ApiError(401, '未登录或登录已过期')
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await apiFetch(path, init)
  // #419-5：204 No Content 空体——不读 body 直接返回 undefined（resp.json() 对空体会 reject）。
  if (resp.status === 204) return undefined as T
  if (!resp.ok) {
    // 未走信封的 HTTP 语义：按 HTTP 状态抛错 + detail 透传。
    let detail = `请求失败 (${resp.status})`
    try {
      const body = (await parseEnvelopeBody(resp)) as Record<string, unknown> | null
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      // 无 JSON body，沿用默认 detail
    }
    throw new ApiError(resp.status, detail)
  }
  const body = await parseEnvelopeBody(resp)
  // TS 后端 #312 信封：HTTP 200 但 code!==0 → 业务错误（20040 越权 / 90002 校验 / 10001 未认证…）。
  // 只按 HTTP 状态判错会让 apiFetch 的 401 分支与上层 status 分支（ChatView 20040 等）全成死代码，
  // 用户看到原始内部文案（P0 code review）。
  const env = parseEnvelope(body)
  if (env && env.code !== 0) throw new ApiError(resp.status, env.message, env.code)
  // PR #370 第四轮 R4-1（P0）：成功信封（code===0）须解包 data 返回业务载荷，而非整个信封——
  // 否则调用方裸消费 {code,message,data}，listInstances.length / ContainersView.map 失败，
  // 主线「容器列表 → selectContainer → 隧道」全断。非信封（裸载荷，env===null）原样透传。
  return (env ? env.data : body) as T
}
