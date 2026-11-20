/**
 * HC-238 单元测试：验证 LocalImageStore 魔数校验、原子落盘、两阶段不可变发送、删除保护与清理。
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { LocalImageStore, detectImageMimeType, isValidLocalImageId } from "../src/main/local-image-store.ts"
import { MAX_SINGLE_IMAGE_BYTES } from "../src/shared/personal.ts"

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00])
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
])

function accountDirName(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 24)
}

test("detectImageMimeType 与 isValidLocalImageId 严格识别魔数和合法标识", () => {
  assert.equal(detectImageMimeType(PNG_BYTES), "image/png")
  assert.equal(detectImageMimeType(JPEG_BYTES), "image/jpeg")
  assert.equal(detectImageMimeType(GIF_BYTES), "image/gif")
  assert.equal(detectImageMimeType(WEBP_BYTES), "image/webp")
  assert.equal(detectImageMimeType(new TextEncoder().encode("not an image")), null)
  assert.equal(detectImageMimeType(new Uint8Array([0x89, 0x50])), null)

  assert.equal(isValidLocalImageId("pending-11111111-1111-4111-8111-111111111111"), true)
  assert.equal(isValidLocalImageId("sent-11111111-1111-4111-8111-111111111111"), true)
  assert.equal(isValidLocalImageId("../pending-11111111-1111-4111-8111-111111111111"), false)
  assert.equal(isValidLocalImageId("other-11111111-1111-4111-8111-111111111111"), false)
})

test("stage 拒绝伪造 MIME 与越界字节，仅接受真实图片魔数并清洗文件名", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc238-image-stage-"))
  try {
    const store = new LocalImageStore(root)
    await assert.rejects(
      store.stage("acc-a", {
        name: "fake.png",
        mimeType: "image/png",
        bytes: new TextEncoder().encode("<svg>not png</svg>"),
      }),
      /仅支持有效的 PNG、JPEG、WebP 或 GIF/,
    )
    await assert.rejects(
      store.stage("acc-a", {
        name: "empty.png",
        mimeType: "image/png",
        bytes: new Uint8Array(0),
      }),
      /图片大小无效/,
    )
    await assert.rejects(
      store.stage("acc-a", {
        name: "huge.png",
        mimeType: "image/png",
        bytes: new Uint8Array(MAX_SINGLE_IMAGE_BYTES + 1),
      }),
      /4 MiB/,
    )

    // 客户端谎报 mimeType 为 png 但魔数为 jpeg 时，以魔数为准纠正
    const staged = await store.stage("acc-a", {
      name: "../../secret\\shot.jpg",
      mimeType: "image/png",
      bytes: JPEG_BYTES,
      width: 640,
      height: 480,
    })
    assert.ok(staged.id.startsWith("pending-"))
    assert.equal(staged.mimeType, "image/jpeg")
    assert.equal(staged.sizeBytes, JPEG_BYTES.byteLength)
    assert.equal(staged.width, 640)
    assert.equal(staged.height, 480)
    assert.equal(staged.name.includes("/"), false)
    assert.equal(staged.name.includes("\\"), false)

    // 账号严格隔离：acc-b 不能读取 acc-a 的暂存图片
    const loadedA = await store.read("acc-a", staged.id)
    assert.ok(loadedA)
    assert.equal(loadedA.mimeType, "image/jpeg")
    assert.deepEqual(loadedA.bytes, JPEG_BYTES)
    assert.equal(await store.read("acc-b", staged.id), null)
    assert.equal(await store.read("acc-a", "../escape"), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("claimForSend 生成不可变 sent-* 并保留 pending-*，removePending 保护 sent-* 不误删", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc238-image-claim-"))
  try {
    const store = new LocalImageStore(root)
    const staged = await store.stage("acc-a", {
      name: "clip.png",
      mimeType: "image/png",
      bytes: PNG_BYTES,
      width: 100,
      height: 80,
    })

    const result = await store.claimForSend("acc-a", [staged])
    assert.equal(result.claimed.length, 1)
    assert.equal(result.blocks.length, 1)
    const claimed = result.claimed[0]!
    assert.ok(claimed.id.startsWith("sent-"))
    assert.notEqual(claimed.id, staged.id)
    assert.deepEqual(result.blocks[0], {
      type: "image",
      data: Buffer.from(PNG_BYTES).toString("base64"),
      mimeType: "image/png",
    })

    // 发送冻结出 sent-* 后，原 pending-* 依然可读（用于失败重发），且 sent-* 受 removePending 保护
    assert.ok(await store.read("acc-a", staged.id))
    assert.ok(await store.read("acc-a", claimed.id))
    await store.removePending("acc-a", claimed.id)
    assert.ok(await store.read("acc-a", claimed.id))
    await store.removePending("acc-a", staged.id)
    assert.equal(await store.read("acc-a", staged.id), null)
    assert.ok(await store.read("acc-a", claimed.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("claimForSend 超出 5 MiB 累计体积上限时回滚已生成的 sent-* 文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc238-image-budget-"))
  try {
    const store = new LocalImageStore(root)
    const threeMb = new Uint8Array(3 * 1024 * 1024)
    threeMb.set(PNG_BYTES, 0)
    const img1 = await store.stage("acc-a", { name: "a.png", mimeType: "image/png", bytes: threeMb })
    const img2 = await store.stage("acc-a", { name: "b.png", mimeType: "image/png", bytes: threeMb })

    await assert.rejects(
      store.claimForSend("acc-a", [img1, img2]),
      /超出 5 MiB 上限/,
    )

    const dir = join(root, accountDirName("acc-a"))
    const files = await readdir(dir)
    assert.equal(files.some(name => name.startsWith("sent-")), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("sweep 清理超时 .part 和 pending-*，保留 sent-* 历史图", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc238-image-sweep-"))
  try {
    const store = new LocalImageStore(root)
    const pending = await store.stage("acc-a", { name: "a.png", mimeType: "image/png", bytes: PNG_BYTES })
    const claimed = await store.claimForSend("acc-a", [pending])
    const pending2 = await store.stage("acc-a", { name: "b.png", mimeType: "image/png", bytes: PNG_BYTES })
    const dir = join(root, accountDirName("acc-a"))
    const orphanPart = join(dir, "orphan.part")
    await writeFile(orphanPart, "partial")
    const partInfo = await stat(orphanPart)

    // 2 小时后：清掉 orphan.part（>1h），保留 pending-*（<48h）和 sent-*
    const afterTwoHours = partInfo.mtimeMs + 2 * 60 * 60 * 1000
    const cleanedPart = await store.sweep("acc-a", afterTwoHours)
    assert.equal(cleanedPart, 1)
    assert.ok(await store.read("acc-a", pending.id))
    assert.ok(await store.read("acc-a", pending2.id))
    assert.ok(await store.read("acc-a", claimed.claimed[0]!.id))

    // 49 小时后：清掉过期 pending-*，保留 sent-*
    const after49Hours = partInfo.mtimeMs + 49 * 60 * 60 * 1000
    const cleanedPending = await store.sweep("acc-a", after49Hours)
    assert.equal(cleanedPending, 2)
    assert.equal(await store.read("acc-a", pending.id), null)
    assert.ok(await store.read("acc-a", claimed.claimed[0]!.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
