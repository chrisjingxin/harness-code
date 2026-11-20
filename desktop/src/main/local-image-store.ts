/**
 * 本机剪贴板粘贴图片两阶段不可变存储。
 *
 * 1. 功能定义：
 *    - `stage`: 魔数校验真实图片格式并原子写入 `<root>/<accountHash>/pending-<uuid>.<ext>`；
 *    - `claimForSend`: 发送前复制冻结为 `sent-<uuid>.<ext>`（保留原 `pending-*` 以支持失败重发），
 *      按累计体积预算校验后生成标准 ACP `{ type: "image", data, mimeType }` 内容块；
 *    - `read` / `removePending`: 受控读取预览字节及移除未发送草稿图。
 * 2. 协作边界：仅运行于 Electron 主进程（`desktop/src/main/`），按账号哈希隔离存储，绝不写入用户项目工作区。
 */
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import type { LocalAcpPromptBlock } from "@workbench/acp-runtime"
import {
  MAX_DRAFT_IMAGES,
  MAX_SINGLE_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  type DraftImageMimeType,
  type PersonalDraftImage,
  type ReadLocalImageResult,
  type StageLocalImageInput,
} from "../shared/index.js"

const IMAGE_ID_PATTERN = /^(pending|sent)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".webp", ".gif"] as const
const MIME_TO_EXT: Record<DraftImageMimeType, (typeof SUPPORTED_EXTENSIONS)[number]> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}

const PART_MAX_AGE_MS = 60 * 60 * 1000
const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000
const ACCOUNT_SENT_BUDGET_BYTES = 150 * 1024 * 1024
const SWEEP_THROTTLE_MS = 10 * 60 * 1000

/** 根据二进制文件头魔数识别真实图片格式，绝不轻信渲染层传入的 mimeType。 */
export function detectImageMimeType(bytes: Uint8Array): DraftImageMimeType | null {
  if (bytes.byteLength >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png"
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (bytes.byteLength >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif"
  }
  if (bytes.byteLength >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp"
  }
  return null
}

function accountSegment(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 24)
}

function sanitizeImageName(rawName: string | undefined, mimeType: DraftImageMimeType): string {
  const cleaned = (rawName ?? "")
    .replace(/[\u0000-\u001f\u007f\\/]/g, " ")
    .trim()
    .slice(0, 128)
  return cleaned || `pasted-image${MIME_TO_EXT[mimeType]}`
}

function isInsideDir(root: string, target: string): boolean {
  const rel = relative(root, target)
  return Boolean(rel) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
}

export function isValidLocalImageId(value: string): boolean {
  return IMAGE_ID_PATTERN.test(value)
}

export class LocalImageStore {
  readonly #lastSweepByAccount = new Map<string, number>()

  constructor(private readonly rootDir: string) {}

