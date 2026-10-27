import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
const evidence='E:/workspace/paperclip-member-agent-dev/doc/plans/2026-10-27-member-agent-s7-final-evidence';
const {WebSocket}=createRequire('D:/paperclip/member-agent/package.json')('ws');
const response=await fetch('http://192.168.0.213:3100/api/health',{signal:AbortSignal.timeout(10000)});
const body=await response.json();
if(response.status!==200||body.status!=='ok'||body.deploymentMode!=='authenticated')throw Error('External health failed');
const noKey=await new Promise((resolve,reject)=>{
 const socket=new WebSocket('ws://192.168.0.213:3100/api/member-agent/v1/connect',{handshakeTimeout:10000});
 socket.on('unexpected-response',(_,reply)=>{reply.resume();resolve(reply.statusCode);});
 socket.on('open',()=>{socket.close();reject(Error('Connection without Key unexpectedly allowed'));});
 socket.on('error',reject);
});
if(noKey!==401)throw Error('External member entry without Key returned '+noKey);
const result={checkedAt:new Date().toISOString(),target:'192.168.0.213:3100',health:{httpStatus:response.status,status:body.status,deploymentMode:body.deploymentMode},memberNoKeyHttpStatus:noKey};
await fs.writeFile(evidence+'/external-smoke.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
