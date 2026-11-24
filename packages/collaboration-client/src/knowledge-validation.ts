/** 本机结构化草稿只用线上同源形状校验，不发网络请求或授予发布权限。 */
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import platform from "./schema/platform.schema.json" with { type: "json" };
import organization from "./schema/organization.schema.json" with { type: "json" };
import collaboration from "./schema/collaboration.schema.json" with { type: "json" };
import type { KnowledgeProposalContent } from "./types/collaboration.js";
const ajv = new Ajv2020({ strict: true, allErrors: true });
formats.default(ajv);
for (const schema of [platform, organization, collaboration])
  ajv.addSchema(schema);
const check = ajv.getSchema<KnowledgeProposalContent>(`${collaboration.$id}#/$defs/KnowledgeProposalContent`)!;
export function isKnowledgeProposalContent(value: unknown): value is KnowledgeProposalContent { return check(value) === true; }
/** 给本机 MCP 展开同源引用，工具文档不复制另一份候选形状。 */
export function knowledgeProposalToolSchema(): Record<string, unknown> {
  const docs: Record<string, unknown> = { "platform.schema.json": platform, "organization.schema.json": organization, "collaboration.schema.json": collaboration };
  const expand = (v: unknown, doc = collaboration as unknown): unknown => {
    if (Array.isArray(v))
      return v.map(x => expand(x, doc));
    if (!v || typeof v !== "object")
      return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$ref === "string") {
      const [file, pointer] = o.$ref.split("#"), source = file ? docs[file.split("/").at(-1)!] : doc;
      let node = source as Record<string, unknown>;
      for (const key of (pointer ?? "").split("/").filter(Boolean))
        node = node[key] as Record<string, unknown>;
      return expand(node, source);
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, expand(x, doc)]));
  };
  return { type: "object", properties: { content: expand(collaboration.$defs.KnowledgeProposalContent) }, required: ["content"], additionalProperties: false };
}
