import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const prefix = process.env.PAPERCLIP_COMPANY_PREFIX?.trim();
const configuredUrl = process.env.PAPERCLIP_ORG_URL?.trim();
if (!configuredUrl && (!prefix || !/^[a-zA-Z0-9_-]+$/.test(prefix))) {
  throw new Error('Set PAPERCLIP_ORG_URL to the organization page, or PAPERCLIP_COMPANY_PREFIX to its URL prefix.');
}
const orgUrl = new URL(configuredUrl || `http://127.0.0.1:3100/${encodeURIComponent(prefix)}/org`);
if (!['http:', 'https:'].includes(orgUrl.protocol) || orgUrl.username || orgUrl.password) {
  throw new Error('PAPERCLIP_ORG_URL must be an HTTP(S) URL without embedded credentials.');
}
const repoRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const isInsideRepo = (value) => {
  const relative = path.relative(repoRoot, value);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const evidenceRoot = path.resolve(process.env.PAPERCLIP_EVIDENCE_DIR || tmpdir());
if (isInsideRepo(evidenceRoot)) throw new Error('Evidence must be saved outside the repository.');
await mkdir(evidenceRoot, { recursive: true });
const canonicalEvidenceRoot = await realpath(evidenceRoot);
if (isInsideRepo(canonicalEvidenceRoot)) throw new Error('Evidence must be saved outside the repository.');
const evidenceDir = await mkdtemp(path.join(canonicalEvidenceRoot, 'paperclip-org-'));
const screenshot = path.join(evidenceDir, 'organization.png');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(orgUrl.href, { waitUntil: 'domcontentloaded' });
  await page.getByText('Claude 技术总监', { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Org chart view', exact: true }).click();
  await page.getByTestId('org-chart-viewport').waitFor();
  const text = await page.locator('body').innerText();
  for (const name of ['Claude 技术总监', 'Codex 技术负责人', 'Gemini 实现执行者', 'Pi 交叉验证执行者', 'Kimi 主实现工程师', 'Grok 质量与风险审查']) {
    if (!text.includes(name)) throw new Error(`Organization page missing: ${name}`);
  }
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ sixAgentsVisible: true, screenshot }));
} finally {
  await browser.close();
}
