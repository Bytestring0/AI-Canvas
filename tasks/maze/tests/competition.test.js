import test from 'node:test';
import assert from 'node:assert/strict';
import {createMatchup,resolveTick} from '../ui/competition.js';
import {EXAMPLES} from '../ui/examples.js';
import {hunterCandidates} from '../ui/hunters.js';
import {generateMap,createState,chooseHunter,score,rank} from '../ui/engine.js';

const ok=value=>({status:'fulfilled',value}),bad=message=>({status:'rejected',reason:Error(message)});
function setup(mode='hunters'){
  const map=generateMap('comparison','scout');
  const match=createMatchup({mode,strategies:EXAMPLES,seed:'comparison:scout',sharedId:EXAMPLES[0].id});
  const entries=match.entries.map(e=>({...e,state:{...createState(map),tick:2},hunterMemory:null}));
  const responses=entries.map(()=>({runner:ok({action:'wait',memory:{runnerTick:2}}),hunter:ok({actions:map.hunters.map(h=>({id:h.id,action:'wait'})),memory:{hunterTick:2}})}));
  return {map,match,entries,responses};
}

test('runner comparison preserves existing seeded common hunter selection',()=>{
  const match=createMatchup({mode:'runners',strategies:EXAMPLES,seed:'same:standard'});
  assert.equal(match.shared,chooseHunter(hunterCandidates(EXAMPLES),'same:standard'));
  assert.equal(match.entries.length,EXAMPLES.length);
  match.entries.forEach((entry,i)=>{assert.equal(entry.source,EXAMPLES[i].source);assert.equal(entry.hunterSource,match.shared.hunterSource)});
});

test('hunter comparison shares one actual runner and includes the built-in guard as a contender',()=>{
  const match=createMatchup({mode:'hunters',strategies:EXAMPLES,seed:'same:standard',sharedId:EXAMPLES[1].id});
  assert.equal(match.shared,EXAMPLES[1]);assert.equal(match.entries.length,4);
  assert.equal(match.entries.at(-1).name,'我自己写的');
  for(const entry of match.entries){
    assert.equal(entry.source,EXAMPLES[1].source);
    assert.equal(entry.runnerStrategy,EXAMPLES[1]);
    assert.equal(entry.hunterSource,entry.hunterStrategy.hunterSource);
  }
  assert.equal(new Set(match.entries.map(e=>e.id)).size,4);
  assert.equal(EXAMPLES.length,3);
});

test('empty runner pool cannot run hunter matches and removed manual choices fall back to deterministic lottery',()=>{
  for(const mode of ['hunters','runners']){
    const empty=createMatchup({mode,strategies:[],seed:'empty'});assert.equal(empty.shared,null);assert.deepEqual(empty.entries,[]);
    const a=createMatchup({mode,strategies:EXAMPLES,seed:'stable',sharedId:'removed'});
    const b=createMatchup({mode,strategies:EXAMPLES,seed:'stable'});
    assert.equal(a.shared,b.shared);assert.equal(a.selection,'');
  }
});

test('tick resolution keeps independent runner and hunter memory in every world',()=>{
  const {map,entries,responses}=setup();
  responses.forEach((out,i)=>{out.runner.value.memory={runner:i};out.hunter.value.memory={hunter:i}});
  const before=structuredClone(entries.map(e=>e.state));
  const resolution=resolveTick(map,entries,responses,'hunters');assert.equal(resolution.invalid,null);
  resolution.updates.forEach((out,i)=>{
    assert.equal(out.state.tick,3);assert.deepEqual(out.state.memory,{runner:i});assert.deepEqual(out.hunterMemory,{hunter:i});
    assert.equal(out.action.tick,2);assert.equal(out.action.runner.action,'wait');
  });
  assert.deepEqual(entries.map(e=>e.state),before);
});

test('a failing independent hunter loses only its match, including malformed actions',()=>{
  for(const malformed of [false,true]){
    const {map,entries,responses}=setup();
    responses[0].hunter=malformed?ok({actions:[]}):bad('hunter failed');
    const result=resolveTick(map,entries,responses,'hunters');
    assert.equal(result.invalid,null);assert.equal(result.updates[0].state.status,'error');
    assert.equal(result.updates[0].state.failedRole,'hunter');assert.equal(score(map,result.updates[0].state,'hunters').total,0);
    result.updates.slice(1).forEach(out=>assert.equal(out.state.status,'running'));
  }
});

test('failure of a shared strategy voids the whole round in either mode',()=>{
  for(const mode of ['hunters','runners']){
    const {map,entries,responses}=setup(mode),role=mode==='hunters'?'runner':'hunter';
    responses[1][role]=bad('shared failed');
    const result=resolveTick(map,entries,responses,mode);
    assert.equal(result.invalid.role,role);assert.equal(result.invalid.message,'shared failed');assert.deepEqual(result.updates,[]);
    entries.forEach(e=>assert.equal(e.state.tick,2));
  }
  const {map,entries,responses}=setup('runners');responses[0].hunter=ok({actions:[]});
  assert.equal(resolveTick(map,entries,responses,'runners').invalid.role,'hunter');
});

test('runner comparison still isolates individual runner errors',()=>{
  const {map,entries,responses}=setup('runners');responses[0].runner=bad('runner failed');
  const result=resolveTick(map,entries,responses,'runners');assert.equal(result.invalid,null);
  assert.equal(result.updates[0].state.status,'error');result.updates.slice(1).forEach(out=>assert.equal(out.state.status,'running'));
});

test('hunter scores prioritize elimination, then containment, then escaped players',()=>{
  const map=generateMap('score-hunters','standard'),s=createState(map);
  const dead={...s,status:'dead',hp:0,finishTick:map.maxTicks,visited:Array(map.floorCount).fill('x')};
  const timeout={...s,status:'timeout',hp:1,finishTick:map.maxTicks};
  const escaped={...s,status:'escaped',hp:1,finishTick:50};
  assert(score(map,dead,'hunters').total>score(map,timeout,'hunters').total);
  assert(score(map,timeout,'hunters').total>score(map,escaped,'hunters').total);
  assert(score(map,{...dead,finishTick:50},'hunters').total>score(map,dead,'hunters').total);
  for(const state of [s,dead,timeout,escaped]){
    const sc=score(map,state,'hunters');assert(sc.total>=0&&sc.total<=10000);
    assert.equal(sc.total,sc.capture+sc.speed+sc.damage+sc.denial);
  }
  assert.equal(score(map,{...dead,status:'error'},'hunters').total,0);
  const a={id:'a',state:{...escaped,finishTick:70}},b={id:'b',state:escaped};
  assert.equal(rank(map,[b,a],'hunters')[0].id,'a');
  assert.deepEqual(score(map,s),score(map,s,'runners'));
});
