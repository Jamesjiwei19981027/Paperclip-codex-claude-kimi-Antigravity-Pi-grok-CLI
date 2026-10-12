import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A run-scoped reporting helper: Markdown comes from stdin or a temporary file.
const [key, title, ...options] = process.argv.slice(2);
if (!/^[a-z0-9_-]{1,64}$/.test(key ?? '') || !title) throw new Error('Usage: save-report.mjs key title [--body-file temp.md] [--complete] < Markdown');
const complete = options.includes('--complete');
const bodyFileIndex = options.indexOf('--body-file');
const bodyFile = bodyFileIndex >= 0 ? options[bodyFileIndex + 1] : null;
if (bodyFileIndex >= 0 && !bodyFile) throw new Error('--body-file requires a path');
const {PAPERCLIP_API_URL:base, PAPERCLIP_API_KEY:token, PAPERCLIP_TASK_ID:issue, PAPERCLIP_RUN_ID:run} = process.env;
if (!base || !token || !issue || !run) throw new Error('Missing run-scoped Paperclip environment');
const url = new URL(base);
if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('This local installation helper only supports a loopback API');
let body = '';
if (bodyFile) {
  const tempRoot = await realpath(tmpdir());
  const resolvedBodyFile = await realpath(bodyFile);
  const relative = path.relative(tempRoot, resolvedBodyFile);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--body-file must be inside the system temporary directory');
  }
  body = await readFile(resolvedBodyFile, 'utf8');
} else {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) body += chunk;
}
if (!body.trim()) throw new Error('Empty report');
const unsupportedControl = body.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u)?.[0];
if (unsupportedControl) {
  const codePoint = unsupportedControl.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  throw new Error(`Report contains unsupported control character U+${codePoint}`);
}
const headers = {'Authorization':`Bearer ${token}`,'X-Paperclip-Run-Id':run,'Content-Type':'application/json'};
async function request(route, method='GET', payload) {
  const response = await fetch(`${base}/api${route}`, {method,headers,body:payload ? JSON.stringify(payload) : undefined});
  if (!response.ok) throw new Error(`Paperclip ${response.status}: ${await response.text()}`);
  return response.json();
}
const documents = await request(`/issues/${issue}/documents`);
const previous = documents.find(d => d.key === key);
const saved = await request(`/issues/${issue}/documents/${key}`, 'PUT', {
  title,format:'markdown',body,baseRevisionId:previous?.latestRevisionId ?? null,
});
if (!saved.latestRevisionId || saved.body !== body) throw new Error('Document save receipt mismatch');
const task = await request(`/issues/${issue}`);
const link = `/${task.identifier.split('-')[0]}/issues/${task.identifier}#document-${saved.key}`;
let finalTask = task;
if (complete) {
  if (task.executionPolicy?.stages?.length) throw new Error('A reviewer must complete this governed task');
  await request(`/issues/${issue}`, 'PATCH', {status:'done',comment:`Saved [${title}](${link}) and verified the document receipt.`});
  finalTask = await request(`/issues/${issue}`);
  if (finalTask.status !== 'done') throw new Error('Task completion read-back mismatch');
}
console.log(JSON.stringify({
  document: saved.key,
  documentId: saved.id ?? null,
  revisionId: saved.latestRevisionId,
  link,
  completed: complete,
  taskStatus: finalTask.status,
  bodyMatches: saved.body === body,
}));
