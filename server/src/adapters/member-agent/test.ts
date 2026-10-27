import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";

/**
 * A member's machine is normally not connected while its agent is being created,
 * and the lifecycle verifier treats any `warn` as a failed harness test (the
 * agent would then stay paused and the connection endpoint would reject it).
 * Online state is therefore checked when the member connects, not here.
 */
export async function testEnvironment(_ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  return { adapterType: "member_agent", status: "pass", testedAt: new Date().toISOString(), checks: [
    { code: "member_agent_online_check_deferred", level: "info", message: "成员智能体是否在线在其成员端连接时验证，创建时不检查" },
  ] };
}
