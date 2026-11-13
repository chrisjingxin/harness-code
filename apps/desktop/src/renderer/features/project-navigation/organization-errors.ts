/** 组织层错误 → 用户可懂的提示。只翻译服务端已返回的错误码，不推断权限或补造原因。 */
import type { CollaborationError } from "@workbench/contracts"

const messages: Partial<Record<CollaborationError["code"], string>> = {
  PROJECT_OWNER_REQUIRED: "只有项目负责人可以修改。",
  OWNER_CANNOT_LEAVE: "不能移出项目负责人。",
  VERSION_CONFLICT: "资料已被他人更新，已重新读取，请确认后再保存。",
  PROJECT_ARCHIVED: "项目已归档，不能修改。",
  REPOSITORY_ARCHIVED: "仓库已归档，不能关联。",
  WORKSPACE_MEMBER_REQUIRED: "该用户不在当前团队。",
  RESOURCE_NOT_FOUND: "项目或成员已不可访问，已刷新。",
  REQUEST_ID_CONFLICT: "请求编号冲突，请重新提交。",
}

export function organizationMessage(error: CollaborationError): string {
  return messages[error.code] ?? error.message
}
