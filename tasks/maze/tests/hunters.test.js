import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILTIN_HUNTERS,hunterCandidates} from '../ui/hunters.js';
import {EXAMPLES} from '../ui/examples.js';
import {chooseHunter,generateMap,createState,observation,step,validateHunterResponse,distances,posKey} from '../ui/engine.js';

const compile=()=>new Function(BUILTIN_HUNTERS[0].hunterSource+';return decide;')();
function corridor(count){
  const width=25,height=5,grid=Array.from({length:height},()=>Array(width).fill(1));
  for(let x=1;x<width-1;x++)grid[2][x]=0;
  return {version:'maze-1',seed:'guard-test',width,height,grid,maxTicks:360,hunterEvery:3,
    start:{x:1,y:2},key:{x:7,y:2},exit:{x:23,y:2},traps:[],gates:[],coins:[{x:3,y:2}],floorCount:23,
    hunters:[{id:8,x:22,y:2},{id:2,x:6,y:2},{id:5,x:9,y:2}].slice(0,count)};
}
function decideAt(map,state,decide,memory=null){
  const input=observation(map,state,'hunter',memory),before=structuredClone(input),result=decide(input);
  validateHunterResponse(state,result);assert.deepEqual(input,before);assert(JSON.stringify(result).length<32768);
  return result;
}

test('extra hunter participates in lottery without adding a runner',()=>{
  const entries=EXAMPLES.slice(),pool=hunterCandidates(entries);
  assert.equal(entries.length,3);assert.equal(pool.length,4);
  assert.equal(pool.at(-1).name,'我自己写的');assert.equal(pool.at(-1).source,undefined);
  const seen=new Set();
  for(let i=0;i<100;i++){
    const chosen=chooseHunter(pool,'guard-lottery-'+i);seen.add(chosen.id);
    assert.equal(chosen,chooseHunter(pool,'guard-lottery-'+i));
  }
  assert.equal(seen.size,4);
});

test('one guards exit, two split key/exit, three assign two key guards',()=>{
  for(const count of [1,2,3]){
    const map=corridor(count),state=createState(map);state.tick=2;
    const result=decideAt(map,state,compile()),roles=Object.values(result.memory.roles);
    assert.equal(roles.filter(r=>r==='exit').length,1);
    assert.equal(roles.filter(r=>r==='key').length,count-1);
    assert.equal(result.memory.phase,'guard');
    assert.deepEqual(result.actions.map(a=>a.id).sort((a,b)=>a-b),state.hunters.map(h=>h.id).sort((a,b)=>a-b));
  }
});

test('guards patrol locally instead of chasing a distant player',()=>{
  for(const count of [1,2,3]){
    const map=corridor(count),decide=compile();let state=createState(map),memory=null;
    const visits=new Map(map.hunters.map(h=>[h.id,new Set()]));
    while(state.tick<90){
      let response={actions:[]};
      if((state.tick+1)%map.hunterEvery===0){response=decideAt(map,state,decide,memory);memory=response.memory;}
      state=step(map,state,{action:'wait'},response);
      if(state.tick>30)for(const h of state.hunters){
        visits.get(h.id).add(posKey(h));
        const anchor=memory.roles[h.id]==='exit'?map.exit:map.key;
        assert(distances(map,anchor).get(posKey(h))<=4);
        if(memory.roles[h.id]==='exit')assert.notDeepEqual({x:h.x,y:h.y},map.exit);
      }
    }
    for(const visited of visits.values())assert(visited.size>=2,'each guard should patrol');
  }
});

test('taking key immediately recalls every key guard into a distinct exit formation',()=>{
  for(const count of [1,2,3]){
    const map=corridor(count),decide=compile();let state=createState(map);state.tick=2;
    const before=decideAt(map,state,decide).memory;
    state.key=true;state.player={...map.key};
    let result=decideAt(map,state,decide,before),memory=result.memory;
    assert.equal(memory.phase,'exit');assert(Object.values(memory.roles).every(role=>role==='exit'));
    const targets=Object.values(memory.targets);
    assert.equal(new Set(targets.map(posKey)).size,count);
    assert.deepEqual(targets.map(p=>distances(map,map.exit).get(posKey(p))).sort((a,b)=>a-b),[1,4,7].slice(0,count));
    for(const h of state.hunters)if(before.roles[h.id]==='key')assert.equal(result.actions.find(a=>a.id===h.id).action,'right');
    state=step(map,state,{action:'wait'},result);
    while(state.tick<100){
      result={actions:[]};
      if((state.tick+1)%map.hunterEvery===0){result=decideAt(map,state,decide,memory);memory=result.memory}
      state=step(map,state,{action:'wait'},result);
    }
    assert.deepEqual(state.hunters.map(h=>h.x).sort((a,b)=>b-a),[22,19,16].slice(0,count));
  }
});

test('exit line follows a bent corridor toward the player rather than through walls',()=>{
  const map=corridor(3);map.width=15;map.height=7;map.grid=Array.from({length:7},()=>Array(15).fill(1));
  for(let x=1;x<=13;x++)map.grid[1][x]=0;
  for(let y=1;y<=5;y++)map.grid[y][13]=0;
  map.start={x:1,y:1};map.key={x:7,y:1};map.exit={x:13,y:5};
  map.hunters=[{id:8,x:13,y:4},{id:2,x:10,y:1},{id:5,x:6,y:1}];
  const state=createState(map);state.tick=2;state.key=true;
  const result=decideAt(map,state,compile()),fromExit=distances(map,map.exit),fromPlayer=distances(map,state.player);
  for(const p of Object.values(result.memory.targets)){
    assert.equal(map.grid[p.y][p.x],0);
    assert.equal(fromExit.get(posKey(p))+fromPlayer.get(posKey(p)),fromExit.get(posKey(state.player)));
  }
});

test('periodic gate is waited out using hunter cadence',()=>{
  const map=corridor(1);map.hunters[0].x=10;map.gates=[{x:11,y:2,period:6,on:3,phase:0}];
  const state=createState(map),decide=compile();state.tick=2;
  const first=decideAt(map,state,decide);assert.equal(first.actions[0].action,'wait');
  state.tick=5;
  const next=decideAt(map,state,decide,first.memory);assert.equal(next.actions[0].action,'right');
});

test('standalone guard runs reproducibly through real races at every difficulty',()=>{
  const runnerSource=EXAMPLES[0].source;
  function run(level,seed){
    const map=generateMap(seed,level),hunter=compile(),runner=new Function(runnerSource+';return decide;')();
    let state=createState(map),memory=null;const trace=[];
    while(state.status==='running'){
      let response={actions:[]};
      if((state.tick+1)%map.hunterEvery===0){response=decideAt(map,state,hunter,memory);memory=response.memory;trace.push(response.actions)}
      state=step(map,state,runner(observation(map,state)),response);
    }
    return {state,trace};
  }
  for(const level of ['scout','standard','expert'])for(const seed of ['guard-race-0','guard-race-1'])assert.deepEqual(run(level,seed),run(level,seed));
});
