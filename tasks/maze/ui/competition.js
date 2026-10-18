import {chooseHunter,step,failState,validateHunterResponse} from './engine.js';
import {hunterCandidates} from './hunters.js';

// Match identity is the competing side; both actual scripts are explicit for workers and exports.
export function createMatchup({mode='runners',strategies,seed,sharedId=''}){
  const runnerPool=[...strategies],hunterPool=hunterCandidates(strategies);
  const pool=mode==='hunters'?runnerPool:hunterPool;
  const selected=pool.find(s=>s.id===sharedId);
  const shared=runnerPool.length?(selected||chooseHunter(pool,mode==='hunters'?seed+':runner':seed)):null;
  const competitors=shared?(mode==='hunters'?hunterPool:runnerPool):[];
  const entries=competitors.map(competitor=>{
    const runnerStrategy=mode==='hunters'?shared:competitor;
    const hunterStrategy=mode==='hunters'?competitor:shared;
    return {...competitor,color:competitor.color||'#b86669',kind:competitor.kind||'内置追逐策略',
      runnerStrategy,hunterStrategy,source:runnerStrategy.source,hunterSource:hunterStrategy.hunterSource};
  });
  return {entries,runnerPool,hunterPool,shared,selection:selected?sharedId:''};
}

function errorMessage(result){return String(result.reason?.message||result.reason||'策略执行失败')}
export function resolveTick(map,entries,outputs,mode='runners'){
  const decisions=outputs.map((out,i)=>{
    if(!out)return null;
    let hunter=out.hunter;
    if(hunter.status==='fulfilled'&&(entries[i].state.tick+1)%map.hunterEvery===0){
      try{validateHunterResponse(entries[i].state,hunter.value)}catch(reason){hunter={status:'rejected',reason}}
    }
    return {runner:out.runner,hunter};
  });
  const common=mode==='hunters'?'runner':'hunter';
  const failed=decisions.find(out=>out?.[common].status==='rejected');
  if(failed)return {invalid:{role:common,message:errorMessage(failed[common])},updates:[]};
  const updates=decisions.map((out,i)=>{
    if(!out)return null;
    const e=entries[i],role=mode==='hunters'?'hunter':'runner',moving=(e.state.tick+1)%map.hunterEvery===0;
    let state;
    if(out[role].status==='rejected'){
      state=failState(e.state,errorMessage(out[role]));state.tick=e.state.tick+1;state.failedRole=role;
    }else state=step(map,e.state,out.runner.value,out.hunter.value);
    const value=result=>result.status==='fulfilled'?result.value:{error:errorMessage(result)};
    return {state,hunterMemory:out.hunter.status==='fulfilled'?(out.hunter.value.memory??null):e.hunterMemory,
      action:{tick:e.state.tick,runner:value(out.runner),hunter:moving?value(out.hunter):null}};
  });
  return {invalid:null,updates};
}
