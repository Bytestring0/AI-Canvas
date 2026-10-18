/* maze-1 / coordinated interception. Only public observations are used. */
const ASTRA_H_ACTIONS=['up','right','down','left','wait'];
let astraHWorld=null;

function astraHGraph(o) {
  const tag=o.seed+':'+o.width+':'+o.height;
  if(astraHWorld&&astraHWorld.tag===tag)return astraHWorld;
  const n=o.width*o.height,w=o.width,next=Array.from({length:n},()=>[]),gates=new Array(n),traps=new Array(n);
  for(let y=0;y<o.height;y++)for(let x=0;x<w;x++)if(o.grid[y][x]===0) {
    const p=y*w+x;
    for(const [a,dx,dy] of [[0,0,-1],[1,1,0],[2,0,1],[3,-1,0]])if(o.grid[y+dy]?.[x+dx]===0)next[p].push([p+dy*w+dx,a]);
    next[p].push([p,4]);
  }
  for(const g of o.gates)gates[g.y*w+g.x]=g;
  for(const t of o.traps)traps[t.y*w+t.x]=t;
  astraHWorld={tag,n,w,next,gates,traps,rows:new Map()};return astraHWorld;
}
function astraHDist(g,origin) {
  if(g.rows.has(origin))return g.rows.get(origin);
  const d=new Int16Array(g.n);d.fill(30000);d[origin]=0;
  const queue=new Int32Array(g.n);queue[0]=origin;let tail=1;
  for(let i=0;i<tail;i++)for(const [q] of g.next[queue[i]])if(d[q]===30000){d[q]=d[queue[i]]+1;queue[tail++]=q;}
  g.rows.set(origin,d);return d;
}
function astraHOn(f,t){return f&&(t+f.phase)%f.period<f.on;}
function astraHLegal(g,p,q,t){return p===q||!astraHOn(g.gates[q],t);}

function astraHPath(g,o,target,horizon) {
  let p=o.player.y*g.w+o.player.x,previous=-1,key=o.key?o.key.y*g.w+o.key.x:-1,hasKey=o.player.hasKey;
  const exit=o.exit.y*g.w+o.exit.x,path=[p];
  for(let k=0;k<horizon;k++) {
    if(p===key){hasKey=true;target=exit;}
    if(p===target&&target!==exit)target=hasKey?exit:key;
    const d=astraHDist(g,target),t=o.tick+k;
    let q=p,cost=d[p]+0.6;
    for(const [r,a] of g.next[p])if(a!==4&&astraHLegal(g,p,r,t)) {
      const v=d[r]+(astraHOn(g.traps[r],t)?2.3:0)+(r===previous?0.25:0);
      if(v<cost){q=r;cost=v;}
    }
    previous=p;p=q;path.push(p);
  }
  return path;
}

// First-action distances to a target with gates evaluated on actual hunter movement turns.
function astraHRoute(g,o,start,target) {
  const actions=g.next[start].filter(([q])=>astraHLegal(g,start,q,o.tick));
  const d=astraHDist(g,target),limit=Math.min(32,Math.max(8,d[start]+6));
  let layer=actions.map(([p,a])=>({p,a}));
  const seen=new Set(),scores=new Map(actions.map(([,a])=>[a,30000]));
  for(let k=0;k<limit&&layer.length;k++) {
    const next=[];
    for(const node of layer) {
      const key=(k*g.n+node.p)*5+node.a;
      if(seen.has(key))continue;seen.add(key);
      if(node.p===target){scores.set(node.a,Math.min(scores.get(node.a),k));continue;}
      // Keep this bounded even when a distant target cannot be reached within the forecast.
      if(k===limit-1){scores.set(node.a,Math.min(scores.get(node.a),k+d[node.p]));continue;}
      const t=o.tick+(k+1)*o.hunterEvery;
      for(const [q] of g.next[node.p])if(astraHLegal(g,node.p,q,t)&&d[q]<=d[start]+3)next.push({p:q,a:node.a});
    }
    layer=next;
  }
  return scores;
}

