import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "member-tool-schema-"));
const home = path.join(root, "fake-home");
const cwd = path.join(root, "workspace");
await Promise.all([mkdir(home),mkdir(cwd)]);
const server = createServer(async (req,res) => {
 let raw="";for await(const chunk of req)raw+=chunk.toString();
 if (!req.url?.endsWith("/responses")) {res.writeHead(404);res.end();return;}
 const request=JSON.parse(raw);
 console.log(JSON.stringify({tools:request.tools,tool_choice:request.tool_choice},null,2));
 const message={id:"msg_fake",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"FAKE_SCHEMA_OK",annotations:[]}]};
 const result={id:"resp_fake",object:"response",status:"completed",model:request.model,output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 res.writeHead(200,{"content-type":"text/event-stream"});
 for(const [type,data] of [["response.created",{response:{...result,status:"in_progress",output:[]}}],["response.output_item.added",{output_index:0,item:message}],["response.output_item.done",{output_index:0,item:message}],["response.completed",{response:result}]]){
  res.write("event: "+type+"\ndata: "+JSON.stringify({type,...data})+"\n\n");
 }
 res.end();
});
server.listen(0,"127.0.0.1");await once(server,"listening");
const port=server.address().port;
await writeFile(path.join(home,"config.toml"),'model="gpt-5.4"\nmodel_provider="fake"\n[model_providers.fake]\nname="loopback fake"\nbase_url="http://127.0.0.1:'+port+'/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n');
const env={};for(const key of ["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","APPDATA","LOCALAPPDATA","USERPROFILE","COMSPEC","PATHEXT"])if(process.env[key])env[key]=process.env[key];
env.CODEX_HOME=home;
await writeFile(path.join(home,"config.toml"), '\n[features]\ncode_mode = true\ncode_mode_host = true\ncode_mode_only = true\n', {flag:"a"});
try {
 const running=exec(path.join(os.tmpdir(),"paperclip-member-agent-codex-integration","codex-0.160.0.exe"),["exec","--json","--dangerously-bypass-approvals-and-sandbox","--skip-git-repo-check","Reply FAKE_SCHEMA_OK."],{cwd,env,windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 running.child.stdin.end();
 await running;
 console.log("CODEX_EXIT=0");
} finally {
 await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
 await rm(root,{recursive:true,force:true});
}

