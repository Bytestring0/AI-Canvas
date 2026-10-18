import test from 'node:test';
import assert from 'node:assert/strict';
import {LEVELS,generateMap,createState,observation,step,score,distances,active,chooseHunter,validateHunterResponse,failState,rank} from '../ui/engine.js';
import {EXAMPLES} from '../ui/examples.js';

const compile=source=>new Function(source+'; return decide;')();
function fixture(){
  return {version:'maze-1',seed:'test',width:7,height:5,maxTicks:40,hunterEvery:2,
    grid:[[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,0,0,0,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]],
    start:{x:1,y:1},key:{x:3,y:1},exit:{x:5,y:1},coins:[{x:2,y:1}],gates:[],traps:[],hunters:[{id:0,x:5,y:3}],floorCount:15};
}

test('random maps are reproducible, connected, varied, and have distinct valid features',()=>{
  for(const level of Object.keys(LEVELS))for(let i=0;i<80;i++){
    const map=generateMap('seed-'+i,level),rules=LEVELS[level];
    assert.deepEqual(map,generateMap('seed-'+i,level));
    assert.notDeepEqual(map.grid,generateMap('other-'+i,level).grid);
    assert.equal(distances(map,map.start).size,map.floorCount);
    const floor=map.grid.flat().filter(v=>v===0).length;assert.equal(floor,map.floorCount);
    const features=[map.start,map.key,map.exit,...map.hunters,...map.coins,...map.traps,...map.gates];
    assert.equal(new Set(features.map(p=>p.x+','+p.y)).size,features.length);
    features.forEach(p=>assert.equal(map.grid[p.y][p.x],0));
    for(const feature of [...map.gates,...map.traps]){
      const states=Array.from({length:feature.period},(_,t)=>active(feature,t));
      assert.equal(states.filter(Boolean).length,feature.on);assert(states.includes(false));
    }
    assert.equal(map.hunters.length,rules.hunters);
  }
});

test('wall and gate collisions, unique collection, key then safe exit',()=>{
  const map=fixture();let s=createState(map);
  s=step(map,s,{action:'up'});assert.deepEqual(s.player,map.start);
  s=step(map,s,{action:'right'});assert.equal(s.coins.length,1);
  s=step(map,s,{action:'wait'});assert.equal(s.coins.length,1);
  s=step(map,s,{action:'right'});assert.equal(s.key,true);
  map.gates=[{x:4,y:1,period:4,on:2,phase:0}];
  s=step(map,s,{action:'right'});assert.equal(s.player.x,3); // tick 4: closed
  s=step(map,s,{action:'wait'});s=step(map,s,{action:'right'});assert.equal(s.player.x,4);
  map.traps=[{...map.exit,period:4,on:4,phase:0}];s.hp=1;
  s=step(map,s,{action:'right'});assert.equal(s.status,'escaped');assert.equal(s.hp,1);
  assert.equal(s.finishTick,s.tick);assert.deepEqual(step(map,s,{action:'left'}),s);
});

test('hunter uses explicit moves at shared cadence, final-cell collisions and immunity',()=>{
  const map=fixture();map.hunters=[{id:0,x:2,y:1}];map.traps=[{x:2,y:1,period:4,on:4,phase:0}];
  let s=createState(map);const before=structuredClone(s);
  s=step(map,s,{action:'right'},{actions:[{id:0,action:'right'}]});
  assert.equal(s.hp,2);assert.equal(s.hunters[0].x,2);assert.equal(s.invulnerableUntil,3);
  assert.deepEqual(before,createState(map));
  s=step(map,s,{action:'wait'},{actions:[{id:0,action:'wait'}]});assert.equal(s.hp,2);
  s=step(map,s,{action:'wait'});assert.equal(s.hp,2);
  s=step(map,s,{action:'wait'},{actions:[{id:0,action:'wait'}]});assert.equal(s.hp,1);
  const swap=createState(map);swap.tick=1;map.traps=[];
  const swapped=step(map,swap,{action:'right'},{actions:[{id:0,action:'left'}]});assert.equal(swapped.hp,3);
});

test('timeouts, invalid hunter responses, independent memory and non-mutating observations',()=>{
  const map=fixture();map.maxTicks=1;let s=createState(map);
  assert.equal(step(map,s).status,'timeout');
  const obs=observation(map,s,'hunter',{plan:2});assert.equal(obs.role,'hunter');assert.deepEqual(obs.memory,{plan:2});
  assert.equal(observation(map,s).memory,null);
  const bad=[null,{}, {actions:[]},{actions:[{id:9,action:'up'}]},{actions:[{id:0,action:'fly'}]},{actions:[{id:0,action:'constructor'}]}];
  bad.forEach(r=>assert.throws(()=>validateHunterResponse(s,r)));
  assert.doesNotThrow(()=>validateHunterResponse(s,{actions:[{id:0,action:'wait'}]}));
  s.hunters.push({id:1,x:4,y:2});assert.throws(()=>validateHunterResponse(s,{actions:[{id:0,action:'up'},{id:0,action:'up'}]}));
});

test('scoring guarantees escape priority and deterministic tie breaks',()=>{
  const map=fixture(),s=createState(map),failure={...s,coins:map.coins.map(p=>p.x+','+p.y),visited:Array(map.floorCount).fill('x')};
  assert.equal(score(map,failure).total,2000);
  const success={...s,status:'escaped',hp:0,finishTick:map.maxTicks,visited:[]};assert.equal(score(map,success).total,6000);
  assert(score(map,success).total>score(map,failure).total);
  assert.equal(score(map,failState(s,'boom')).total,0);
  const a={id:'a',state:s},b={id:'b',state:s};assert.equal(rank(map,[b,a])[0].id,'a');
});

test('seeded hunter lottery is stable and can select every entrant',()=>{
  const seen=new Set();
  for(let i=0;i<100;i++){
    const a=chooseHunter(EXAMPLES,'seed-'+i);assert.equal(a,chooseHunter(EXAMPLES,'seed-'+i));seen.add(a.id);
  }
  assert.equal(seen.size,EXAMPLES.length);
});

function run(seed,level,entry,hunter){
  const map=generateMap(seed,level),runner=compile(entry.source),chaser=compile(hunter.hunterSource);
  let s=createState(map),memory=null;const actions=[];
  while(s.status==='running'){
    const move=runner(observation(map,s)),pursuit=(s.tick+1)%map.hunterEvery===0?chaser(observation(map,s,'hunter',memory)):{actions:[],memory};
    if(pursuit.actions.length)validateHunterResponse(s,pursuit);memory=pursuit.memory??null;
    actions.push([move.action,pursuit.actions]);s=step(map,s,move,pursuit);
  }
  return {state:s,score:score(map,s),actions};
}
test('complete baseline races replay identically with a randomly chosen AI hunter',()=>{
  for(const level of Object.keys(LEVELS))for(let i=0;i<3;i++){
    const seed='race-'+i,hunter=chooseHunter(EXAMPLES,seed);
    for(const entry of EXAMPLES){const a=run(seed,level,entry,hunter),b=run(seed,level,entry,hunter);assert.deepEqual(a,b);assert(a.state.tick<=LEVELS[level].maxTicks);assert(a.score.total>=0&&a.score.total<=10000)}
  }
});
