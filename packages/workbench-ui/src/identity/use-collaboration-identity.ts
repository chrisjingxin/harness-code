/** 监听窗口身份并统一登录/退出动作，供导航和账号面板共用。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { CollaborationHost, IdentityState } from "@workbench/contracts"

/** 只保留宿主确认的身份；退出开始即隐藏已登录数据。 */
export function useCollaborationIdentity(host: CollaborationHost) {
  const [state, setState] = useState<IdentityState>({ status: "loading" })
  const [action, setAction] = useState<"signIn" | "signOut" | null>(null)
  const [notice, setNotice] = useState("")
  const revision = useRef(0)
  const operation = useRef(0)
  const pending = useRef<typeof action>(null)

  const refresh = useCallback(async () => {
    const version = revision.current
    try {
      const result = await host.getState()
      if (version !== revision.current) return
      if (result.ok) { setState(result.value); setNotice("") }
      else setNotice(result.error.message)
    } catch {
      if (version === revision.current) setNotice("无法确认服务连接，请重试。")
    }
  }, [host])

  useEffect(() => {
    const unsubscribe = host.onStateChanged(next => {
      revision.current++
      setState(next)
    })
    // 宿主先发的更新比初始查询更可靠，迟到的初始状态不能覆盖它。
    void refresh()
    return () => {
      revision.current++
      operation.current++
      pending.current = null
      unsubscribe()
    }
  }, [host, refresh])

  async function perform(kind: "signIn" | "signOut", username = "") {
    if (pending.current === "signOut" || (kind === "signIn" && pending.current)) return
    const request = ++operation.current
    const version = ++revision.current
    pending.current = kind
    setAction(kind)
    setState({ status: "loading" })
    setNotice("")
    try {
      const result = kind === "signIn" ? await host.signIn(username) : await host.signOut()
      if (request !== operation.current) return
      if (version === revision.current) await refresh()
      if (request === operation.current && !result.ok) setNotice(result.error.message)
    } catch {
      if (request !== operation.current) return
      if (version === revision.current) setState(kind === "signOut" ? { status: "signedOut" } : state)
      setNotice(kind === "signOut" ? "本机已退出，服务端退出未确认" : "身份操作未完成，请重试连接。")
    } finally {
      if (request === operation.current) {
        pending.current = null
        setAction(null)
      }
    }
  }
  return { state, action, notice, refresh, signIn: (username: string) => perform("signIn", username), signOut: () => perform("signOut") }
}
