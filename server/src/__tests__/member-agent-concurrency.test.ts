import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

describe("member agent configuration concurrency invariant", () => {
 let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 let db: ReturnType<typeof createDb>;
 beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("member-concurrency-");
  db = createDb(database.connectionString);
 }, 120000);
 afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
 async function fixture(adapterType = "member_agent") {
  const companyId = randomUUID();
  await db.insert(companies).values({id:companyId,name:"Concurrency isolation",issuePrefix:"C"+companyId.slice(0,6)});
  const [agent] = await db.insert(agents).values({
   companyId,name:"Concurrent member",adapterType,status:"idle",
   runtimeConfig:{heartbeat:{maxConcurrentRuns:20,wakeOnDemand:true},customSetting:"retained"},
  }).returning();
  return agent;
 }
 it("forces member concurrency 5 to one on a configuration update", async () => {
  const agent=await fixture();
  const updated=await agentService(db).update(agent.id,{runtimeConfig:{heartbeat:{maxConcurrentRuns:5,wakeOnDemand:true},customSetting:"retained"}});
  expect(updated?.runtimeConfig).toEqual({heartbeat:{maxConcurrentRuns:1,wakeOnDemand:true},customSetting:"retained"});
  const [persisted]=await db.select().from(agents).where(eq(agents.id,agent.id));
  expect(persisted.runtimeConfig).toEqual(updated?.runtimeConfig);
 });
 it.each([{title:"Changed title"},{adapterConfig:{maxRunSec:120}}])("corrects an existing member on an edit without runtimeConfig: %j",async patch=>{
  const agent=await fixture();
  const updated=await agentService(db).update(agent.id,patch);
  expect(updated?.runtimeConfig).toEqual({heartbeat:{maxConcurrentRuns:1,wakeOnDemand:true},customSetting:"retained"});
 });
 it.each(["process","codex_local"])("preserves explicit concurrency 20 for %s",async adapterType=>{
  const agent=await fixture(adapterType);
  const updated=await agentService(db).update(agent.id,{runtimeConfig:{heartbeat:{maxConcurrentRuns:20,wakeOnDemand:true},customSetting:"retained"}});
  expect(updated?.runtimeConfig).toEqual({heartbeat:{maxConcurrentRuns:20,wakeOnDemand:true},customSetting:"retained"});
 });
 it("corrects concurrency when switching an existing agent to member_agent",async()=>{
  const agent=await fixture("process");
  const updated=await agentService(db).update(agent.id,{adapterType:"member_agent"});
  expect(updated?.runtimeConfig).toEqual({heartbeat:{maxConcurrentRuns:1,wakeOnDemand:true},customSetting:"retained"});
 });
});
