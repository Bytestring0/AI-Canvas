/* maze-1 / GPT-6 Astra entry. Deterministic, standalone, no imports. */
const ASTRA_ACTIONS = ['up', 'right', 'down', 'left', 'wait'];
let astraWorld = null;

function astraGraph(o) {
  const tag = o.seed + ':' + o.width + ':' + o.height;
  if (astraWorld && astraWorld.tag === tag && o.tick !== 0) return astraWorld;
  const n = o.width * o.height, w = o.width;
  const next = Array.from({length:n}, () => []), gate = new Array(n), trap = new Array(n);
  for (let y=0;y<o.height;y++) for (let x=0;x<w;x++) if (o.grid[y][x]===0) {
    const p=y*w+x;
    for (const [a,dx,dy] of [[0,0,-1],[1,1,0],[2,0,1],[3,-1,0]]) {
      if (o.grid[y+dy]?.[x+dx]===0) next[p].push([p+dy*w+dx,a]);
    }
    next[p].push([p,4]);
  }
  for (const g of o.gates) gate[g.y*w+g.x]=g;
  for (const t of o.traps) trap[t.y*w+t.x]=t;
  astraWorld={tag,n,w,next,gate,trap,rows:new Map()};
  return astraWorld;
}

function astraDistances(g, origin) {
  if (g.rows.has(origin)) return g.rows.get(origin);
  const d=new Int16Array(g.n);d.fill(30000);d[origin]=0;
  const queue=new Int32Array(g.n);queue[0]=origin;let tail=1;
  for (let head=0;head<tail;head++) {
    const p=queue[head];
    for (const [q] of g.next[p]) if (d[q]===30000) {d[q]=d[p]+1;queue[tail++]=q;}
  }
  g.rows.set(origin,d);return d;
}

function astraOn(feature,t) {return feature && (t+feature.phase)%feature.period<feature.on;}
function astraLegal(g,p,q,t) {return p===q || !astraOn(g.gate[q],t);}
function astraPush(heap,node) {
  let i=heap.length;heap.push(node);
  while(i>0) {const parent=(i-1)>>1;if(heap[parent].f<=node.f)break;heap[i]=heap[parent];i=parent;}
  heap[i]=node;
}
function astraPop(heap) {
  const root=heap[0],last=heap.pop();if(!heap.length)return root;
  let i=0;
  while(i*2+1<heap.length) {
    let c=i*2+1;if(c+1<heap.length&&heap[c+1].f<heap[c].f)c++;
    if(heap[c].f>=last.f)break;heap[i]=heap[c];i=c;
  }
  heap[i]=last;return root;
}

// A nominal trajectory supplies a pursuit forecast, not knowledge of the opponent's code.
function astraNominal(g,o,target,horizon) {
  const d=astraDistances(g,target),path=[o.player.y*g.w+o.player.x];
  for(let k=0;k<horizon;k++) {
    const p=path.at(-1),t=o.tick+k;
    if(p===target){path.push(p);continue;}
    let best=p,value=d[p]+0.85;
    for(const [q,a] of g.next[p]) if(a!==4&&astraLegal(g,p,q,t)) {
      const v=d[q]+(astraOn(g.trap[q],t)?2.4:0);
      if(v<value){best=q;value=v;}
    }
    path.push(best);
  }
  return path;
}

function astraForecast(g,o,target,horizon,stills) {
  const path=astraNominal(g,o,target,horizon),positions=o.hunters.map(h=>h.y*g.w+h.x);
  const guard=positions.slice(),forecast=[];
  for(let k=0;k<horizon;k++) {
    const t=o.tick+k;
    if((t+1)%o.hunterEvery===0) {
      const d=astraDistances(g,path[k]);
      for(let i=0;i<positions.length;i++) {
        // A hunter that has held position across several movement turns may be guarding a choke point.
        if((stills[o.hunters[i].id]||0)>=2)continue;
        const p=positions[i];let best=p;
        for(const [q] of g.next[p]) if(astraLegal(g,p,q,t)&&d[q]<d[best])best=q;
        positions[i]=best;
      }
    }
    forecast.push(positions.slice());
  }
  return {forecast,guard};
}

function astraTarget(g,o,m,p) {
  const objective=o.key?o.key.y*g.w+o.key.x:o.exit.y*g.w+o.exit.x;
  const goalD=astraDistances(g,objective),from=astraDistances(g,p),coinSet=new Set(o.coins.map(c=>c.y*g.w+c.x));
  const remaining=o.maxTicks-o.tick,exit=o.exit.y*g.w+o.exit.x;
  const afterKey=o.key?astraDistances(g,exit)[objective]:0;
  const direct=goalD[p]+afterKey;
  const hunterRows=o.hunters.map(h=>astraDistances(g,h.y*g.w+h.x));
  let target=objective,best=0;
  // A coin is optional: accept only short, profitable and comfortably reachable detours.
  if(o.player.hp>=2&&remaining>direct+35) {
    for(const c of coinSet) {
      const extra=from[c]+goalD[c]-goalD[p];
      if(from[c]>24||extra>(o.key?4:12)||from[c]+goalD[c]+afterKey+30>=remaining)continue;
      const margin=Math.min(...hunterRows.map(d=>d[c]*o.hunterEvery))-from[c];
      if(margin<8)continue;
      let value=1000/m.totalCoins-extra*2000/o.maxTicks-1.4*from[c];
      if(c===m.target)value+=8;
      if(value>best&&m.stuck<5){target=c;best=value;}
    }
  }
  return target;
}

