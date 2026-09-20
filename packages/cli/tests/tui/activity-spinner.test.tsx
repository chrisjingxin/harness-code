/** 全屏 TUI 活动态 spinner 的定时刷新回归测试。 */
/** @jsxImportSource react */
import { PassThrough } from "node:stream"

import { render, Text } from "ink"
import React, { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useActivitySpinner } from "../../src/tui/ink/activity-spinner"

function SpinnerProbe(props: { active: boolean }) {
  return <Text>{useActivitySpinner(props.active)}</Text>
}

describe("useActivitySpinner", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("advances only while the current entry is active", async () => {
    vi.useFakeTimers()
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => { output += chunk.toString() })
    const instance = render(<SpinnerProbe active />, {
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await act(async () => undefined)
    const activeOutput = output

    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    expect(output).not.toBe(activeOutput)

    instance.rerender(<SpinnerProbe active={false} />)
    await act(async () => undefined)
    output = ""
    await act(async () => {
      vi.advanceTimersByTime(360)
    })
    expect(output).toBe("")
    instance.unmount()
  })
})
