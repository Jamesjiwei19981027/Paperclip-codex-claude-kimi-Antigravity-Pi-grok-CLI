import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root="E:/workspace/paperclip-member-agent-dev";
const evidence=path.join(root,"doc/plans/2026-10-27-member-agent-s7-final-evidence");
const [pkg,logName,kind,...testArgs]=process.argv.slice(2);
if(!["server","member-agent"].includes(pkg)||!logName||!["vitest","tsc"].includes(kind))throw new Error("Invalid verification command");
const profile=path.join(os.tmpdir(),"paperclip-s7-test-profile",pkg,logName);
await mkdir(profile,{recursive:true});
const env={};
for(const key of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","WINDIR","COMSPEC","ComSpec","ProgramFiles","ProgramFiles(x86)","ProgramData","OS","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS"])
 if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{APPDATA:path.join(profile,"appdata"),LOCALAPPDATA:path.join(profile,"localappdata"),USERPROFILE:profile,HOME:profile,CODEX_HOME:path.join(profile,"codex-home-fake"),TEMP:os.tmpdir(),TMP:os.tmpdir()});
const args=kind==="tsc"?[path.join(root,"node_modules/typescript/bin/tsc"),"--noEmit"]:[path.join(root,"node_modules/vitest/vitest.mjs"),"run","--config","vitest.config.ts","--cache=false","--reporter=verbose","--maxWorkers=1",...testArgs];
await writeFile(path.join(evidence,logName+".command.json"),JSON.stringify({cwd:path.join(root,pkg),command:process.execPath,args,isolatedProfile:profile},null,2));
const child=spawn(process.execPath,args,{cwd:path.join(root,pkg),env,stdio:"inherit",windowsHide:true});
child.on("error",error=>{console.error(error.message);process.exitCode=1;});
child.on("exit",code=>{console.log("EXIT_CODE="+(code??1));process.exitCode=code??1;});

