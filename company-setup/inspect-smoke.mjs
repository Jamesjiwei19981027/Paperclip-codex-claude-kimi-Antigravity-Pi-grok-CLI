const base = 'http://127.0.0.1:3100/api';
const company = '5c3b23be-b2a6-47ca-9e71-d0de8e52105e';
const get = async path => {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
};
const [issues, runs] = await Promise.all([
  get(`/companies/${company}/issues`),
  get(`/companies/${company}/heartbeat-runs?limit=12`),
]);
console.log(JSON.stringify({
  issues: issues.map(i => ({id:i.id, key:i.identifier, title:i.title, status:i.status, parent:i.parentId,
    assignee:i.assigneeAgentId, creator:i.createdByAgentId, blockers:i.blockedByIssueIds, executionState:i.executionState})),
  runs: runs.map(r => ({id:r.id, agent:r.agentId, status:r.status, error:r.error, code:r.errorCode, summary:r.summary})),
}, null, 2));
if (process.argv[2]) {
  const log = await get(`/heartbeat-runs/${process.argv[2]}/log?offset=${process.argv[3] ?? 0}&limitBytes=200000`);
  const redacted = value => String(value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  for (const line of log.content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      for (const chunk of (row.chunk ?? '').split('\n')) {
        try {
          const event = JSON.parse(chunk);
          if (event.type === 'assistant') {
            for (const c of event.message?.content ?? []) {
              if (c.type === 'text') console.log(redacted(c.text).slice(0, 1800));
              if (c.type === 'tool_use') console.log('tool:', c.name);
            }
          }
          if (event.type === 'user') {
            for (const c of event.message?.content ?? []) {
              if (c.type === 'tool_result') console.log('result:', redacted(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 1000));
            }
          }
          if (event.type === 'result') console.log(redacted(event.result ?? event.errors).slice(0, 2400));
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') console.log(redacted(event.item.text).slice(0, 2400));
          if (event.event === 'result') console.log(redacted(event.result?.response).slice(0, 2000));
          if (event.event === 'step_update' && event.step_update?.step_type === 'tool') {
            const step = event.step_update;
            console.log('tool:', step.tool_name, redacted(JSON.stringify(step.tool_info?.parameters ?? {})).slice(0, 250));
            if (step.tool_info?.output) console.log('result:', redacted(step.tool_info.output).slice(0, 1000));
          }
          if (event.type === 'tool_execution_start') console.log('tool:', event.toolName);
          if (event.type === 'tool_execution_end') console.log('result:', redacted(JSON.stringify(event.result)).slice(0, 1000));
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            for (const part of event.message.content ?? []) if (part.type === 'text') console.log(redacted(part.text).slice(0, 2000));
          }
        } catch { if (row.stream === 'stderr') console.log(redacted(chunk).slice(0, 600)); }
      }
    } catch { /* Partial trailing record is expected in live logs. */ }
  }
  console.log('nextOffset:', log.nextOffset);
}
