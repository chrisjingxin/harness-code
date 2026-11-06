/** assets.ts 用例：资源名白名单与占位页提供者。 */

import { describe, expect, test } from "bun:test"

import { assertValidAssets, placeholderAssets } from "../../src/acp-web/bridge/assets"

describe("assertValidAssets", () => {
  test("合法资源名通过并原样返回", () => {
    const assets = {
      html: "<html></html>",
      files: {
        "app.js": { contentType: "text/javascript", body: "x" },
        "app.css": { contentType: "text/css", body: "x" },
        "syntax-worker.js": { contentType: "text/javascript", body: "x" },
        "a1._-b.txt": { contentType: "text/plain", body: "x" },
      },
    }
    expect(assertValidAssets(assets)).toBe(assets)
  })

  test.each([
    "a/b.js",        // 含斜杠（路径穿越）
    "..",
    "../x.js",
    "a..b",          // 含 .. 一律拒绝，防止路径拼接
    "App.js",        // 大写
    "a%2ejs",        // 含 %（编码穿越）
    "a b.js",        // 空格
    ".hidden",       // 首字符必须是字母或数字
    "-x.js",
    "_x.js",
    "",
    "a".repeat(65),  // 超过 64 字符
  ])("拒绝资源名 %j", key => {
    const assets = { html: "", files: { [key]: { contentType: "text/plain", body: "x" } } }
    expect(() => assertValidAssets(assets)).toThrow()
  })
})

describe("placeholderAssets", () => {
  test("返回占位 HTML 且 files 为空", async () => {
    const assets = await placeholderAssets()
    expect(assets.html).toContain("<!doctype html>")
    expect(assets.html).toContain("Harness Code · ACP 桥")
    expect(assets.html).toContain('id="acp-placeholder"')
    expect(assets.html).not.toContain("<script")
    expect(Object.keys(assets.files)).toEqual([])
    expect(assertValidAssets(assets)).toBe(assets)
  })
})
