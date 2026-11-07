/** 唯一资源清单 → 只加载本地 schema → 编译所有形状 → 检查同组正反例。无 Java/DB 前置。 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve, dirname } from "node:path"
import assert from "node:assert/strict"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

export const contractRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/workbench-contracts")
const read = async path => JSON.parse(await readFile(resolve(contractRoot, path), "utf8"))
/** 资源名只允许包内相对 JSON；不从网络或未登记路径补齐引用。 */
export async function loadContracts() {
  const catalog = await read("resources.json")
  for (const names of Object.values(catalog)) for (const name of names) assert.match(name, /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/)
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false })
  addFormats(ajv)
  for (const name of catalog.schemas) ajv.addSchema(await read(`schema/${name}`))
  const schema = await read("schema/platform.schema.json")
  for (const name of Object.keys(schema.$defs)) assert(ajv.getSchema(`${schema.$id}#/$defs/${name}`))
  for (const file of catalog.openapi) {
    const document = await read(`openapi/${file}`)
    function refs(value) {
      if (!value || typeof value !== "object") return
      if (value.$ref) {
        const match = /^\.\.\/schema\/([^#]+)#\/\$defs\/(\w+)$/.exec(value.$ref)
        assert(match && catalog.schemas.includes(match[1]), "OpenAPI 只能引用已登记的本地 schema")
        const target = value.$ref.replace("../schema/", "schema/").split("#")[0]
        // 已登记源文件中的定义必须存在，不能让路由文档引用悬空类型。
        assert((ajv.getSchema((target.endsWith("platform.schema.json") ? schema.$id : `https://workbench.invalid/${target}`) + `#/$defs/${match[2]}`)))
      }
      for (const child of Object.values(value)) refs(child)
    }
    refs(document)
  }
  return { catalog, schema, ajv, read }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { catalog, schema, ajv } = await loadContracts()
  const results = []
  for (const file of catalog.fixtures) for (const entry of await read(`fixtures/${file}`)) {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${entry.schema}`)
    assert(validate, `夹具未知类型 ${entry.schema}`)
    const valid = validate(entry.data)
    assert.equal(valid, entry.valid, `夹具失败 ${entry.name}: ${JSON.stringify(validate.errors)}`)
    results.push({ name: entry.name, valid })
  }
  console.log(JSON.stringify({ engine: "node", results }))
}
