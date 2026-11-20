/**
 * 图片附件尺寸计算与格式化纯函数模块（零 React/DOM/CSS 依赖，便于 Node 单测直接引用）。
 *
 * 1. 参考 Anthropic / Claude 等视觉模型限制：单边超过 2000px 在多图对话中会导致整条线程被拒，
 *    同时高分屏 Retina 截图直接发送也容易触及 ACP stdio 8 MiB 单帧上限；
 *    因此提供统一的长边 `2000px` 等比缩放尺寸计算。
 */
import type { DraftImageMimeType } from "../../shared/personal.js"

export const IMAGE_ATTACHMENT_MAX_EDGE = 2000
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024
export const IMAGE_COMPRESS_TARGET_BYTES = 2 * 1024 * 1024

/** 计算需要等比缩放的目标宽高；宽高均不超过 2000px 或非法尺寸返回 null（无需缩放）。 */
export function fitImageAttachmentSize(size: {
  readonly width: number
  readonly height: number
}): { readonly width: number; readonly height: number } | null {
  const { width, height } = size
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  const longestEdge = Math.max(width, height)
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(height * scale))),
  }
}

export function formatImageDimensions(width?: number, height?: number): string | undefined {
  if (
    typeof width !== "number" || typeof height !== "number"
    || !Number.isFinite(width) || !Number.isFinite(height)
    || width <= 0 || height <= 0
  ) {
    return undefined
  }
  return `${Math.round(width)}×${Math.round(height)}`
}

export function formatImageByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function inferImageMimeFromName(fileName: string): DraftImageMimeType | null {
  const lower = fileName.trim().toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".gif")) return "image/gif"
  return null
}
