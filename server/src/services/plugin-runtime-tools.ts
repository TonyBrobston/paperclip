import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { listReadyPluginTools } from "./plugin-tool-dispatcher.js";
import { createToolAccessDecisionCache, toolAccessPolicyService } from "./tool-access-policy.js";
import { inferToolRisk } from "./tool-risk.js";

/** Resolve discovery permissions identically for native context and dispatch.
 * Ready declarations come from the startup registry's persisted manifests;
 * company, agent, run, conditions, blocks, and approvals use the policy engine.
 */
export async function resolveRuntimePluginToolNames(input: {
  db: Db; companyId: string; agentId: string; runId: string;
}): Promise<string[]> {
  const [run] = await input.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId))).limit(1);
  const pluginPolicy = toolAccessPolicyService(input.db);
  const pluginDecisionCache = createToolAccessDecisionCache();
  const assignedPluginTools: string[] = [];
  for (const tool of await listReadyPluginTools(input.db)) {
    const decision = await pluginPolicy.decide({
      companyId: input.companyId,
      actor: { actorType: "agent", actorId: input.agentId, agentId: input.agentId },
      runContext: { heartbeatRunId: run ? input.runId : null },
      request: {
        toolName: tool.name,
        providerType: "paperclip_plugin",
        riskLevel: inferToolRisk(tool.name),
        arguments: {},
      },
    }, { cache: pluginDecisionCache });
    if (decision.allowed || decision.decision === "require_approval") assignedPluginTools.push(tool.name);
  }
  return assignedPluginTools.sort();
}