  #accountDir(accountId: string): string {
    return join(this.rootDir, accountSegment(accountId))
  }

  async #resolveExistingFile(accountId: string, imageId: string): Promise<{ dir: string; filePath: string } | null> {
    if (!isValidLocalImageId(imageId)) return null
    const dir = this.#accountDir(accountId)
    let canonicalDir: string
    try {
      canonicalDir = await realpath(dir)
    } catch {
      return null
    }
    for (const ext of SUPPORTED_EXTENSIONS) {
      const candidate = join(canonicalDir, `${imageId}${ext}`)
      try {
        const canonicalFile = await realpath(candidate)
        if (!isInsideDir(canonicalDir, canonicalFile)) return null
        const info = await stat(canonicalFile)
        if (info.isFile()) return { dir: canonicalDir, filePath: canonicalFile }
      } catch {
        // 继续尝试其余受支持扩展名。
      }
    }
    return null
  }

  /** 将渲染层传来的图片校验魔数与体积后原子落盘为 pending 草稿图片。 */
  async stage(accountId: string, input: StageLocalImageInput): Promise<PersonalDraftImage> {
    const raw = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
    if (raw.byteLength < 1 || raw.byteLength > MAX_SINGLE_IMAGE_BYTES) {
      throw new Error("图片大小无效或超出 4 MiB 单张上限。")
    }
    const detectedMime = detectImageMimeType(raw)
    if (!detectedMime) {
      throw new Error("仅支持有效的 PNG、JPEG、WebP 或 GIF 图片。")
    }

    const id = `pending-${randomUUID()}`
    const ext = MIME_TO_EXT[detectedMime]
    const dir = this.#accountDir(accountId)
    await mkdir(dir, { recursive: true })
    const finalPath = join(dir, `${id}${ext}`)
    const partPath = join(dir, `${id}${ext}.${randomUUID()}.part`)
    try {
      await writeFile(partPath, raw)
      await rename(partPath, finalPath)
    } catch (error) {
      await unlink(partPath).catch(() => {})
      throw error
    }

    const width = typeof input.width === "number" && Number.isSafeInteger(input.width) && input.width >= 1
      ? input.width
      : undefined
    const height = typeof input.height === "number" && Number.isSafeInteger(input.height) && input.height >= 1
      ? input.height
      : undefined
    const name = sanitizeImageName(input.name, detectedMime)

    // 后台低频清理过期临时文件与超配额旧缓存，不阻塞当前粘贴响应。
    void this.#maybeSweep(accountId).catch(() => {})

    return {
      id,
      name,
      mimeType: detectedMime,
      sizeBytes: raw.byteLength,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }
  }

  /** 读取本账号名下的已暂存或已发送图片字节用于放大预览。 */
  async read(accountId: string, imageId: string): Promise<ReadLocalImageResult | null> {
    const resolved = await this.#resolveExistingFile(accountId, imageId)
    if (!resolved) return null
    const buf = await readFile(resolved.filePath)
    if (buf.byteLength < 1 || buf.byteLength > MAX_SINGLE_IMAGE_BYTES) return null
    const detected = detectImageMimeType(buf)
    if (!detected) return null
    return { bytes: new Uint8Array(buf), mimeType: detected }
  }

  /** 移除尚未发送的 pending 草稿图片；已发送 `sent-*` 记录受保护不误删。 */
  async removePending(accountId: string, imageId: string): Promise<void> {
    if (!imageId.startsWith("pending-") || !isValidLocalImageId(imageId)) return
    const resolved = await this.#resolveExistingFile(accountId, imageId)
    if (!resolved) return
    await unlink(resolved.filePath).catch(() => {})
  }

  /**
   * 发送或队列兑现前验证所有图片并冻结为不可变 `sent-*` 副本：
   * 复制保留原 `pending-*`，确保发送被拒或排队暂停时草稿图不丢失。
   */
  async claimForSend(
    accountId: string,
    images: readonly PersonalDraftImage[],
  ): Promise<{ readonly claimed: readonly PersonalDraftImage[]; readonly blocks: readonly LocalAcpPromptBlock[] }> {
    if (images.length === 0) return { claimed: [], blocks: [] }
    if (images.length > MAX_DRAFT_IMAGES) {
      throw new Error(`单次最多发送 ${MAX_DRAFT_IMAGES} 张图片。`)
    }
    const seenIds = new Set<string>()
    for (const item of images) {
      if (!isValidLocalImageId(item.id) || seenIds.has(item.id)) {
        throw new Error("图片附件标识无效或存在重复。")
      }
      seenIds.add(item.id)
    }

    const dir = this.#accountDir(accountId)
    await mkdir(dir, { recursive: true })
    const canonicalDir = await realpath(dir)
    const createdPaths: string[] = []
    const claimed: PersonalDraftImage[] = []
    const blocks: LocalAcpPromptBlock[] = []
    let totalBytes = 0

    try {
      for (const item of images) {
        const resolved = await this.#resolveExistingFile(accountId, item.id)
        if (!resolved) {
          throw new Error(`图片附件「${item.name}」已失效或被清理，请重新粘贴后再试。`)
        }
        const bytes = await readFile(resolved.filePath)
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_SINGLE_IMAGE_BYTES) {
          throw new Error(`图片「${item.name}」超出 4 MiB 单张大小限制。`)
        }
        const detectedMime = detectImageMimeType(bytes)
        if (!detectedMime) {
          throw new Error(`图片「${item.name}」内容已损坏或格式不受支持。`)
        }
        totalBytes += bytes.byteLength
        if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new Error("单次发送的图片总大小超出 5 MiB 上限，请减少图片后重试。")
        }

        let finalItem: PersonalDraftImage
        if (item.id.startsWith("pending-")) {
          const sentId = `sent-${randomUUID()}`
          const sentPath = join(canonicalDir, `${sentId}${MIME_TO_EXT[detectedMime]}`)
          await copyFile(resolved.filePath, sentPath)
          createdPaths.push(sentPath)
          finalItem = {
            id: sentId,
            name: sanitizeImageName(item.name, detectedMime),
            mimeType: detectedMime,
            sizeBytes: bytes.byteLength,
            ...(item.width !== undefined ? { width: item.width } : {}),
            ...(item.height !== undefined ? { height: item.height } : {}),
          }
        } else {
          finalItem = {
            ...item,
            mimeType: detectedMime,
            sizeBytes: bytes.byteLength,
          }
        }

        claimed.push(finalItem)
        blocks.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: detectedMime,
        })
      }
      return { claimed, blocks }
    } catch (error) {
      await Promise.all(createdPaths.map(path => unlink(path).catch(() => {})))
      throw error
    }
  }

  async #maybeSweep(accountId: string): Promise<void> {
    const now = Date.now()
    const last = this.#lastSweepByAccount.get(accountId) ?? 0
    if (now - last < SWEEP_THROTTLE_MS) return
    this.#lastSweepByAccount.set(accountId, now)
    await this.sweep(accountId, now)
  }

  /** 清理孤儿 `.part`、过期未发送 `pending-*` 与超出账号配额的最旧 `sent-*` 文件。 */
  async sweep(accountId: string, nowMs = Date.now()): Promise<number> {
    const dir = this.#accountDir(accountId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return 0
    }

    let deleted = 0
    const sentFiles: { path: string; size: number; mtimeMs: number }[] = []
    for (const name of names) {
      const fullPath = join(dir, name)
      let info
      try {
        info = await stat(fullPath)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (name.endsWith(".part")) {
        if (nowMs - info.mtimeMs > PART_MAX_AGE_MS) {
          await unlink(fullPath).catch(() => {})
          deleted += 1
        }
        continue
      }
      if (name.startsWith("pending-")) {
        if (nowMs - info.mtimeMs > PENDING_MAX_AGE_MS) {
          await unlink(fullPath).catch(() => {})
          deleted += 1
        }
        continue
      }
      if (name.startsWith("sent-")) {
        sentFiles.push({ path: fullPath, size: info.size, mtimeMs: info.mtimeMs })
      }
    }

    let sentBytes = sentFiles.reduce((sum, item) => sum + item.size, 0)
    if (sentBytes > ACCOUNT_SENT_BUDGET_BYTES) {
      sentFiles.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const item of sentFiles) {
        if (sentBytes <= ACCOUNT_SENT_BUDGET_BYTES) break
        await unlink(item.path).catch(() => {})
        sentBytes -= item.size
        deleted += 1
      }
    }
    return deleted
  }
}
