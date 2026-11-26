/**
 * 知识轻反馈说明保存（F-39）与「让本机 Agent 整理」会话候选聚合（F-37）单元测试。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ConversationSummary, ProjectSummary } from "@workbench/collaboration-client/types"
import type {
  CollaborationAppsHost,
  ConversationPersonal,
  LocalConversationRecord,
  PersonalKey,
} from "../src/shared/index.js"
import {
  KnowledgeFeedback,
  isFeedbackNoteDirty,
  resolveFeedbackSubmitNote,
} from "../src/renderer/features/collaboration/knowledge/knowledge-feedback.tsx"
import {
  formatKnowledgeDraftCandidateLabel,
  loadKnowledgeDraftCandidates,
} from "../src/renderer/features/knowledge-drafts/knowledge-draft-candidates.ts"

const ACCOUNT_SELF = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const ACCOUNT_PEER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const WS_ID = "11111111-1111-4111-8111-111111111111"
const PROJ_ACTIVE = "22222222-2222-4222-8222-222222222222"
const PROJ_ARCHIVED = "33333333-3333-4333-8333-333333333333"

function makeLocalRecord(overrides: Partial<LocalConversationRecord> = {}): LocalConversationRecord {
  return {
    conversationId: "conv-local-1",
    workspaceId: WS_ID,
    projectId: null,
    shareMode: null,
    shareStatus: "local_only",
    title: "本机会话",
    directoryPath: "/tmp/repo-local",
    providerId: null,
    status: "idle",
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    publishedAtMs: null,
    stoppedAtMs: null,
    syncedSequence: 0,
    ...overrides,
  }
}

function makeProjectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: PROJ_ACTIVE,
    workspaceId: WS_ID,
    name: "零售核心架构演进",
    description: "",
    status: "active",
    version: 1,
    activeMemberCount: 2,
    archivedAt: null,
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-26T00:00:00Z",
    ...overrides,
  }
}

function makeProjectConv(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationId: "conv-team-1",
    projectId: PROJ_ACTIVE,
    ownerUserId: ACCOUNT_SELF,
    title: "团队新建会话",
    status: "idle",
    briefText: "",
    briefSource: "rule",
    briefUpdatedAtMs: 5_000,
    syncedSequence: 2,
    updatedAt: "2026-11-26T10:00:00.000Z",
    shareMode: "full",
    shareStatus: "active",
    stoppedAt: null,
    repositories: [],
    ...overrides,
  }
}

test("KnowledgeFeedback 正确判断说明未保存状态、撤销清理逻辑与基础控件渲染（F-39）", () => {
  assert.equal(isFeedbackNoteDirty(undefined, "过期原因"), false)
  assert.equal(isFeedbackNoteDirty({ value: null, note: "" }, "过期原因"), false)
  assert.equal(isFeedbackNoteDirty({ value: "expired", note: "" }, ""), false)
  assert.equal(isFeedbackNoteDirty({ value: "expired", note: "旧说明" }, "旧说明"), false)
  assert.equal(isFeedbackNoteDirty({ value: "expired", note: "" }, "接口字段已重构"), true)

  assert.equal(resolveFeedbackSubmitNote(null, "已填写的过期原因"), "")
  assert.equal(resolveFeedbackSubmitNote("expired", "已填写的过期原因"), "已填写的过期原因")
  assert.equal(resolveFeedbackSubmitNote("useful", "非常清晰"), "非常清晰")

  const html = renderToStaticMarkup(createElement(KnowledgeFeedback, {
    host: {} as CollaborationAppsHost,
    workspaceId: WS_ID,
    knowledgeId: "k-1",
    versionId: "v-1",
  }))
  assert.match(html, /aria-label="反馈简短说明"/)
  assert.match(html, /有用/)
  assert.match(html, /已过期或有误/)
  assert.doesNotMatch(html, /保存说明/)
})

test("loadKnowledgeDraftCandidates 合并本机与团队 Project 会话、去重、过滤并按活跃时间倒序（F-37）", async () => {
  const localPublished = makeLocalRecord({
    conversationId: "conv-shared",
    projectId: PROJ_ACTIVE,
    shareMode: "full",
    shareStatus: "active",
    title: "已发布的个人排查",
    updatedAtMs: Date.parse("2026-11-26T08:00:00.000Z"),
  })
  const localNoDir = makeLocalRecord({
    conversationId: "conv-nodir",
    directoryPath: null,
    title: "未选目录的会话",
    updatedAtMs: Date.parse("2026-11-26T11:00:00.000Z"),
  })
  const teamFresh = makeProjectConv({
    conversationId: "conv-team-fresh",
    title: "订单幂等团队排查",
    updatedAt: "2026-11-26T10:30:00.000Z",
  })
  const teamNoDir = makeProjectConv({
    conversationId: "conv-team-nodir",
    title: "未绑定本机目录的团队会话",
    updatedAt: "2026-11-26T10:45:00.000Z",
  })
  const teamOtherUser = makeProjectConv({
    conversationId: "conv-team-peer",
    ownerUserId: ACCOUNT_PEER,
    title: "队友会话",
  })
  const teamStopped = makeProjectConv({
    conversationId: "conv-team-stopped",
    shareStatus: "stopped",
    title: "已停止同步的团队会话",
  })

  const personalData = new Map<string, ConversationPersonal>([
    [
      "conv-team-fresh",
      {
        scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
        expandedTools: [],
        expandedOutputs: [],
        draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] },
        interactions: {},
        localDirectoryPath: "/Users/dev/harness-code-demo",
      },
    ],
    [
      "conv-team-nodir",
      {
        scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
        expandedTools: [],
        expandedOutputs: [],
        draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] },
        interactions: {},
        localDirectoryPath: "   ",
      },
    ],
  ])

  const result = await loadKnowledgeDraftCandidates({
    accountId: ACCOUNT_SELF,
    workspaceId: WS_ID,
    localConversations: {
      list: async () => ({ ok: true, value: [localPublished, localNoDir] }),
    },
    organization: {
      listProjects: async () => ({
        ok: true,
        value: {
          workspaceId: WS_ID,
          projects: [
            makeProjectSummary(),
            makeProjectSummary({ projectId: PROJ_ARCHIVED, name: "已归档项目", status: "archived" }),
          ],
        },
      }),
    },
    projectConversations: {
      listConversations: async (_ws, projectId) => {
        assert.equal(projectId, PROJ_ACTIVE)
        return {
          ok: true,
          value: {
            projectId,
            conversations: [
              makeProjectConv({
                conversationId: "conv-shared",
                title: "已发布的个人排查（云端副本）",
                updatedAt: "2026-11-26T10:00:00.000Z",
              }),
              teamFresh,
              teamNoDir,
              teamOtherUser,
              teamStopped,
            ],
          },
        }
      },
    },
    personal: {
      load: async (key: PersonalKey) => {
        assert.equal(key.kind, "conversation")
        const data = key.kind === "conversation" ? (personalData.get(key.conversationId) ?? null) : null
        return { ok: true, value: { revision: 1, data } }
      },
    },
  })

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.candidates.map(c => c.conversationId),
    ["conv-team-fresh", "conv-shared"],
  )
  assert.equal(
    formatKnowledgeDraftCandidateLabel(result.candidates[0]!),
    "订单幂等团队排查 · 零售核心架构演进",
  )
  assert.equal(
    formatKnowledgeDraftCandidateLabel({
      conversationId: "x",
      projectId: null,
      title: "",
      updatedAtMs: 1,
    }),
    "未命名会话",
  )
})

test("loadKnowledgeDraftCandidates 在部分来源失败时优雅降级，全部失败时返回错误", async () => {
  const partial = await loadKnowledgeDraftCandidates({
    accountId: ACCOUNT_SELF,
    workspaceId: WS_ID,
    localConversations: {
      list: async () => ({ ok: false, error: { code: "ERR", message: "本机存储损坏", retryable: false } }),
    },
    organization: {
      listProjects: async () => ({ ok: true, value: { workspaceId: WS_ID, projects: [makeProjectSummary()] } }),
    },
    projectConversations: {
      listConversations: async (_ws, projectId) => ({
        ok: true,
        value: { projectId, conversations: [makeProjectConv({ conversationId: "conv-team-only" })] },
      }),
    },
    personal: {
      load: async () => ({
        ok: true,
        value: {
          revision: 1,
          data: {
            scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
            expandedTools: [],
            expandedOutputs: [],
            draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] },
            interactions: {},
            localDirectoryPath: "/tmp/team-repo",
          } satisfies ConversationPersonal,
        },
      }),
    },
  })
  assert.equal(partial.error, undefined)
  assert.deepEqual(partial.candidates.map(c => c.conversationId), ["conv-team-only"])

  const totalFail = await loadKnowledgeDraftCandidates({
    accountId: ACCOUNT_SELF,
    workspaceId: WS_ID,
    localConversations: {
      list: async () => ({ ok: false, error: { code: "ERR_LOCAL", message: "读取本机会话失败", retryable: false } }),
    },
    organization: {
      listProjects: async () => ({ ok: false, error: { code: "ERR_NET", message: "网络异常", retryable: true } }),
    },
    projectConversations: {
      listConversations: async () => ({ ok: false, error: { code: "ERR", message: "unreachable", retryable: true } }),
    },
    personal: {
      load: async () => ({ ok: false, message: "unreachable" }),
    },
  })
  assert.deepEqual(totalFail.candidates, [])
  assert.equal(totalFail.error, "读取本机会话失败")
})
