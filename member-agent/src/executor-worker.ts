import { parentPort, workerData } from 'node:worker_threads';
import type { Executor, ExecutorResult } from './executors/types.ts';
import { validateResult } from './protocol.ts';

const port=parentPort!;
const controller=new AbortController();
port.on('message',message=>{if(message.type==='cancel')controller.abort();});
async function run(){
 try{
  const module=await import(workerData.executorUrl);
  // This local delay is exclusively for echo acceptance tests, never a server protocol field.
  const executor:Executor=module.createCodeBuddyExecutor
   ? module.createCodeBuddyExecutor(workerData.executorData)
   : module.createCodexExecutor
   ? module.createCodexExecutor(workerData.executorData)
   : module.createEchoExecutor
    ? module.createEchoExecutor({echoHoldSec:workerData.echoHoldSec})
    : module.default ?? module.echoExecutor;
  const result=await executor.execute({job:workerData.job,serverUrl:workerData.serverUrl,signal:controller.signal,
   log:(stream,text)=>port.postMessage({type:'log',stream,text}),
   event:event=>port.postMessage({type:'event',event}),
   meta:meta=>port.postMessage({type:'meta',meta}),
   usage:usage=>port.postMessage({type:'usage',usage}),
   childSpawned:pid=>port.postMessage({type:'childSpawned',pid})});
  port.postMessage({type:'result',result:validateResult(result)});
 }catch{
  const result:ExecutorResult={exitCode:1,signal:null,timedOut:false,errorCode:'member_agent_executor_error',errorMessage:'执行器发生内部错误，请检查程序文件与任务参数'};
  port.postMessage({type:'result',result});
 }finally{port.close();}
}
void run();
