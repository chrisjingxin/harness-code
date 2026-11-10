/**
 * 表单形状识别：提问、计划、目标、拒绝原因，以及认不出时的通用提问。
 */

import { describe, expect, test } from "bun:test"

import { recognizeForm, toElicitationResponse, toInteractionEnvelope } from "../../src/acp-web/client/elicitation"
import type { InteractionResponse } from "@za38/protocol"

const context = { requestId: "el-1", threadId: "thread", runId: "run", message: "" }

describe("recognizeForm", () => {
  test("q_N 是提问；其他文本单独交回", () => {
    const form = recognizeForm({
      type: "object",
      properties: {
        q_0: { type: "string", title: "方案", description: "甲：快", oneOf: [{ const: "a", title: "甲" }] },
        q_0_other: { type: "string", title: "其他（可选）" },
        q_1: { type: "array", title: "范围", items: { anyOf: [{ const: "x", title: "一" }, { const: "y", title: "二" }] } },
      },
    }, "用哪种方案")
    expect(form.kind).toBe("question")
    if (form.kind !== "question") throw new Error("unreachable")
    expect(form.questions.map(question => question.id)).toEqual(["q_0", "q_1"])
    expect(form.questions[0]).toMatchObject({ question: "方案", allowOther: true, otherKey: "q_0_other", multi: false })
    expect(form.questions[1]).toMatchObject({ multi: true, allowOther: false })
    const envelope = toInteractionEnvelope(form, { ...context, message: "用哪种方案" })
    expect(envelope?.type).toBe("question")
    const response: InteractionResponse = { request_id: "el-1", type: "question", answers: { q_0: ["a", "丙"], q_1: ["x", "y"] } }
    expect(toElicitationResponse(form, response)).toEqual({
      action: "accept",
      content: { q_0: "a", q_0_other: "丙", q_1: ["x", "y"] },
    })
  })

  test("没有选项的 q_N 字符串是填空，回答写回本题", () => {
    const form = recognizeForm({
      type: "object",
      properties: {
        q_0: { type: "string", title: "具体任务是什么？", maxLength: 4000 },
      },
      required: ["q_0"],
    }, "具体任务是什么？")
    expect(form.kind).toBe("question")
    if (form.kind !== "question") throw new Error("unreachable")
    expect(form.questions[0]).toMatchObject({ id: "q_0", options: [], allowOther: true, otherKey: null })
    expect(toElicitationResponse(form, { request_id: "el-1", type: "question", answers: { q_0: ["用甲方案"] } })).toEqual({
      action: "accept",
      content: { q_0: "用甲方案" },
    })
  })

  test("计划只保留规范决策，正文从固定前缀里取出", () => {
    const form = recognizeForm({
      type: "object",
      properties: {
        decision: { type: "string", oneOf: [{ const: "revise", title: "需要修改" }, { const: "approved", title: "批准并开始执行" }] },
        feedback: { type: "string", title: "修改意见", maxLength: 4000 },
      },
      required: ["decision"],
    }, "请确认执行计划（计划.md）\n\n# 步骤")
    expect(form).toMatchObject({ kind: "plan", displayPath: "计划.md", markdown: "# 步骤", decisions: ["approved", "revise"] })
    if (form.kind !== "plan") throw new Error("unreachable")
    const envelope = toInteractionEnvelope(form, context)
    expect(envelope?.type).toBe("plan")
    if (envelope?.type !== "plan") throw new Error("unreachable")
    expect(envelope.payload.plan_virtual_path).toBe("/.harness/plan.md")
    expect(envelope.payload.decisions).toEqual(["approved", "revise"])
    expect(toElicitationResponse(form, { request_id: "el-1", type: "plan", decision: "revise", feedback: "改一下" })).toEqual({
      action: "accept",
      content: { decision: "revise", feedback: "改一下" },
    })
  })

  test("目标带判定条件默认值；cancelled 不是选项", () => {
    const form = recognizeForm({
      type: "object",
      properties: {
        decision: { type: "string", oneOf: [{ const: "accepted", title: "接受" }, { const: "edited", title: "修改判定条件后接受" }] },
        criteria: { type: "string", title: "判定条件（每行一条）", default: "有失败用例\n\n能复现" },
        feedback: { type: "string", maxLength: 4000 },
      },
    }, "确认目标：修掉失败\n假设：测试已在\n仓库可写")
    expect(form).toMatchObject({
      kind: "goal",
      objective: "修掉失败",
      assumptions: ["测试已在", "仓库可写"],
      criteria: ["有失败用例", "能复现"],
      decisions: ["accepted", "edited"],
    })
    if (form.kind !== "goal") throw new Error("unreachable")
    expect(toElicitationResponse(form, {
      request_id: "el-1",
      type: "goal",
      decision: "edited",
      criteria: ["有失败用例"],
      feedback: "收紧",
    })).toEqual({ action: "accept", content: { decision: "edited", feedback: "收紧", criteria: "有失败用例" } })
    expect(toElicitationResponse(form, { request_id: "el-1", type: "goal", decision: "cancelled" }).action).toBe("cancel")
  })

  test("只有必填 feedback 是拒绝原因；认不出的字段变成通用提问", () => {
    expect(recognizeForm({
      type: "object",
      required: ["feedback"],
      properties: { feedback: { type: "string", maxLength: 4000 } },
    }, "请说明拒绝原因").kind).toBe("feedback")
    const generic = recognizeForm({
      type: "object",
      properties: { note: { type: "string", title: "备注" } },
    }, "补充")
    expect(generic.kind).toBe("question")
    if (generic.kind !== "question") throw new Error("unreachable")
    expect(generic.questions[0]).toMatchObject({ id: "note", allowOther: true, question: "备注" })
    expect(toElicitationResponse(generic, { request_id: "el-1", type: "question", answers: { note: ["写这里"] } })).toEqual({
      action: "accept",
      content: { note: "写这里" },
    })
  })
})
