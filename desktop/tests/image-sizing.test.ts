/**
 * HC-238 单元测试：验证输入框图片缩放目标尺寸计算与展示格式化纯函数。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  IMAGE_ATTACHMENT_MAX_EDGE,
  fitImageAttachmentSize,
  formatImageByteSize,
  formatImageDimensions,
  inferImageMimeFromName,
} from "../src/ui/conversation/image-sizing.ts"

test("fitImageAttachmentSize 对长边超过 2000px 的图片等比缩放到 2000px 以内", () => {
  assert.equal(fitImageAttachmentSize({ width: 1920, height: 1080 }), null)
  assert.equal(fitImageAttachmentSize({ width: 2000, height: 2000 }), null)
  assert.equal(fitImageAttachmentSize({ width: 0, height: 100 }), null)
  assert.equal(fitImageAttachmentSize({ width: Number.NaN, height: 100 }), null)

  assert.deepEqual(fitImageAttachmentSize({ width: 4000, height: 2000 }), {
    width: IMAGE_ATTACHMENT_MAX_EDGE,
    height: 1000,
  })
  assert.deepEqual(fitImageAttachmentSize({ width: 1500, height: 3000 }), {
    width: 1000,
    height: IMAGE_ATTACHMENT_MAX_EDGE,
  })
})

test("formatImageDimensions / formatImageByteSize / inferImageMimeFromName 输出稳定可读", () => {
  assert.equal(formatImageDimensions(1920.2, 1080.8), "1920×1081")
  assert.equal(formatImageDimensions(0, 100), undefined)
  assert.equal(formatImageDimensions(undefined, 100), undefined)

  assert.equal(formatImageByteSize(0), "0 B")
  assert.equal(formatImageByteSize(512), "512 B")
  assert.equal(formatImageByteSize(1536), "1.5 KB")
  assert.equal(formatImageByteSize(2 * 1024 * 1024), "2.00 MB")

  assert.equal(inferImageMimeFromName("screen.PNG"), "image/png")
  assert.equal(inferImageMimeFromName("photo.jpeg"), "image/jpeg")
  assert.equal(inferImageMimeFromName("photo.jpg"), "image/jpeg")
  assert.equal(inferImageMimeFromName("pic.webp"), "image/webp")
  assert.equal(inferImageMimeFromName("anim.gif"), "image/gif")
  assert.equal(inferImageMimeFromName("doc.pdf"), null)
})
