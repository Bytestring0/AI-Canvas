const MODE = "safe";
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
