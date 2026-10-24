import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('reads report Markdown from a temporary body file and completes the task', async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'paperclip-save-report-'));
  const bodyFile = path.join(tempDir, 'quality-review.md');
  const markdown = '# Quality review\n\nPASS\n';
  await writeFile(bodyFile, markdown, 'utf8');
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  let savedPayload = null;
  let completionPayload = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;

    if (request.method === 'GET' && request.url === '/api/issues/issue-1/documents') {
      response.end('[]');
      return;
    }
    if (request.method === 'PUT' && request.url === '/api/issues/issue-1/documents/quality-review') {
      savedPayload = payload;
      response.end(JSON.stringify({ id: 'document-1', key: 'quality-review', latestRevisionId: 'revision-1', body: payload.body }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/issues/issue-1') {
      response.end(JSON.stringify({ identifier: 'AI-6', executionPolicy: null, status: completionPayload ? 'done' : 'in_progress' }));
      return;
    }
    if (request.method === 'PATCH' && request.url === '/api/issues/issue-1') {
      completionPayload = payload;
      response.end(JSON.stringify({ status: 'done' }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(here, 'save-report.mjs'),
      'quality-review',
      'Quality Review',
      '--body-file',
      bodyFile,
      '--complete',
    ], {
      env: {
        ...process.env,
        PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}`,
        PAPERCLIP_API_KEY: 'test-token',
        PAPERCLIP_TASK_ID: 'issue-1',
        PAPERCLIP_RUN_ID: 'run-1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(savedPayload.body, markdown);
  assert.equal(completionPayload.status, 'done');
  assert.deepEqual(JSON.parse(result.stdout), {
    document: 'quality-review',
    documentId: 'document-1',
    revisionId: 'revision-1',
    link: '/AI/issues/AI-6#document-quality-review',
    completed: true,
    taskStatus: 'done',
    bodyMatches: true,
  });
});

test('rejects report Markdown containing non-whitespace control characters', async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'paperclip-save-report-control-'));
  const bodyFile = path.join(tempDir, 'quality-review.md');
  await writeFile(bodyFile, '# Quality review\n\nassert\u0007throws\n', 'utf8');
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(here, 'save-report.mjs'),
      'quality-review',
      'Quality Review',
      '--body-file',
      bodyFile,
    ], {
      env: {
        ...process.env,
        PAPERCLIP_API_URL: 'http://127.0.0.1:1',
        PAPERCLIP_API_KEY: 'test-token',
        PAPERCLIP_TASK_ID: 'issue-1',
        PAPERCLIP_RUN_ID: 'run-1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported control character U\+0007/i);
});