function decide(o) {
  const g=astraHGraph(o),player=o.player.y*g.w+o.player.x,exit=o.exit.y*g.w+o.exit.x;
  const goal=o.key?o.key.y*g.w+o.key.x:exit,goalD=astraHDist(g,goal),playerD=astraHDist(g,player);
  const old=o.memory&&o.memory.version===1?o.memory:{};
  const paths=[{weight:1,path:astraHPath(g,o,goal,42)}];
  // One alternate forecast allows for a nearby coin detour.
  let coin=-1,coinValue=Infinity;
  for(const c of o.coins){const p=c.y*g.w+c.x,v=playerD[p]+goalD[p]-goalD[player];if(playerD[p]<=12&&v<=6&&v<coinValue){coin=p;coinValue=v;}}
  if(coin>=0)paths.push({weight:0.48,path:astraHPath(g,o,coin,30)});

  const options=o.hunters.map(h=>{
    const start=h.y*g.w+h.x,d=astraHDist(g,start),targets=new Map();
    for(const forecast of paths)for(let t=1;t<forecast.path.length;t++) {
      const p=forecast.path[t];if(p===exit)continue; // Standing on the exit cannot stop a successful escape.
      const arrival=d[p]===0?0:1+(d[p]-1)*o.hunterEvery;
      const late=Math.max(0,arrival-t),early=Math.max(0,t-arrival);
      let score=forecast.weight*(85-1.25*t-0.7*d[p]-late*7-Math.min(early,12)*0.4);
      if(p===goal)score+=5;
      if(old.targets?.[h.id]===p)score+=2;
      if(score>(targets.get(p)??-Infinity))targets.set(p,score);
    }
    // Always keep a direct pursuit option for unexpected retreating players.
    targets.set(player,Math.max(targets.get(player)??-Infinity,20-d[player]*0.7));
    return {h,start,targets:[...targets].sort((a,b)=>b[1]-a[1]).slice(0,9)};
  });
  let assignment=[],bestAssignment=-Infinity;
  function assign(i,picks,value) {
    if(i===options.length){if(value>bestAssignment){bestAssignment=value;assignment=picks.slice();}return;}
    for(const [target,score] of options[i].targets) {
      let penalty=0;
      for(const previous of picks){const gap=astraHDist(g,target)[previous];penalty+=gap===0?34:gap===1?12:gap===2?4:0;}
      picks.push(target);assign(i+1,picks,value+score-penalty);picks.pop();
    }
  }
  assign(0,[],0);

  const candidates=options.map((option,i)=>{
    const target=assignment[i]??player,route=astraHRoute(g,o,option.start,target),d=astraHDist(g,target);
    return g.next[option.start].filter(([q])=>astraHLegal(g,option.start,q,o.tick)).map(([p,a])=>({p,a,value:-2.2*route.get(a)-0.2*d[p]}));
  });
  const runnerMoves=g.next[player].filter(([q])=>astraHLegal(g,player,q,o.tick));
  const moveWeights=runnerMoves.map(([p,a])=>{
    let cost=goalD[p]-goalD[player]+(a===4?0.5:0)+(astraHOn(g.traps[p],o.tick)?1.8:0);
    if(old.player===p&&p!==player)cost+=0.5;
    return Math.exp(-1.3*cost);
  });
  const totalWeight=moveWeights.reduce((a,b)=>a+b,0);
  let best=-Infinity,chosen=[];
  function joint(i,moves,value) {
    if(i<candidates.length){for(const move of candidates[i]){moves.push(move);joint(i+1,moves,value+move.value);moves.pop();}return;}
    const occupied=new Set(moves.map(m=>m.p));
    let contact=0,escapeQuality=Infinity;
    for(let j=0;j<runnerMoves.length;j++) {
      const p=runnerMoves[j][0],safeExit=o.player.hasKey&&p===exit;
      const hit=occupied.has(p)&&!safeExit&&o.tick>=o.player.invulnerableUntil;
      if(hit)contact+=moveWeights[j]/totalWeight;
      const nearest=Math.min(...moves.map(m=>astraHDist(g,m.p)[p]));
      const quality=(hit?45:0)-nearest*0.8-(goalD[player]-goalD[p])*2;
      escapeQuality=Math.min(escapeQuality,quality);
    }
    const overlap=moves.length-occupied.size;
    const score=value+contact*42+escapeQuality*0.65-overlap*6;
    if(score>best){best=score;chosen=moves.slice();}
  }
  joint(0,[],0);
  return {actions:o.hunters.map((h,i)=>({id:h.id,action:ASTRA_H_ACTIONS[chosen[i]?.a??4]})),
    memory:{version:1,player,targets:Object.fromEntries(o.hunters.map((h,i)=>[h.id,assignment[i]??player]))}};
}
