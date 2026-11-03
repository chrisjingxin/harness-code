/** Git UI 契约的边界输入防御。 */
import { expect, test } from "bun:test"
import { parseClientFrame, UI_CONTRACT_VERSION } from "../../src/presentation-coordinator/contracts"
test("Git 消息只接受有界精确字段；拒绝重复/NUL/超长路径",()=>{
 expect(UI_CONTRACT_VERSION).toBe(10)
 const valid={type:"git.commit",snapshot:"s",paths:["中文 空格\n.txt"],message:"x",push:false}
 const parse=(intent:unknown)=>parseClientFrame(JSON.stringify({type:"interactive.intent",requestId:"git",revision:1,intent}))
 expect(parse(valid)).toBeDefined()
 for(const bad of [{...valid,paths:["a","a"]},{...valid,paths:["a\0b"]},{...valid,message:"a\0b"},{...valid,paths:["x".repeat(4097)]},{...valid,force:true},{...valid,push:"true"}]) expect(parse(bad)).toBeUndefined()
})
