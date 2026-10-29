import fs from "node:fs";
const names = ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID"];
const present = Object.fromEntries(names.map(name => [name, Boolean(process.env[name])]));
console.log(JSON.stringify(present, null, 2));
console.log("Tool discovery: no Paperclip register_deliverable or artifact upload connector returned.");
console.log("The local report and ZIPs have not been uploaded or registered as work products.");
fs.writeFileSync(new URL("artifact-context.json", import.meta.url), JSON.stringify(present, null, 2) + "\n");
