#!/usr/bin/env node
/** 运行源码化 npm 包的安装前/安装后完整性门禁。 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  hasInstalledVendoredWorkspace,
  validateInstalledOpenTuiNativePackage,
  validateInstalledVendoredWorkspace,
  validateVendoredWorkspace,
} from "./vendor_policy.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const issues = validateVendoredWorkspace(root)
if (hasInstalledVendoredWorkspace(root)) issues.push(...validateInstalledVendoredWorkspace(root))
issues.push(...validateInstalledOpenTuiNativePackage(root))
if (issues.length > 0) {
  console.error(["源码化 npm 依赖门禁失败：", ...issues.map((issue) => `- ${issue}`)].join("\n"))
  process.exit(1)
}

const resolution = hasInstalledVendoredWorkspace(root) ? "安装后解析路径已验证" : "未发现 node_modules，跳过安装后解析检查"
console.log(`源码化 npm 依赖门禁通过：五个发布包、provenance、跨平台 native lock、Windows x64 DLL 和 ws 补丁均有效；${resolution}`)