function decide(o) {
  const g=astraGraph(o),p=o.player.y*g.w+o.player.x,exit=o.exit.y*g.w+o.exit.x;
  const old=o.memory&&o.memory.version===1?o.memory:{};
  const m={version:1,totalCoins:old.totalCoins||Math.max(1,o.coins.length),recent:(old.recent||[]).slice(-15),
    target:old.target,stuck:old.stuck||0,hunters:{},stills:{...old.stills}};
  for(const h of o.hunters) {
    const q=h.y*g.w+h.x;m.hunters[h.id]=q;
    if(o.tick>0&&o.tick%o.hunterEvery===0)m.stills[h.id]=old.hunters?.[h.id]===q?(m.stills[h.id]||0)+1:0;
  }
  let target=astraTarget(g,o,m,p),d=astraDistances(g,target);
  if(target===old.target&&d[p]>=old.distance)m.stuck++;
  else m.stuck=0;
  if(m.stuck>8&&target!==(o.key?o.key.y*g.w+o.key.x:exit)) {
    target=o.key?o.key.y*g.w+o.key.x:exit;d=astraDistances(g,target);m.stuck=0;
  }
  m.target=target;m.distance=d[p];m.recent.push(p);
  const finish=action=>({action:ASTRA_ACTIONS[action],memory:m});
  for(const [q,a] of g.next[p])if(o.player.hasKey&&q===exit&&astraLegal(g,p,q,o.tick))return finish(a);

  const horizon=Math.min(o.maxTicks-o.tick,Math.min(192,Math.max(42,d[p]+24)));
  if(horizon<=0)return finish(4);
  const {forecast,guard}=astraForecast(g,o,target,horizon,m.stills);
  const immediate=new Set();
  for(const h of o.hunters) {
    const q=h.y*g.w+h.x;immediate.add(q);
    if((o.tick+1)%o.hunterEvery===0)for(const [r] of g.next[q])if(astraLegal(g,q,r,o.tick))immediate.add(r);
  }
  const recent=new Map();for(const q of m.recent)recent.set(q,(recent.get(q)||0)+1);
  const encode=(q,t,hp,cd)=>((t*g.n+q)*12+hp*3+cd);
  const cd=Math.max(0,Math.min(2,o.player.invulnerableUntil-o.tick));
  const root={p,t:0,hp:o.player.hp,cd,g:0,f:d[p],first:4};
  const heap=[],best=new Map([[encode(p,0,root.hp,cd),0]]);astraPush(heap,root);
  let fallback=null,fallbackValue=Infinity,expanded=0;
  while(heap.length&&expanded++<11000) {
    const node=astraPop(heap),id=encode(node.p,node.t,node.hp,node.cd);
    if(node.g>best.get(id)+1e-7)continue;
    if(node.t>0) {
      const v=d[node.p]+node.g+0.025*node.t;
      if(v<fallbackValue){fallback=node;fallbackValue=v;}
      if(node.p===target)return finish(node.first);
    }
    if(node.t>=horizon)continue;
    const t=o.tick+node.t,enemy=forecast[node.t];
    for(const [q,action] of g.next[node.p]) {
      if(!astraLegal(g,node.p,q,t))continue;
      const escaped=o.player.hasKey&&q===exit;
      const contact=node.t===0?immediate.has(q):enemy.includes(q);
      const damage=!escaped&&node.cd===0&&(astraOn(g.trap[q],t)||contact)?1:0;
      const hp=node.hp-damage;if(hp<=0)continue;
      const nextCD=damage?2:Math.max(0,node.cd-1);
      let risk=0;
      if(!escaped&&node.cd===0) {
        for(let i=0;i<enemy.length;i++) {
          const range=astraDistances(g,enemy[i])[q];
          if(range===1)risk+=0.8;
          // Do not assume a stationary opponent will vacate an occupied square.
          if(node.t>0&&q===guard[i]&&q!==enemy[i])risk+=3.5;
        }
      }
      const repeat=node.t<5?(recent.get(q)||0)*0.16:0;
      const waiting=action===4?0.15+Math.min(m.stuck,12)*0.3:0;
      const cost=node.g+1+damage*(node.hp===3?38:65)+risk+repeat+waiting;
      const key=encode(q,node.t+1,hp,nextCD);
      if(cost>=(best.get(key)??Infinity)-1e-7)continue;
      best.set(key,cost);
      astraPush(heap,{p:q,t:node.t+1,hp,cd:nextCD,g:cost,f:cost+d[q]*1.08,first:node.t===0?action:node.first});
    }
  }
  if(fallback)return finish(fallback.first);
  // If all modeled plans are fatal, take the least damaging legal action rather than throw.
  let action=4,value=Infinity;
  for(const [q,a] of g.next[p])if(astraLegal(g,p,q,o.tick)) {
    const v=(cd===0&&(immediate.has(q)||astraOn(g.trap[q],o.tick))?10000:0)+d[q]+(recent.get(q)||0)*0.5;
    if(v<value){value=v;action=a;}
  }
  return finish(action);
}
