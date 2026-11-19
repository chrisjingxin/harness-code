/** 唯一资源清单 → 只加载本地 schema → 编译所有形状 → 检查同组正反例。无 Java/DB 前置。 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve, dirname } from "node:path"
import assert from "node:assert/strict"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

export const contractRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts")
const read = async path => JSON.parse(await readFile(resolve(contractRoot, path), "utf8"))

/** 资源名只允许包内相对 JSON；不从网络或未登记路径补齐引用。 */
export async function loadContracts() {
  const catalog = await read("resources.json")
  for (const names of Object.values(catalog)) for (const name of names) assert.match(name, /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/)
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false })
  addFormats(ajv)
  const schemas = []
  const types = new Map()
  for (const name of catalog.schemas) {
    const node = await read(`schema/${name}`)
    if (!node.$id) throw new Error(`schema 缺少 $id: ${name}`)
    schemas.push({ name, id: node.$id, node })
    ajv.addSchema(node)
  }
  for (const { id, node } of schemas) {
    for (const type of Object.keys(node.$defs ?? {})) {
      assert(!types.has(type), `契约类型重名: ${type}`)
      types.set(type, id)
    }
  }
  const validator = type => {
    const id = types.get(type)
    if (!id) throw new Error(`夹具未知类型 ${type}`)
    const validate = ajv.getSchema(`${id}#/$defs/${type}`)
    if (!validate) throw new Error(`契约类型无法编译: ${type}`)
    return validate
  }
  // 先把全部类型编译一遍，避免夹具未覆盖的引用悬空。
  for (const type of types.keys()) validator(type)
  for (const file of catalog.openapi) {
    const document = await read(`openapi/${file}`)
    function refs(value) {
      if (!value || typeof value !== "object") return
      if (value.$ref) {
        const match = /^\.\.\/schema\/([^#]+)#\/\$defs\/(\w+)$/.exec(value.$ref)
        assert(match && catalog.schemas.includes(match[1]), "OpenAPI 只能引用已登记的本地 schema")
        assert(types.has(match[2]), `OpenAPI 引用未登记类型 ${match[2]}`)
      }
      for (const child of Object.values(value)) refs(child)
    }
    refs(document)
  }
  return { catalog, schemas, types, ajv, read, validator }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { catalog, validator, read } = await loadContracts()
  const results = []
  for (const file of catalog.fixtures) for (const entry of await read(`fixtures/${file}`)) {
    const validate = validator(entry.schema)
    const valid = validate(entry.data)
    assert.equal(valid, entry.valid, `夹具失败 ${entry.name}: ${JSON.stringify(validate.errors)}`)
    results.push({ name: entry.name, valid })
  }
  console.log(JSON.stringify({ engine: "node", results }))
}
