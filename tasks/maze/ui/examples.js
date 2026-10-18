// Baselines are demonstrations, never attributed to an AI model.
function decide(o){
  const moves=[['up',0,-1],['right',1,0],['down',0,1],['left',-1,0]];
  const key=p=>p.x+','+p.y;
  let target=o.key||o.exit;
  if(MODE==='collector'&&o.coins.length&&o.tick<o.maxTicks*.45){
    target=[...o.coins].sort((a,b)=>Math.abs(a.x-o.player.x)+Math.abs(a.y-o.player.y)-Math.abs(b.x-o.player.x)-Math.abs(b.y-o.player.y))[0];
  }
  const queue=[{x:o.player.x,y:o.player.y,cost:0,first:'wait'}],best=new Map([[key(o.player),0]]);
  while(queue.length){
    queue.sort((a,b)=>a.cost-b.cost);const p=queue.shift();
    if(p.cost!==best.get(key(p)))continue;
    if(p.x===target.x&&p.y===target.y){
      const m=moves.find(m=>m[0]===p.first);
      if(!m)return {action:'wait'};
      const x=o.player.x+m[1],y=o.player.y+m[2];
      const blocked=o.gates.some(g=>g.x===x&&g.y===y&&g.closed);
      const danger=MODE!=='rush'&&o.traps.some(t=>t.x===x&&t.y===y&&t.active)&&o.player.invulnerableUntil<=o.tick;
      return {action:blocked||danger?'wait':p.first};
    }
    for(const [action,dx,dy] of moves){
      const x=p.x+dx,y=p.y+dy;
      if(o.grid[y]?.[x]!==0)continue;
      let cost=p.cost+1;
      if(MODE!=='rush'){
        if(o.traps.some(t=>t.x===x&&t.y===y))cost+=3;
        if(o.hunters.some(h=>Math.abs(h.x-x)+Math.abs(h.y-y)<3))cost+=12;
      }
      const k=x+','+y;
      if(cost<(best.get(k)??Infinity)){best.set(k,cost);queue.push({x,y,cost,first:p.first==='wait'?action:p.first})}
    }
  }
  return {action:'wait'};
}
export const EXAMPLES=[
  {id:'demo-safe',name:'稳健寻路',color:'#4c8f80',mode:'safe',note:'避让机关与追逐者，优先拿钥匙逃生'},
  {id:'demo-rush',name:'最短路冲刺',color:'#6386b5',mode:'rush',note:'直接寻找最短路，接受受伤风险'},
  {id:'demo-loot',name:'晶片收集者',color:'#b78b4d',mode:'collector',note:'前半程收集晶片，再寻找出口'},
].map(e=>({...e,kind:'内置示例',source:`const MODE = ${JSON.stringify(e.mode)};\n${decide.toString()}\n`,hunterSource:`const MODE = ${JSON.stringify(e.mode)};\n${hunterDecide.toString().replace('hunterDecide','decide')}\n`,readme:e.note}));

function hunterDecide(o){
  const moves=[['up',0,-1],['right',1,0],['down',0,1],['left',-1,0]];
  const target=MODE==='collector'&&o.key?o.key:o.player;
  const key=p=>p.x+','+p.y,dist=new Map([[key(target),0]]),queue=[target];
  for(let i=0;i<queue.length;i++)for(const [,dx,dy] of moves){
    const p={x:queue[i].x+dx,y:queue[i].y+dy},k=key(p);
    if(o.grid[p.y]?.[p.x]===0&&!o.gates.some(g=>g.x===p.x&&g.y===p.y&&g.closed)&&!dist.has(k)){dist.set(k,dist.get(key(queue[i]))+1);queue.push(p)}
  }
  return {actions:o.hunters.map(h=>{
    const options=moves.map(([action,dx,dy])=>({action,x:h.x+dx,y:h.y+dy})).filter(p=>o.grid[p.y]?.[p.x]===0&&!o.gates.some(g=>g.x===p.x&&g.y===p.y&&g.closed));
    options.sort((a,b)=>(dist.get(key(a))??Infinity)-(dist.get(key(b))??Infinity));
    return {id:h.id,action:options.length&&(dist.get(key(options[0]))??Infinity)<(dist.get(key(h))??Infinity)?options[0].action:'wait'};
  })};
}
