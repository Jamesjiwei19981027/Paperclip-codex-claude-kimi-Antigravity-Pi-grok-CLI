import { workerData } from 'node:worker_threads';
import type { Executor } from '../../src/executors/types.ts';
const mode=workerData.executorData?.mode;
const executor:Executor={name:'test-only',async execute(hooks){
 if(mode==='throw-secret')throw new Error('x'.repeat(1010)+hooks.job.authToken);
 if(mode==='live-handle')setInterval(()=>{},1000);
 if(mode==='error-code')return {exitCode:0,signal:null,timedOut:false,errorCode:'member_agent_codebuddy_login_required'};
 if(mode==='timed-out')return {exitCode:0,signal:null,timedOut:true};
 if(mode==='nonzero')return {exitCode:2,signal:null,timedOut:false};
 if(mode==='blocked'){const end=Date.now()+2000;while(Date.now()<end){} }
 if(mode==='wait')await new Promise<void>(resolve=>{if(hooks.signal.aborted)resolve();else hooks.signal.addEventListener('abort',()=>resolve(),{once:true});});
 if(mode==='secret'){
  for(const secret of ['FAKE-AGENT-KEY-ONLY-FOR-TESTS',hooks.job.authToken,hooks.job.runtimeTools?.bearerToken as string]){hooks.log('stdout',secret.slice(0,8));hooks.log('stdout',secret.slice(8)+'\n');}
 }
 hooks.log('stdout','测试输出一\n');hooks.log('stdout','测试输出二\n');hooks.event({eventType:'fixture.progress',message:'测试事件'});
 return {exitCode:0,signal:null,timedOut:false,...(mode==='invalid'?{unexpected:'must not be sent'}:{})};
}};
export default executor;
