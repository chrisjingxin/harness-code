/** 旧设备与会话列表的读取状态；随 HC-217/218 换成 Project 导航与新会话模块后删除。 */
export type ListAvailability = {
  state: "ready" | "loading" | "offline" | "denied" | "unavailable"
  message?: string
  hasMore?: boolean
}
