const MODE = "safe";
function decide(o){
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
