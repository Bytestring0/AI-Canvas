// Pure deterministic simulation. Rendering speed and strategy execution time never enter the rules.
export const RULES_VERSION = 'maze-1';
export const LEVELS = {
  scout: {name:'探索',width:21,height:15,maxTicks:360,hunters:1,hunterEvery:3,traps:6,gates:4,coins:8},
  standard: {name:'挑战',width:29,height:21,maxTicks:560,hunters:2,hunterEvery:3,traps:12,gates:8,coins:12},
  expert: {name:'极限',width:35,height:25,maxTicks:800,hunters:3,hunterEvery:2,traps:20,gates:12,coins:16},
};
export const DIRECTIONS = {up:[0,-1],right:[1,0],down:[0,1],left:[-1,0],wait:[0,0]};
export const posKey = p => `${p.x},${p.y}`;
export const same = (a,b) => a.x===b.x&&a.y===b.y;
export function seeded(seed) {
  let h=2166136261;
  for(const c of String(seed))h=Math.imul(h^c.charCodeAt(0),16777619);
  return ()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296};
}
function shuffle(a,rng){for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
export function distances(map, origin, tick=null) {
  const out=new Map([[posKey(origin),0]]),queue=[origin];
  for(let i=0;i<queue.length;i++)for(const [dx,dy] of Object.values(DIRECTIONS).slice(0,4)){
    const p={x:queue[i].x+dx,y:queue[i].y+dy},k=posKey(p);
    if(!out.has(k)&&passable(map,p,tick)){out.set(k,out.get(posKey(queue[i]))+1);queue.push(p)}
  }
  return out;
}
export function active(item,tick){return (tick+item.phase)%item.period<item.on}
export function passable(map,p,tick=null){
  if(map.grid[p.y]?.[p.x]!==0)return false;
  return tick===null||!map.gates.some(g=>same(g,p)&&active(g,tick));
}
export function generateMap(seed='canvas',level='standard') {
  if(!LEVELS[level])throw Error('未知难度');
  const rules=LEVELS[level],rng=seeded(`${RULES_VERSION}:${seed}:${level}`),{width,height}=rules;
  const grid=Array.from({length:height},()=>Array(width).fill(1)),stack=[{x:1,y:1}];grid[1][1]=0;
  while(stack.length){
    const p=stack.at(-1),next=shuffle([[0,-2],[2,0],[0,2],[-2,0]],rng).map(([dx,dy])=>({x:p.x+dx,y:p.y+dy})).find(n=>n.x>0&&n.y>0&&n.x<width-1&&n.y<height-1&&grid[n.y][n.x]===1);
    if(!next){stack.pop();continue}
    grid[(p.y+next.y)/2][(p.x+next.x)/2]=0;grid[next.y][next.x]=0;stack.push(next);
  }
  // Sparse extra corridors provide routes around hazards while retaining maze structure.
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++)if(grid[y][x]===1&&rng()<.10&&((grid[y-1][x]===0&&grid[y+1][x]===0)||(grid[y][x-1]===0&&grid[y][x+1]===0)))grid[y][x]=0;
  const map={version:RULES_VERSION,seed:String(seed),level,...rules,grid,start:{x:1,y:1},gates:[],traps:[],coins:[],hunters:[]};
  const dist=distances(map,map.start),floor=[...dist.keys()].map(k=>{const [x,y]=k.split(',').map(Number);return {x,y}}).sort((a,b)=>dist.get(posKey(b))-dist.get(posKey(a)));
  map.exit={...floor[0]};
  const fromExit=distances(map,map.exit);
  // Key is separated from both ends, and all cells remain connected ignoring timed gates.
  const keyOptions=floor.filter(p=>dist.get(posKey(p))>dist.get(posKey(map.exit))*.35&&fromExit.get(posKey(p))>10);
  map.key={...(keyOptions[Math.floor(rng()*keyOptions.length)]||floor[Math.floor(floor.length/2)])};
  const reserved=new Set([map.start,map.exit,map.key].map(posKey));
  const candidates=shuffle(floor.filter(p=>!reserved.has(posKey(p))&&dist.get(posKey(p))>8),rng);
  const take=()=>candidates.pop();
  for(let i=0;i<rules.hunters;i++){
    const idx=candidates.findIndex(p=>dist.get(posKey(p))>Math.max(14,dist.get(posKey(map.exit))*.45));
    const p=idx<0?take():candidates.splice(idx,1)[0];map.hunters.push({...p,id:i});
  }
  for(let i=0;i<rules.gates;i++)map.gates.push({...take(),period:6+Math.floor(rng()*3),on:2,phase:Math.floor(rng()*6)});
  for(let i=0;i<rules.traps;i++)map.traps.push({...take(),period:4+Math.floor(rng()*3),on:2,phase:Math.floor(rng()*4)});
  for(let i=0;i<rules.coins;i++)map.coins.push(take());
  map.floorCount=floor.length;
  return map;
}
export function createState(map){
  return {tick:0,player:{...map.start},hp:3,key:false,coins:[],visited:[posKey(map.start)],hunters:map.hunters.map(h=>({...h})),invulnerableUntil:0,status:'running',finishTick:null,events:['等待出发'],action:'wait',memory:null,error:null};
}
export function observation(map,state,role='runner',memory=state.memory){
  return {version:RULES_VERSION,role,seed:map.seed,tick:state.tick,maxTicks:map.maxTicks,width:map.width,height:map.height,grid:map.grid,
    start:map.start,exit:map.exit,key:state.key?null:map.key,player:{...state.player,hp:state.hp,hasKey:state.key,invulnerableUntil:state.invulnerableUntil},
    coins:map.coins.filter(p=>!state.coins.includes(posKey(p))),
    gates:map.gates.map(g=>({...g,closed:active(g,state.tick)})),traps:map.traps.map(t=>({...t,active:active(t,state.tick)})),
    hunters:state.hunters.map(h=>({...h})),hunterEvery:map.hunterEvery,visited:state.visited,memory};
}
export function validateHunterResponse(state,response){
  if(!response||!Array.isArray(response.actions)||response.actions.length!==state.hunters.length)throw Error('追逐策略必须为每个追逐者返回一项 actions');
  const ids=new Set();
  for(const item of response.actions){
    if(!item||!state.hunters.some(h=>h.id===item.id)||ids.has(item.id)||!Object.hasOwn(DIRECTIONS,item.action))throw Error('追逐者 id 或 action 无效/重复');
    ids.add(item.id);
  }
  return response;
}
export function chooseHunter(entries,seed){return entries[Math.floor(seeded(`${RULES_VERSION}:${seed}:hunter`)()*entries.length)]}
export function step(map,previous,response={action:'wait'},pursuit={actions:[]}) {
  if(previous.status!=='running')return previous;
  const s=structuredClone(previous);s.events=[];
  s.action=response.action;s.memory=response.memory??null;
  const [dx,dy]=DIRECTIONS[s.action]||[0,0],next={x:s.player.x+dx,y:s.player.y+dy};
  if(passable(map,next,s.tick)){s.player=next}else s.events.push('前方墙体或闸门关闭');
  const at=posKey(s.player);if(!s.visited.includes(at))s.visited.push(at);
  if(!s.key&&same(s.player,map.key)){s.key=true;s.events.push('取得出口钥匙')}
  if(map.coins.some(p=>same(p,s.player))&&!s.coins.includes(at)){s.coins.push(at);s.events.push('收集能量晶片')}
  // A safe exit is resolved before hazards and pursuit.
  if(s.key&&same(s.player,map.exit)){s.status='escaped';s.finishTick=s.tick+1;s.events.push('成功逃离')}
  if(s.status==='running'){
    if((s.tick+1)%map.hunterEvery===0){
      s.hunters=s.hunters.map(h=>{
        const action=pursuit.actions.find(a=>a.id===h.id)?.action||'wait';
        const [dx,dy]=DIRECTIONS[action]||[0,0],p={x:h.x+dx,y:h.y+dy};
        return passable(map,p,s.tick)?{...h,...p}:h;
      });
    }
    const trap=map.traps.some(t=>same(t,s.player)&&active(t,s.tick)),caught=s.hunters.some(h=>same(h,s.player));
    if((trap||caught)&&s.tick>=s.invulnerableUntil){s.hp--;s.invulnerableUntil=s.tick+3;s.events.push(caught?'被追逐者击中 · 生命 -1':'触发机关 · 生命 -1')}
    if(s.hp<=0){s.status='dead';s.finishTick=s.tick+1;s.events.push('生命耗尽')}
  }
  s.tick++;
  if(s.status==='running'&&s.tick>=map.maxTicks){s.status='timeout';s.finishTick=s.tick;s.events.push('达到回合上限')}
  return s;
}
export function failState(state,message){return {...structuredClone(state),status:'error',error:String(message).slice(0,300),finishTick:state.tick,events:['策略错误：'+String(message).slice(0,300)]}}
export function score(map,s,mode='runners'){
  const escaped=s.status==='escaped';
  const parts=mode==='hunters'?{
    capture:s.status==='dead'?6000:s.status==='timeout'?4000:0,
    speed:s.status==='dead'?Math.floor(2000*(1-s.finishTick/map.maxTicks)):0,
    damage:Math.floor(1000*(3-s.hp)/3),denial:Math.floor(1000*(1-s.visited.length/map.floorCount)),
  }:{escape:escaped?6000:0,speed:escaped?Math.floor(2000*(1-s.finishTick/map.maxTicks)):0,
    loot:Math.floor(1000*s.coins.length/map.coins.length),explore:Math.floor(500*s.visited.length/map.floorCount),health:Math.floor(500*s.hp/3)};
  if(s.status==='error')for(const k in parts)parts[k]=0;
  return {total:Object.values(parts).reduce((a,b)=>a+b,0),...parts};
}
export function rank(map,entries,mode='runners'){
  return [...entries].sort((a,b)=>{
    const diff=score(map,b.state,mode).total-score(map,a.state,mode).total;
    if(diff)return diff;
    const aTick=a.state.finishTick??Infinity,bTick=b.state.finishTick??Infinity;
    if(mode==='hunters')return (a.state.status==='dead'&&b.state.status==='dead'?aTick-bTick:bTick-aTick)||a.state.hp-b.state.hp||a.id.localeCompare(b.id);
    return aTick-bTick||b.state.hp-a.state.hp||a.id.localeCompare(b.id);
  });
}
