/**
 * 开发文档入口、链接和任务引用校验。
 */

import { access, readFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { TASK_BOARD_PATH, TASK_DIR, TASK_ID_MATCH_GLOBAL, listMarkdownFiles, loadArchivedTaskIds, loadTasks } from "./tasks.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const CURRENT_DESKTOP_SPEC_IDS = /^(?:HC-203|HC-217|HC-218|HC-219|HC-220|HC-222|HC-231)-/

const RETIRED_PATH_PREFIXES = [
  "apps/",
  "services/",
  "examples/",
  "packages/workbench-contracts/",
  "packages/workbench-ui/",
  "packages/project-service/",
  "packages/providers/",
  "packages/agent/",
  "packages/cli/",
  "packages/protocol/",
  "packages/runner-core/",
  "apps/runner/",
  "third_party/",
  "patches/",
  "scripts/install/",
  "scripts/dependencies/",
] as const

const RETIRED_EXACT_PATHS = new Set([
  "scripts/e2e-pty.py",
  "scripts/workbench/run-runner-host-smoke.mjs",
  "apps/desktop/src/main/device-host.ts",
  "services/collaboration-server/src/main/java/workbench/collaboration/application/service/DeviceAppService.java",
  "docs/user/Web界面.md",
  "docs/user/交互使用.md",
  "docs/user/使用指南.md",
  "docs/developer/architecture/TUI表现层.md",
  "docs/developer/architecture/adr/0003-single-interactive-core-dual-renderer.md",
  "docs/developer/project/dependency-inventory.json",
  "docs/developer/project/dependency-versions.json",
  "docs/developer/project/内网依赖安装.md",
  "docs/developer/project/内网依赖查询提示词.md",
  "docs/developer/project/内网迁移依赖清单.md",
])

/** 校验文档入口、任务看板和所有本地 Markdown 链接。 */
export async function checkDocs(projectRoot = root): Promise<void> {
  const required = [
    "README.md",
    "docs/user/独立桌面工作台.md",
    "docs/user/快速开始.md",
    "docs/user/安全与沙箱.md",
    "docs/user/模型配置.md",
    "docs/user/故障排查.md",
    "docs/developer/architecture/架构总览.md",
    "docs/developer/architecture/多人协作工作台顶层设计.md",
    "docs/developer/project/开发工作流.md",
    "docs/developer/project/变更检查清单.md",
    TASK_BOARD_PATH,
    `${TASK_DIR}/README.md`,
  ]
  for (const path of required) {
    try {
      await readFile(join(projectRoot, path), "utf8")
    } catch {
      throw new Error(`缺少必需文档：${path}`)
    }
  }

  const documents = [join(projectRoot, "README.md"), ...await listMarkdownFiles(join(projectRoot, "docs"))]
  const contextPath = join(projectRoot, "CONTEXT.md")
  try {
    await access(contextPath)
    documents.push(contextPath)
  } catch {
    // 最小测试夹具可不创建根目录 CONTEXT.md；真实仓库存在时纳入链接与任务编号检查。
  }

  const activeTasks = await loadTasks(projectRoot)
  const obsoleteTaskFiles = new Set(
    activeTasks
      .filter(task => task.metadata.status === "已过时")
      .map(task => resolve(projectRoot, task.file)),
  )
  const activeTaskIds = activeTasks.map(task => task.metadata.id)
  const taskIds = new Set([...activeTaskIds, ...(await loadArchivedTaskIds(projectRoot))])

  for (const document of documents) {
    const content = await readFile(document, "utf8")
    const historicalSnapshot = isHistoricalSnapshotDocument(projectRoot, document, obsoleteTaskFiles)
    for (const link of markdownLinks(content)) {
      if (isExternalLink(link)) continue
      const target = link.split("#", 1)[0]
      if (!target) continue
      const resolved = resolve(dirname(document), target)
      try {
        await readFile(resolved)
      } catch {
        // 仅允许历史快照指向明确枚举的已退役路径；活动文档仍必须 100% 指向真实存在的文件。
        if (historicalSnapshot && isRetiredPath(projectRoot, resolved)) continue
        throw new Error(`${relative(projectRoot, document)} 包含无效本地链接：${link}`)
      }
    }

    // 归档研究材料是历史快照，允许保留当时已经退出当前任务系统的编号；活动文档仍必须严格校验。
    if (!isHistoricalResearchDocument(projectRoot, document)) {
      for (const id of content.match(TASK_ID_MATCH_GLOBAL) ?? []) {
        if (!taskIds.has(id)) throw new Error(`${relative(projectRoot, document)} 引用了不存在的任务：${id}`)
      }
    }
  }
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/")
}

function isHistoricalSnapshotDocument(
  projectRoot: string,
  document: string,
  obsoleteTaskFiles: ReadonlySet<string>,
): boolean {
  const rel = toPosix(relative(projectRoot, document))
  if (rel.startsWith("docs/developer/task/archive/")) return true
  if (obsoleteTaskFiles.has(resolve(document))) return true
  if (rel.startsWith("docs/developer/research/")) return true
  if (/^docs\/developer\/(?:spec|plan|todo)\//.test(rel)) {
    return !CURRENT_DESKTOP_SPEC_IDS.test(basename(rel))
  }
  return false
}

function isRetiredPath(projectRoot: string, resolvedPath: string): boolean {
  const rel = toPosix(relative(projectRoot, resolvedPath))
  if (RETIRED_EXACT_PATHS.has(rel)) return true
  return RETIRED_PATH_PREFIXES.some(prefix => rel === prefix.slice(0, -1) || rel.startsWith(prefix))
}

function isHistoricalResearchDocument(projectRoot: string, document: string): boolean {
  const archive = join(projectRoot, "docs/developer/research/archive")
  return document === archive || document.startsWith(`${archive}${sep}`)
}

function markdownLinks(content: string): string[] {
  return [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]?.trim() ?? "")
}

function isExternalLink(value: string): boolean {
  return /^(?:https?:|mailto:|#)/i.test(value)
}
