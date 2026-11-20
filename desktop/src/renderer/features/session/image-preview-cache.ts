/**
 * 渲染层本机图片预览 URL 缓存（按账号隔离，纯浏览器/TypeScript，不依赖 Node/Electron）。
 *
 * 1. `PersonalStore` 与时间线条目仅保存轻量的 `PersonalDraftImage` 元数据（不含图片二进制或 blob URL）；
 * 2. 组件渲染缩略图或弹出 Lightbox 时，先查本缓存，未命中则去重调用主进程 `readImage`，
 *    将返回的 `Uint8Array` 转为 `Blob` ObjectURL 缓存起来，避免重复 IPC 读盘或泄漏对象 URL。
 */
import type { ReadLocalImageResult } from "../../../shared/index.js"

export interface ImagePreviewCache {
  prime(accountId: string, imageId: string, url: string): void
  get(accountId: string, imageId: string): string | undefined
  resolve(
    accountId: string,
    imageId: string,
    reader: (imageId: string) => Promise<ReadLocalImageResult | null>,
  ): Promise<string | null>
  revoke(accountId: string, imageId: string): void
  revokeAll(): void
}

function cacheKey(accountId: string, imageId: string): string {
  return `${accountId}\u0000${imageId}`
}

export function createImagePreviewCache(): ImagePreviewCache {
  const urls = new Map<string, string>()
  const inflight = new Map<string, Promise<string | null>>()

  const revokeUrl = (url: string) => {
    if (url.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // 忽略重复释放错误。
      }
    }
  }

  return {
    prime(accountId, imageId, url) {
      const key = cacheKey(accountId, imageId)
      const prev = urls.get(key)
      if (prev && prev !== url) {
        revokeUrl(prev)
      }
      urls.set(key, url)
    },

    get(accountId, imageId) {
      return urls.get(cacheKey(accountId, imageId))
    },

    async resolve(accountId, imageId, reader) {
      const key = cacheKey(accountId, imageId)
      const cached = urls.get(key)
      if (cached) return cached

      const pending = inflight.get(key)
      if (pending) return pending

      const task = (async () => {
        try {
          const loaded = await reader(imageId)
          if (!loaded || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
            return null
          }
          // 拷贝为标准 ArrayBuffer 视图构造 Blob，避免共享或只读类型收窄告警。
          const copy = new Uint8Array(loaded.bytes.byteLength)
          copy.set(loaded.bytes)
          const blob = new Blob([copy], { type: loaded.mimeType })
          const url = URL.createObjectURL(blob)
          const existing = urls.get(key)
          if (existing) {
            revokeUrl(url)
            return existing
          }
          urls.set(key, url)
          return url
        } catch {
          return null
        } finally {
          inflight.delete(key)
        }
      })()

      inflight.set(key, task)
      return task
    },

    revoke(accountId, imageId) {
      const key = cacheKey(accountId, imageId)
      const url = urls.get(key)
      if (!url) return
      urls.delete(key)
      revokeUrl(url)
    },

    revokeAll() {
      for (const url of urls.values()) {
        revokeUrl(url)
      }
      urls.clear()
      inflight.clear()
    },
  }
}
