import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const base = 'http://127.0.0.1:3100/api';
const company = '5c3b23be-b2a6-47ca-9e71-d0de8e52105e';
const issue = 'f831060b-edeb-4c0b-9a86-1141933074b9';
async function request(route, options) {
  const response = await fetch(base + route, options);
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
const existing = await request(`/issues/${issue}/work-products`);
for (const filename of process.argv.slice(2)) {
  const content = await fs.readFile(filename);
  const hash = createHash('sha256').update(content).digest('hex');
  const saved = existing.find(w => w.metadata?.setupSha256 === hash);
  if (saved) {
    console.log(JSON.stringify({title:saved.title, url:saved.metadata?.contentPath ?? saved.url, reused:true}));
    continue;
  }
  const type = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.zip') ? 'application/zip' : 'text/markdown';
  const form = new FormData();
  form.append('file', new Blob([content], {type}), path.basename(filename));
  const attachment = await request(`/companies/${company}/issues/${issue}/attachments`, {method:'POST',body:form});
  const product = await request(`/issues/${issue}/work-products`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({type:'artifact',provider:'paperclip',title:`Windows 安装交付：${path.basename(filename)}`,
      status:'ready_for_review',reviewState:'needs_board_review',summary:'操作者交付的安装说明、配置脚本或组织树证据。',
      metadata:{attachmentId:attachment.id,setupSha256:hash}}),
  });
  console.log(JSON.stringify({title:product.title, attachmentId:attachment.id, url:product.metadata?.contentPath ?? product.url}));
}
