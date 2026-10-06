// 消息锚点导航（issue #669 / #667 spec）：消息流右缘垂直刻度轨的几何判定纯函数层。
// DOM 度量（消息元素 offsetTop、容器 scrollHeight/clientHeight/scrollTop）由宿主 ChatStream
// 注入——贴滚动判定层 scroll.ts（ADR 0009 范式 B）先例：本模块只做几何计算，可单测。
// 术语见根 CONTEXT.md「消息锚点导航 (message anchor nav)」。

// hover 摘要最大长度（前几十字）；超长截断加省略号。
export const SUMMARY_MAX_CHARS = 40

// 纯媒体消息（无文本）的占位——#780 D9 MediaRef 引用面无 type 字段，按 mime 前缀派生
// （image/video/audio 前缀；其余含 document 视作文件附件）。
export function mediaPlaceholder(m: { mime?: string }): string {
  const mime = m.mime ?? ''
  if (mime.startsWith('image/')) return '[图片]'
  if (mime.startsWith('video/')) return '[视频]'
  if (mime.startsWith('audio/')) return '[音频]'
  return '[文件]'
}

// 锚点筛选：仅 role=user 消息进轨（assistant 与审批卡不进轨，#667 实现决策），
// 返回消息数组下标（与 ChatStream 渲染 key 策略一致——消息无稳定 ID）。
export function selectUserAnchorIndices(messages: { role: string }[]): number[] {
  const out: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') out.push(i)
  }
  return out
}

// hover 摘要：文本前 SUMMARY_MAX_CHARS 字（超长加省略号）；纯媒体消息（无文本）取第一个
// 附件类型占位；文本+媒体混合以文本优先（仅纯媒体才占位）；换行折叠为空格（tooltip 单行）。
export function anchorSummary(msg: { text: string; media: { mime?: string }[] }): string {
  const text = msg.text.replace(/\s+/g, ' ').trim()
  if (!text) {
    const first = msg.media[0]
    return first ? mediaPlaceholder(first) : ''
  }
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) + '…' : text
}

// 刻度比例布局：锚点消息 offsetTop 在滚动文档中的位置比例（0=顶 1=底）。
// 分母用 maxScroll（scrollHeight-clientHeight）使刻度与 scrollspy 指示器同坐标系；
// 尾随内容之下（offsetTop 超 maxScroll）clamp 到 1；无滚动空间（内容不足一屏）全 0。
export function anchorRatios(tops: number[], scrollHeight: number, clientHeight: number): number[] {
  const maxScroll = scrollHeight - clientHeight
  if (maxScroll <= 0) return tops.map(() => 0)
  return tops.map((top) => Math.min(top / maxScroll, 1))
}

// scrollspy 指示器位置：当前 scrollTop 在滚动区间（0=顶 1=底）的比例。
// 无滚动空间视作停留底部（与 shouldFollowBottom 空内容语义一致）→ 1。
export function viewportRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const maxScroll = scrollHeight - clientHeight
  if (maxScroll <= 0) return 1
  return Math.min(Math.max(scrollTop / maxScroll, 0), 1)
}

// scrollspy active 判定：指示器位置与哪个刻度比例最近（指示器停在哪个刻度，哪个即当前位
// 置——视觉对齐语义）。平手取靠后刻度；空锚点 -1（无 active）。
export function activeAnchorIndex(ratios: number[], indicator: number): number {
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < ratios.length; i++) {
    const dist = Math.abs(ratios[i] - indicator)
    if (dist <= bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}
