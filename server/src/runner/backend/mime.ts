// runner backend MIME 表（#747·02）：逐字段镜像 deepagents@1.14.1 MIME_TYPES（langsmith chunk
// 原文）——镜像非临时替身：容器内文件由控制面判 mime，基座升级时按上游核对本表。
// 判定规则同官方：未知扩展名 → text/plain（源码类一律 text/plain 系表内显式项）；
// isTextMimeType 白名单 = text/* + application/json + application/javascript + image/svg+xml
// （grep 跳过二进制、read 二进制返回 Uint8Array 共用此判定）。

const MIME_TYPES: Record<string, string> = {
  // 媒体类（二进制——read 返回 Uint8Array，grep 跳过）
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.3gpp': 'video/3gpp',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 文本类
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.xml': 'text/xml',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.rb': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.h': 'text/plain',
  '.hpp': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.sh': 'text/plain',
  '.bash': 'text/plain',
  '.zsh': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.log': 'text/plain',
  '.sql': 'text/plain',
  '.graphql': 'text/plain',
  '.proto': 'text/plain',
  '.r': 'text/plain',
  '.swift': 'text/plain',
  '.kt': 'text/plain',
  '.kts': 'text/plain',
  '.scala': 'text/plain',
  '.dart': 'text/plain',
  '.lua': 'text/plain',
  '.pl': 'text/plain',
  '.pm': 'text/plain',
  '.php': 'text/plain',
  '.ex': 'text/plain',
  '.exs': 'text/plain',
  '.erl': 'text/plain',
  '.hs': 'text/plain',
  // 评审 m6 补齐：上游 12 项（langsmith chunk MIME_TYPES 全表 90 项，此前漏镜像；
  // 均 text/plain，与未补时兜底行为等价——补的是表保真）
  '.ml': 'text/plain',
  '.mli': 'text/plain',
  '.vue': 'text/plain',
  '.svelte': 'text/plain',
  '.astro': 'text/plain',
  '.tf': 'text/plain',
  '.cmake': 'text/plain',
  '.makefile': 'text/plain',
  '.dockerfile': 'text/plain',
  '.gitignore': 'text/plain',
  '.dockerignore': 'text/plain',
  '.editorconfig': 'text/plain',
}

export function getMimeType(filePath: string): string {
  // 扩展名按 basename 提取（评审 m6：镜像上游 extname 的 dotIdx<=0 判据——dotfile
  // 如 /lab/.png 无扩展名 → text/plain；旧实现对全路径 lastIndexOf 会把 dotfile
  // 误判 image/png）
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : ''
  return MIME_TYPES[ext] ?? 'text/plain'
}

export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'image/svg+xml'
  )
}

// write 面 content → bytes 解码（二进制 mime 视 content 为 base64——对齐官方
// FilesystemBackend 的 write 分支）。基类与 JournalingBackend 装饰器同源调用：
// 写坏字节与否的关键语义，单点钉死防双处漂移。
export function decodeWriteContent(filePath: string, content: string): Buffer {
  return isTextMimeType(getMimeType(filePath)) ? Buffer.from(content, 'utf8') : Buffer.from(content, 'base64')
}
