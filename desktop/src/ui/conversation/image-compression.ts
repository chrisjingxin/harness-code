/**
 * 浏览器渲染层图片预处理与 ≤ 2000px 等比缩放压缩。
 *
 * 1. 输入剪贴板或文件对象 → 校验格式与解码保护上限 (50 MiB) → 解析像素宽高；
 * 2. GIF 保持原始字节以保留动图帧（超出 4 MiB 时明确拒绝）；
 * 3. PNG/JPEG/WebP 若最长边 > 2000px 或原始体积 > 2 MiB，则通过 Canvas 缩放并按画质步进压至 ≤ 4 MiB；
 *    尺寸合规且体积已在 2 MiB 内的图片直接原样透传，不做无意义重编码。
 */
import {
  MAX_SINGLE_IMAGE_BYTES,
  SUPPORTED_DRAFT_IMAGE_MIME_TYPES,
  type DraftImageMimeType,
} from "../../shared/personal.js"
import {
  IMAGE_COMPRESS_TARGET_BYTES,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  fitImageAttachmentSize,
  inferImageMimeFromName,
} from "./image-sizing.js"

const SUPPORTED_MIME_SET = new Set<string>(SUPPORTED_DRAFT_IMAGE_MIME_TYPES)
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const

export interface PreparedPastedImage {
  readonly bytes: Uint8Array
  readonly mimeType: DraftImageMimeType
  readonly width?: number
  readonly height?: number
  readonly name: string
}

function normalizeMimeType(file: Pick<File, "type" | "name">): DraftImageMimeType | null {
  const raw = file.type.trim().toLowerCase()
  const normalized = raw === "image/jpg" ? "image/jpeg" : raw
  if (SUPPORTED_MIME_SET.has(normalized)) return normalized as DraftImageMimeType
  return inferImageMimeFromName(file.name)
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: DraftImageMimeType,
  quality?: number,
): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), mimeType, quality)
  })
}

async function decodeImage(
  file: Blob,
): Promise<{
  readonly source: CanvasImageSource
  readonly width: number
  readonly height: number
  readonly cleanup: () => void
}> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    }
  }
  const url = URL.createObjectURL(file)
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error("无法解码该图片。"))
    el.src = url
  })
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () => URL.revokeObjectURL(url),
  }
}

function defaultImageName(rawName: string, mimeType: DraftImageMimeType): string {
  const trimmed = rawName.trim()
  if (trimmed) return trimmed
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length)
  return `pasted-image.${ext}`
}

/** 将粘贴的图片标准化并按需缩放到 ≤ 2000px、≤ 4 MiB。 */
export async function preparePastedImage(file: File): Promise<PreparedPastedImage> {
  if (file.size <= 0) {
    throw new Error(`图片「${file.name || "未命名"}」内容为空，无法添加。`)
  }
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    throw new Error("图片原始体积超过 50 MiB，无法在本地安全解码。")
  }
  const mimeType = normalizeMimeType(file)
  if (!mimeType) {
    throw new Error("仅支持粘贴 PNG、JPEG、WebP 或 GIF 图片。")
  }
  const name = defaultImageName(file.name, mimeType)

  if (mimeType === "image/gif") {
    const buf = new Uint8Array(await file.arrayBuffer())
    let width: number | undefined
    let height: number | undefined
    try {
      const decoded = await decodeImage(file)
      width = decoded.width
      height = decoded.height
      decoded.cleanup()
    } catch {
      // 保留原始 GIF 字节即可；缺少宽高不阻断粘贴。
    }
    if (buf.byteLength > MAX_SINGLE_IMAGE_BYTES) {
      throw new Error("GIF 图片超过 4 MiB 单张上限，请压缩后再粘贴。")
    }
    return { bytes: buf, mimeType, width, height, name }
  }

  const decoded = await decodeImage(file)
  try {
    const fitted = fitImageAttachmentSize({ width: decoded.width, height: decoded.height })
    if (!fitted && file.size <= IMAGE_COMPRESS_TARGET_BYTES) {
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType,
        width: decoded.width,
        height: decoded.height,
        name,
      }
    }

    const baseWidth = fitted?.width ?? decoded.width
    const baseHeight = fitted?.height ?? decoded.height
    const render = async (
      targetWidth: number,
      targetHeight: number,
      targetMime: DraftImageMimeType,
      quality?: number,
    ): Promise<Uint8Array | null> => {
      const canvas = document.createElement("canvas")
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext("2d")
      if (!ctx) return null
      if (targetMime === "image/jpeg") {
        // 含透明通道的截图转 JPEG 时填充白色底，避免黑底失真。
        ctx.fillStyle = "#ffffff"
        ctx.fillRect(0, 0, targetWidth, targetHeight)
      }
      ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight)
      const blob = await canvasToBlob(canvas, targetMime, quality)
      if (!blob) return null
      return new Uint8Array(await blob.arrayBuffer())
    }

    // 1. 先以同尺寸/2000px 尝试保留原 MIME（PNG 先尝试无损，其余试质量阶梯）。
    if (mimeType === "image/png") {
      const pngBytes = await render(baseWidth, baseHeight, "image/png")
      if (pngBytes && pngBytes.byteLength <= IMAGE_COMPRESS_TARGET_BYTES) {
        return { bytes: pngBytes, mimeType: "image/png", width: baseWidth, height: baseHeight, name }
      }
    }

    const lossyMimes: readonly DraftImageMimeType[] = mimeType === "image/png"
      ? ["image/webp", "image/jpeg"]
      : [mimeType]
    for (const targetMime of lossyMimes) {
      for (const quality of QUALITY_STEPS) {
        const bytes = await render(baseWidth, baseHeight, targetMime, quality)
        if (bytes && bytes.byteLength <= MAX_SINGLE_IMAGE_BYTES) {
          return { bytes, mimeType: targetMime, width: baseWidth, height: baseHeight, name }
        }
      }
    }

    // 2. 质量降低后仍超 4 MiB 时进一步缩边，优先保证可顺利发送。
    for (const scale of FALLBACK_SCALE_STEPS) {
      const w = Math.max(1, Math.round(baseWidth * scale))
      const h = Math.max(1, Math.round(baseHeight * scale))
      for (const quality of QUALITY_STEPS) {
        const bytes = await render(w, h, "image/jpeg", quality)
        if (bytes && bytes.byteLength <= MAX_SINGLE_IMAGE_BYTES) {
          return { bytes, mimeType: "image/jpeg", width: w, height: h, name }
        }
      }
    }

    throw new Error("图片压缩后仍超出 4 MiB 单张上限，请裁剪后再粘贴。")
  } finally {
    decoded.cleanup()
  }
}
