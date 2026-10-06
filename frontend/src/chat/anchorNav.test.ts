// seam: anchorNav —— 消息锚点导航纯逻辑（issue #669 / #667 spec 实现决策）。
// 几何判定（锚点筛选、摘要、比例布局、scrollspy 判定）全部纯函数，DOM 度量（offsetTop/
// scrollHeight/clientHeight/scrollTop）由宿主 ChatStream 注入——贴滚动判定层 scroll.ts 先例。
// 好测试标准：只测外部行为——给定消息角色序列 / 几何数字，断言筛选结果 / 摘要文本 / 比例与
// active 判定；不测宿主 DOM 操作（组件挂载测试覆盖）。
import { describe, expect, it } from 'vitest'
import {
  SUMMARY_MAX_CHARS,
  activeAnchorIndex,
  anchorRatios,
  anchorSummary,
  selectUserAnchorIndices,
  viewportRatio,
} from '@/chat/anchorNav'

describe('selectUserAnchorIndices（锚点筛选：仅 role=user）', () => {
  it('assistant 消息不进轨，user 消息按数组下标返回', () => {
    const roles = [
      { role: 'assistant' },
      { role: 'user' },
      { role: 'assistant' },
      { role: 'assistant' },
      { role: 'user' },
    ]
    expect(selectUserAnchorIndices(roles)).toEqual([1, 4])
  })

  it('空消息列表 → 空数组', () => {
    expect(selectUserAnchorIndices([])).toEqual([])
  })

  it('全 assistant → 空数组（无锚点，轨不渲染）', () => {
    expect(selectUserAnchorIndices([{ role: 'assistant' }, { role: 'assistant' }])).toEqual([])
  })

  it('全 user → 全部下标', () => {
    expect(selectUserAnchorIndices([{ role: 'user' }, { role: 'user' }])).toEqual([0, 1])
  })
})

describe('anchorSummary（hover 摘要：文本截断 / 媒体占位）', () => {
  it('文本消息取前 SUMMARY_MAX_CHARS 字', () => {
    const text = 'a'.repeat(SUMMARY_MAX_CHARS + 20)
    expect(anchorSummary({ text, media: [] })).toBe('a'.repeat(SUMMARY_MAX_CHARS) + '…')
  })

  it('不超长文本原样返回（无省略号）', () => {
    expect(anchorSummary({ text: '你好世界', media: [] })).toBe('你好世界')
  })

  it('纯图片消息 → [图片] 占位', () => {
    expect(anchorSummary({ text: '', media: [{ mime: 'image/png' }] })).toBe('[图片]')
  })

  it('纯视频/音频/文件消息 → 对应类型占位', () => {
    expect(anchorSummary({ text: '', media: [{ mime: 'video/mp4' }] })).toBe('[视频]')
    expect(anchorSummary({ text: '', media: [{ mime: 'audio/mpeg' }] })).toBe('[音频]')
    expect(anchorSummary({ text: '', media: [{ mime: 'application/pdf' }] })).toBe('[文件]')
  })

  it('文本+媒体混合 → 文本摘要优先（仅纯媒体才占位）', () => {
    expect(anchorSummary({ text: '看这张图', media: [{ mime: 'image/png' }] })).toBe('看这张图')
  })

  it('多附件纯媒体 → 取第一个附件类型占位', () => {
    expect(anchorSummary({ text: '', media: [{ mime: 'video/mp4' }, { mime: 'image/png' }] })).toBe('[视频]')
  })

  it('文本含换行 → 折叠为空格（tooltip 单行）', () => {
    expect(anchorSummary({ text: '第一行\n第二行', media: [] })).toBe('第一行 第二行')
  })

  it('空文本无媒体 → 空摘要', () => {
    expect(anchorSummary({ text: '', media: [] })).toBe('')
  })
})

describe('anchorRatios（刻度比例布局）', () => {
  it('刻度按消息 offsetTop 在滚动文档中的位置比例分布', () => {
    // scrollHeight=1000、clientHeight=100 → maxScroll=900；tops=[0, 450, 900] → [0, .5, 1]
    expect(anchorRatios([0, 450, 900], 1000, 100)).toEqual([0, 0.5, 1])
  })

  it('文档底部之下（含 padding 尾随内容）clamp 到 1', () => {
    expect(anchorRatios([2000], 1000, 100)).toEqual([1])
  })

  it('无滚动空间（内容不足一屏）→ 全部为 0', () => {
    expect(anchorRatios([10, 50], 400, 800)).toEqual([0, 0])
  })

  it('空锚点 → 空数组', () => {
    expect(anchorRatios([], 1000, 100)).toEqual([])
  })
})

describe('viewportRatio（scrollspy 指示器位置）', () => {
  it('scrollTop/maxScroll：顶部 0、底部 1', () => {
    expect(viewportRatio(0, 1000, 100)).toBe(0)
    expect(viewportRatio(900, 1000, 100)).toBe(1)
  })

  it('中间位置线性映射', () => {
    expect(viewportRatio(450, 1000, 100)).toBe(0.5)
  })

  it('无滚动空间 → 1（视作停留底部）', () => {
    expect(viewportRatio(0, 400, 800)).toBe(1)
  })
})

describe('activeAnchorIndex（scrollspy active 判定）', () => {
  it('指示器位置与哪个刻度最近，哪个 active', () => {
    // 刻度 [0, .5, 1]，指示器 .4 → 最近 .5（index 1）
    expect(activeAnchorIndex([0, 0.5, 1], 0.4)).toBe(1)
  })

  it('滚到底（指示器 1）→ 最后一条 active', () => {
    expect(activeAnchorIndex([0, 0.5, 1], 1)).toBe(2)
  })

  it('平手（恰在两刻度中点）→ 取靠后的刻度', () => {
    expect(activeAnchorIndex([0, 0.5], 0.25)).toBe(1)
  })

  it('空锚点 → -1（无 active）', () => {
    expect(activeAnchorIndex([], 0.5)).toBe(-1)
  })
})
