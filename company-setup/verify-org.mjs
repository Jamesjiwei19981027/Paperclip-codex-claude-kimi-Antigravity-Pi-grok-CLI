import {chromium} from '@playwright/test';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto('http://127.0.0.1:3100/AI/org', {waitUntil:'domcontentloaded'});
  await page.getByText('Claude 技术总监', {exact:false}).first().waitFor({timeout:30000});
  await page.getByRole('button', {name:'Org chart view',exact:true}).click();
  await page.getByTestId('org-chart-viewport').waitFor();
  const text = await page.locator('body').innerText();
  for (const name of ['Claude 技术总监','Codex 技术负责人','Gemini 实现执行者','Pi 交叉验证执行者','Kimi 主实现工程师','Grok 质量与风险审查']) {
    if (!text.includes(name)) throw new Error(`Organization page missing: ${name}`);
  }
  await page.screenshot({path:'company-setup/organization.png',fullPage:true});
  console.log(JSON.stringify({url:page.url(),sixAgentsVisible:true,screenshot:'company-setup/organization.png'}));
} finally {await browser.close();}
