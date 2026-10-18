// Extra opponents enter the hunter lottery without adding a runner to the leaderboard.
export const BUILTIN_HUNTERS=[{
  id:'builtin-my-own',
  name:'我自己写的',
  note:'一人守出口；两人各守钥匙和出口；三人两守钥匙一守出口。取钥匙后全员沿出口通向玩家的通道排开。',
  hunterSource:guardHunter.toString().replace('function guardHunter(', 'function decide('),
}];

export function hunterCandidates(entries){return [...entries,...BUILTIN_HUNTERS]}

function guardHunter(o){
  const w=o.width,n=w*o.height,at=p=>p.y*w+p.x,point=p=>({x:p%w,y:Math.floor(p/w)});
  const names=['up','right','down','left','wait'],neighbors=Array.from({length:n},()=>[]),gates=new Map();
  for(let y=0;y<o.height;y++)for(let x=0;x<w;x++)if(o.grid[y][x]===0){
    const p=y*w+x;
    for(const [dx,dy,a] of [[0,-1,0],[1,0,1],[0,1,2],[-1,0,3]])if(o.grid[y+dy]?.[x+dx]===0)neighbors[p].push({p:p+dy*w+dx,a});
    neighbors[p].push({p,a:4});
  }
  for(const gate of o.gates)gates.set(at(gate),gate);
  const legal=(p,q,t)=>{const gate=gates.get(q);return p===q||!gate||(t+gate.phase)%gate.period>=gate.on};
  const rows=new Map();
  function distances(origin){
    if(rows.has(origin))return rows.get(origin);
    const d=new Int16Array(n);d.fill(30000);d[origin]=0;
    const queue=[origin];
    for(let i=0;i<queue.length;i++)for(const next of neighbors[queue[i]])if(d[next.p]===30000){d[next.p]=d[queue[i]]+1;queue.push(next.p)}
    rows.set(origin,d);return d;
  }
  const player=at(o.player),exit=at(o.exit),taken=o.player.hasKey||!o.key;
  const old=o.memory?.version===1?o.memory:{};
  const memory={version:1,phase:taken?'exit':'guard',roles:{...old.roles},patrol:{...old.patrol},targets:{}};
  const hunters=[...o.hunters].sort((a,b)=>a.id-b.id);

  if(!taken&&hunters.some(h=>!memory.roles[h.id])){
    const d=distances(exit);
    const exitGuard=[...hunters].sort((a,b)=>d[at(a)]-d[at(b)]||a.id-b.id)[0];
    for(const h of hunters)memory.roles[h.id]=h.id===exitGuard.id?'exit':'key';
  }
  if(taken)for(const h of hunters)memory.roles[h.id]='exit';

  // Follow the actual maze corridor toward the player, rather than a straight line through walls.
  function approach(anchor,length){
    const toPlayer=distances(player),fromAnchor=distances(anchor),line=[anchor],seen=new Set(line);
    while(line.length<length){
      const p=line.at(-1);
      const next=neighbors[p].filter(q=>q.a!==4&&!seen.has(q.p));
      next.sort((a,b)=>toPlayer[a.p]-toPlayer[b.p]||fromAnchor[b.p]-fromAnchor[a.p]||a.a-b.a);
      if(!next.length)break;
      line.push(next[0].p);seen.add(next[0].p);
    }
    if(line.length<length){
      const queue=[anchor],visited=new Set(queue);
      for(let i=0;i<queue.length&&line.length<length;i++)for(const q of neighbors[queue[i]])if(!visited.has(q.p)){
        visited.add(q.p);queue.push(q.p);
        if(!seen.has(q.p)&&line.length<length){line.push(q.p);seen.add(q.p)}
      }
    }
    return line;
  }
  const targets=new Map();
  for(const role of taken?['exit']:['key','exit']){
    const group=hunters.filter(h=>memory.roles[h.id]===role);if(!group.length)continue;
    const anchor=role==='exit'?exit:at(o.key),line=approach(anchor,group.length*3+3);
    // Exit itself cannot injure an escaping player: put guards on the approach cells.
    // Three-cell spacing also prevents all guards being crossed during one immunity window.
    const slots=group.map((_,i)=>line[Math.min(line.length-1,(role==='exit'?1:0)+3*i)]);
    let assignment=[],best=Infinity;
    function match(i,used,picks,cost){
      if(i===group.length){if(cost<best){best=cost;assignment=picks.slice()}return}
      for(let j=0;j<slots.length;j++)if(!used.has(j)){
        const h=group[i],previous=old.targets?.[h.id],stable=previous&&at(previous)===slots[j]?-0.25:0;
        used.add(j);picks.push(j);match(i+1,used,picks,cost+distances(slots[j])[at(h)]+stable);picks.pop();used.delete(j);
      }
    }
    match(0,new Set(),[],0);
    for(let i=0;i<group.length;i++){
      const h=group[i],slot=assignment[i],index=(role==='exit'?1:0)+3*slot;
      let target=slots[slot];
      if(!taken){
        let phase=memory.patrol[h.id]===1?1:0;
        target=line[Math.min(line.length-1,index+phase)];
        if(at(h)===target){phase=1-phase;target=line[Math.min(line.length-1,index+phase)]}
        memory.patrol[h.id]=phase;
      }
      targets.set(h.id,target);memory.targets[h.id]=point(target);
    }
  }

  // Time-expanded A*: a blocked periodic gate is a reason to wait, not abandon the guard post.
  function route(start,target){
    if(start===target)return 4;
    const d=distances(target),limit=Math.min(192,Math.max(12,d[start]+18)),heap=[],best=new Map();
    function push(node){let i=heap.length;heap.push(node);while(i>0){const parent=(i-1)>>1;if(heap[parent].f<=node.f)break;heap[i]=heap[parent];i=parent}heap[i]=node}
    function pop(){const top=heap[0],last=heap.pop();if(!heap.length)return top;let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].f<heap[child].f)child++;if(heap[child].f>=last.f)break;heap[i]=heap[child];i=child}heap[i]=last;return top}
    push({p:start,k:0,a:4,f:d[start]});best.set(start,0);
    let fallback=4,value=Infinity,expanded=0;
    while(heap.length&&expanded++<12000){
      const node=pop();
      if(node.k>0){
        if(node.p===target)return node.a;
        const v=d[node.p]+node.k*1.01;if(v<value){value=v;fallback=node.a}
      }
      if(node.k>=limit)continue;
      const tick=o.tick+node.k*o.hunterEvery;
      for(const next of neighbors[node.p])if(legal(node.p,next.p,tick)){
        const k=node.k+1,id=k*n+next.p;
        if(best.has(id))continue;best.set(id,k);
        push({p:next.p,k,a:node.k===0?next.a:node.a,f:k+d[next.p]});
      }
    }
    return fallback;
  }
  const choices=hunters.map(h=>{
    const p=at(h),target=targets.get(h.id),preferred=route(p,target),d=distances(target);
    return neighbors[p].filter(next=>legal(p,next.p,o.tick)).map(next=>({...next,
      value:d[next.p]+(next.a===preferred?0:4)+(next.p===target?-1:0)}));
  });
  let chosen=[],best=Infinity;
  function arrange(i,moves,cost){
    if(i===hunters.length){if(cost<best){best=cost;chosen=moves.slice()}return}
    for(const move of choices[i]){
      // Temporary overlap is legal: do not trap a guard behind a teammate holding a corridor post.
      const overlap=moves.some(previous=>previous.p===move.p)?2:0;
      moves.push(move);arrange(i+1,moves,cost+move.value+overlap);moves.pop();
    }
  }
  arrange(0,[],0);
  return {actions:hunters.map((h,i)=>({id:h.id,action:names[chosen[i]?.a??4]})),memory};
}
