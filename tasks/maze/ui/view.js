import {esc,download} from '../../ui.js';
import {LEVELS,RULES_VERSION,generateMap,createState,observation,step,failState,score,rank,chooseHunter,validateHunterResponse,active,same} from './engine.js';
import {StrategySandbox} from './sandbox.js';
import {EXAMPLES} from './examples.js';
import {hunterCandidates} from './hunters.js';

const STATUS={running:'探索中',escaped:'成功逃离',dead:'生命耗尽',timeout:'回合耗尽',error:'策略错误'};
const COLORS=['#4c8f80','#6386b5','#b78b4d','#a17caa','#b86669','#6b9cad'];
const STORAGE='ai-canvas-maze-entries-v1';
const readLocal=()=>{try{return JSON.parse(localStorage.getItem(STORAGE)||'[]').filter(e=>e&&typeof e.id==='string'&&typeof e.name==='string'&&typeof e.source==='string'&&typeof e.hunterSource==='string'&&typeof e.readme==='string'&&e.source.length<=100000&&e.hunterSource.length<=100000).slice(0,12).map(e=>({...e,kind:'本地导入',color:/^#[0-9a-f]{6}$/i.test(e.color)?e.color:COLORS[0]}))}catch{return []}};

export function mountGallery(root,ctx){return arena(root,ctx)}
export function mount(root,ctx){return arena(root,ctx,ctx.model.id)}

function arena(root,{task,models,submissions,openDoc},initialFocus=null){
  const official=submissions.map(s=>{
    const m=models.find(m=>m.id===s.model),r=s.revisions.at(-1);
    return {id:m.id,name:m.name,color:m.color,kind:s.model_version,source:r.source,hunterSource:task.payload.hunter_sources[m.id][r.id],readme:r.readme,revision:r.id};
  });
  let local=readLocal(),useDemos=!official.length,entries=[],hunterPool=[],map,chosen,round=0,tick=0,cursor=0,phase='ready',speed=4,focus=initialFocus;
  let alive=true,epoch=0,inFlight=false,timer=null,invalid='',notice='',seed=new URLSearchParams(location.search).get('mazeSeed')||'CANVAS-042',level='standard';
  const $=s=>root.querySelector(s);
  function candidates(){return [...official,...(useDemos?EXAMPLES:[]),...local]}
  function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(local))}catch{notice='浏览器存储不可用；导入作品在本次页面内仍可运行。'}}
  function stopWorkers(){entries.forEach(e=>{e.runner?.close();e.hunter?.close();e.runner=null;e.hunter=null})}
  function prepare(){
    epoch++;clearTimeout(timer);stopWorkers();inFlight=false;invalid='';phase='ready';tick=cursor=0;round++;
    map=generateMap(seed,level);entries=candidates().map(e=>({...e,state:createState(map),hunterMemory:null,history:[createState(map)],actions:[]}));
    hunterPool=hunterCandidates(entries);
    chosen=entries.length?chooseHunter(hunterPool,`${seed}:${level}`):null;
    if(!entries.some(e=>e.id===focus))focus=null;
    render();
  }
  function at(e){return e.history[Math.min(cursor,e.history.length-1)]}
  const isBusy=()=>phase==='running'||inFlight;
  function render(){
    root.innerHTML=`<div class="maze">
      <div class="mz-controls"><div class="mz-settings"><label>地图种子<input id="mz-seed" maxlength="64" value="${esc(seed)}" aria-label="地图种子"></label><label>挑战难度<select id="mz-level">${Object.entries(LEVELS).map(([id,v])=>`<option value="${id}" ${id===level?'selected':''}>${v.name} · ${v.width}×${v.height}</option>`).join('')}</select></label><button class="button" id="mz-random">⤨ 随机地图</button></div><div class="mz-play"><label class="mz-speed">播放速度<select id="mz-speed">${[.25,.5,1,2,4,8,16].map(v=>`<option value="${v}" ${v===speed?'selected':''}>${v}×</option>`).join('')}</select></label><button class="button" id="mz-step">单步</button><button class="mz-primary" id="mz-start">开始比赛 ▶</button><button class="button" id="mz-reset">同图重赛</button></div></div>
      <div class="mz-roundbar"><span><i class="mz-dot"></i> ROUND ${String(round).padStart(2,'0')} <b id="mz-phase"></b></span><span>追逐策略：<button class="mz-hunter-info" id="mz-hunter-info" ${chosen?'':'disabled'} aria-label="查看本轮追逐策略与抽签池">${esc(chosen?.name||'等待参赛者')}</button><small> · 种子抽签 / 全场一致</small></span><span>1 tick = 1 次决策 · 1× = 4 tick/s</span></div>
      <div class="mz-notice" id="mz-notice" role="status"></div>
      <div class="mz-stats" id="mz-stats"></div>
      <div class="mz-sectionline"><div><h3>全场观战</h3><span>各自独立的同图世界 · 点击查看过程</span></div><div class="mz-entry-actions"><label><input id="mz-demos" type="checkbox" ${useDemos?'checked':''}> 内置示例</label><button class="button subtle" id="mz-import">＋ 导入 AI 三件套</button></div></div>
      <div class="mz-grid">${entries.map(e=>`<article class="mz-card" data-entry="${esc(e.id)}"><button class="mz-card-open" data-focus="${esc(e.id)}" aria-label="查看 ${esc(e.name)} 的比赛过程"><div class="mz-card-head"><span><i style="background:${e.color}"></i><strong>${esc(e.name)}</strong></span><b data-status></b></div><canvas data-board aria-label="${esc(e.name)} 的迷宫状态"></canvas><div class="mz-card-foot"><span data-metrics></span><strong data-score></strong></div></button><div class="mz-card-meta"><span>${esc(e.kind)}${e.revision?' · '+esc(e.revision):''}</span>${e.kind==='本地导入'?`<button data-remove="${esc(e.id)}" aria-label="移除 ${esc(e.name)}">移除</button>`:'<span>点击观战 ↗</span>'}</div></article>`).join('')||'<div class="empty-state">导入 strategy.js、hunter.js、README.md，或勾选内置示例开始试玩。</div>'}</div>
      <section class="mz-focus" id="mz-focus" hidden></section>
      <div class="mz-timeline"><button class="button" id="mz-live">回到最新</button><input id="mz-seek" type="range" min="0" max="0" value="0" aria-label="所有选手的统一回放时间"><span id="mz-clock"></span></div>
      <div class="mz-legend"><span><i class="mz-mark player"></i> 选手</span><span><i class="mz-mark key">K</i> 钥匙</span><span><i class="mz-mark exit">E</i> 出口</span><span><i class="mz-mark coin">◆</i> 晶片</span><span><i class="mz-mark trap">▲</i> 周期机关</span><span><i class="mz-mark gate">▥</i> 周期闸门</span><span><i class="mz-mark hunter"></i> 追逐者</span></div>
      <section class="mz-results" id="mz-results"></section>
      <div class="mz-bottom"><span>浏览器独立运行 · 统一离散时钟 · 种子可复现</span><button class="button subtle" id="mz-export">导出本轮记录 ↓</button></div>
      <dialog id="mz-upload"><form id="mz-upload-form"><div class="dialog-head"><h2>导入 AI 参赛作品</h2><button class="icon-button" type="button" id="mz-upload-close" aria-label="关闭">×</button></div><div class="mz-upload-body"><label>AI / 作品名称<input name="name" required maxlength="40" placeholder="例如：某模型 · v1"></label><label>选择同一 AI 的三个文件<input name="files" type="file" multiple required accept=".js,.md"></label><p>strategy.js · hunter.js · README.md<br>JavaScript 无依赖脚本，均定义 decide(observation)。TypeScript 请先编译为这两个 JS 文件。</p><p id="mz-upload-error" role="alert"></p><button class="mz-primary" type="submit">加入比赛</button></div></form></dialog>
    </div>`;
    $('#mz-start').onclick=()=>{if(phase==='running'){phase='paused';clearTimeout(timer);update()}else start()};
    $('#mz-step').onclick=async()=>{if(isBusy())return;if(phase==='finished'||phase==='invalid')prepare();phase='paused';await advance();update()};
    $('#mz-reset').onclick=()=>prepare();
    $('#mz-random').onclick=()=>{seed=crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase();prepare()};
    $('#mz-seed').onchange=e=>{const next=e.target.value.trim()||'CANVAS';if(next===seed){e.target.value=seed;return}seed=next;prepare()};
    $('#mz-level').onchange=e=>{const next=e.target.value;if(next===level)return;level=next;prepare()};
    $('#mz-speed').onchange=e=>{speed=Number(e.target.value)};
    $('#mz-demos').onchange=e=>{const next=e.target.checked;if(next===useDemos)return;useDemos=next;prepare()};
    $('#mz-seek').oninput=e=>{if(inFlight)return;if(phase==='running')phase='paused';clearTimeout(timer);cursor=Number(e.target.value);update()};
    $('#mz-live').onclick=()=>{cursor=tick;update()};
    root.querySelectorAll('[data-focus]').forEach(b=>b.onclick=()=>{focus=b.dataset.focus;renderFocus();update();$('#mz-focus').scrollIntoView({behavior:'smooth',block:'nearest'})});
    root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{local=local.filter(e=>e.id!==b.dataset.remove);persist();prepare()});
    $('#mz-import').onclick=()=>$('#mz-upload').showModal();
    $('#mz-upload-close').onclick=()=>$('#mz-upload').close();
    $('#mz-upload-form').onsubmit=importFiles;
    $('#mz-export').onclick=exportRound;
    $('#mz-hunter-info').onclick=()=>openDoc('追逐策略 · '+chosen.name,`本轮追逐策略：${chosen.name}\n\n抽签池（${hunterPool.length} 种）：\n${hunterPool.map(h=>h.name).join('、')}\n\n${chosen.note||chosen.readme||''}\n\n追逐策略源码：\n${chosen.hunterSource}`);
    renderFocus();update();
  }
  async function importFiles(event){
    event.preventDefault();
    try{
      if(local.length>=12)throw Error('本地最多保存 12 个作品，请先移除旧作品。正式提交始终全部参赛。');
      const form=event.target,files=[...form.elements.files.files],names=['strategy.js','hunter.js','README.md'];
      if(files.length!==3||names.some(n=>files.filter(f=>f.name===n).length!==1))throw Error('请同时选择 strategy.js、hunter.js、README.md 三个文件，文件名须一致。');
      if(files.some(f=>f.size>100000))throw Error('每个文件最多 100 KB。');
      const texts=await Promise.all(names.map(n=>files.find(f=>f.name===n).text()));
      if(!alive)return;
      const name=form.elements.name.value.trim();if(!name)throw Error('请填写作品名称。');
      local.push({id:'local-'+crypto.randomUUID(),name,color:COLORS[local.length%COLORS.length],kind:'本地导入',source:texts[0],hunterSource:texts[1],readme:texts[2]});
      persist();$('#mz-upload').close();notice='作品已加入。两个脚本将在点击开始时执行。';prepare();
    }catch(e){$('#mz-upload-error').textContent=e.message}
  }
  function initWorkers(){
    for(const e of entries)if(!e.runner&&e.state.status==='running'){
      e.runner=new StrategySandbox(e.source);e.hunter=new StrategySandbox(chosen.hunterSource);
      // Attach rejection handlers immediately, even when a frame fails before its first request.
      e.runner.initialized.catch(()=>{});e.hunter.initialized.catch(()=>{});
    }
  }
  async function start(){
    if(!entries.length||inFlight)return;
    if(phase==='finished'||phase==='invalid')prepare();
    cursor=tick;phase='running';update();schedule();
  }
  function schedule(){clearTimeout(timer);if(alive&&phase==='running')timer=setTimeout(async()=>{await advance();if(alive&&phase==='running')schedule()},250/speed)}
  async function advance(){
    if(inFlight||!entries.length||phase==='invalid')return;
    inFlight=true;const current=epoch;initWorkers();update();
    const moving=(tick+1)%map.hunterEvery===0;
    const outputs=await Promise.all(entries.map(async e=>{
      if(e.state.status!=='running')return null;
      const [runner,hunter]=await Promise.allSettled([
        e.runner.decide(observation(map,e.state)),
        moving?e.hunter.decide(observation(map,e.state,'hunter',e.hunterMemory)):Promise.resolve({actions:[],memory:e.hunterMemory}),
      ]);
      return {runner,hunter};
    }));
    if(!alive||epoch!==current)return;
    // Barrier: no world advances until every active runner and hunter has answered this tick.
    try{
      outputs.forEach((out,i)=>{if(!out)return;if(out.hunter.status==='rejected')throw Error(out.hunter.reason.message);if(moving)validateHunterResponse(entries[i].state,out.hunter.value)});
    }catch(error){invalid=`本轮作废：追逐策略「${chosen.name}」执行失败：${error.message}`;phase='invalid';inFlight=false;stopWorkers();update();return}
    outputs.forEach((out,i)=>{
      if(!out)return;const e=entries[i];
      if(out.runner.status==='rejected'){e.state=failState(e.state,out.runner.reason.message);e.state.tick=tick+1}
      else{
        e.hunterMemory=out.hunter.value.memory??null;
        e.state=step(map,e.state,out.runner.value,out.hunter.value);
      }
      e.actions.push({tick,runner:out.runner.status==='fulfilled'?out.runner.value:{error:out.runner.reason.message},hunter:moving?out.hunter.value:null});
      e.history.push({...e.state,memory:null});
      if(e.state.status!=='running'){e.runner.close();e.hunter.close();e.runner=null;e.hunter=null}
    });
    tick++;cursor=tick;inFlight=false;
    if(entries.every(e=>e.state.status!=='running')){phase='finished';stopWorkers()}
    update();
  }
  function renderFocus(){
    const panel=$('#mz-focus'),e=entries.find(e=>e.id===focus);panel.hidden=!e;
    if(!e){panel.innerHTML='';return}
    panel.innerHTML=`<div class="mz-focus-head"><div><span class="mz-eyebrow">STRATEGY INSPECTOR</span><h3>${esc(e.name)} <small>过程观战</small></h3></div><div><button class="button" id="mz-source">查看三件套</button><button class="button subtle" id="mz-unfocus">收起 ×</button></div></div><div class="mz-focus-body"><canvas id="mz-large" aria-label="${esc(e.name)} 的详细轨迹"></canvas><div class="mz-inspector"><div id="mz-inspect-stats"></div><h4>事件记录</h4><div id="mz-events"></div></div></div>`;
    $('#mz-unfocus').onclick=()=>{focus=null;renderFocus()};
    $('#mz-source').onclick=()=>openDoc(`${e.name} · 三件套源码`,`# strategy.js\n\n${e.source}\n\n# hunter.js\n\n${e.hunterSource}\n\n# README.md\n\n${e.readme}`);
  }
  function update(){
    if(!alive)return;
    const states=entries.map(e=>({...e,state:at(e)})),ordered=rank(map,states),finished=phase==='finished';
    $('#mz-phase').textContent={ready:'准备就绪',running:inFlight?'同步决策中':'比赛进行中',paused:'已暂停',finished:'比赛结束',invalid:'本轮作废'}[phase];
    const msg=invalid||notice;$('#mz-notice').textContent=msg;$('#mz-notice').hidden=!msg;
    $('#mz-start').textContent=phase==='running'?'暂停 Ⅱ':finished||phase==='invalid'?'再赛一轮 ▶':phase==='paused'?'继续比赛 ▶':'开始比赛 ▶';
    $('#mz-start').disabled=!entries.length||(inFlight&&phase!=='running');
    $('#mz-step').disabled=isBusy()||!entries.length;
    for(const id of ['mz-seed','mz-level','mz-random','mz-demos','mz-import'])$('#'+id).disabled=isBusy();
    root.querySelectorAll('[data-remove]').forEach(b=>b.disabled=isBusy());
    $('#mz-seek').disabled=inFlight;$('#mz-seek').max=tick;$('#mz-seek').value=cursor;
    $('#mz-clock').textContent=`${cursor} / ${map.maxTicks} tick${cursor<tick?' · 回放':''}`;
    $('#mz-stats').innerHTML=[['参赛作品',String(entries.length).padStart(2,'0'),'全部作品同步参赛'],['统一时钟',String(cursor).padStart(3,'0'),`已运行 ${tick} / ${map.maxTicks} tick`],['成功逃离',`${states.filter(e=>e.state.status==='escaped').length} / ${entries.length}`,'拿到钥匙后抵达出口'],['场景组合',`${map.traps.length+map.gates.length+map.hunters.length}`,`${map.traps.length} 机关 · ${map.gates.length} 闸门 · ${map.hunters.length} 追逐者`]].map(([a,b,c])=>`<div><span>${a}</span><strong>${b}</strong><small>${c}</small></div>`).join('');
    root.querySelectorAll('[data-entry]').forEach((card,i)=>{
      const e=entries[i],s=at(e);card.classList.toggle('selected',focus===e.id);
      card.querySelector('[data-status]').textContent=tick===0?'待出发':STATUS[s.status];
      card.querySelector('[data-metrics]').textContent=`${'♥'.repeat(s.hp)}${'♡'.repeat(3-s.hp)}  ·  ${s.key?'已取钥匙':'寻找钥匙'}  ·  ◆ ${s.coins.length}`;
      card.querySelector('[data-score]').textContent=invalid?'—':score(map,s).total.toLocaleString()+' 分';
      drawMap(card.querySelector('canvas'),map,s,e.color,e.history,cursor,false);
    });
    if(focus){
      const e=entries.find(e=>e.id===focus),s=at(e),sc=score(map,s);
      drawMap($('#mz-large'),map,s,e.color,e.history,cursor,true);
      $('#mz-inspect-stats').innerHTML=`<div class="mz-inspect-score">${invalid?'—':sc.total.toLocaleString()}<small> / 10,000</small></div><p>${STATUS[s.status]} · 位置 (${s.player.x}, ${s.player.y})<br>生命 ${s.hp}/3 · ${s.key?'钥匙已获取':'未获取钥匙'}<br>探索 ${Math.round(s.visited.length/map.floorCount*100)}% · 晶片 ${s.coins.length}/${map.coins.length}<br>当前动作 ${esc(s.action)} · tick ${s.tick}</p>`;
      const events=e.history.slice(0,Math.min(cursor+1,e.history.length)).flatMap(s=>s.events.map(text=>({tick:s.tick,text}))).slice(-14).reverse();
      $('#mz-events').innerHTML=events.map(ev=>`<div><time>${String(ev.tick).padStart(3,'0')}</time><span>${esc(ev.text)}</span></div>`).join('')||'<p>暂无事件</p>';
    }
    const validFinal=finished&&!invalid;
    $('#mz-results').innerHTML=`<div class="mz-sectionline"><div><h3>${invalid?'本轮作废':validFinal&&cursor===tick?'本轮结算':'实时排行榜'}</h3><span>${invalid?'修复追逐脚本后可同图重赛':cursor<tick?`回放至 tick ${cursor} 的排名`:'成功通关优先 · 满分 10,000'}</span></div><span class="mz-formula">逃生 6000 + 速度 2000 + 晶片 1000 + 探索 500 + 生命 500</span></div>
      ${validFinal&&cursor===tick?`<div class="mz-settlement"><span class="mz-trophy">${ordered.some(e=>e.state.status==='escaped')?'✦':'◇'}</span><div><strong>${ordered.some(e=>e.state.status==='escaped')?esc(ordered[0].name)+' 领跑本轮':'本轮无人逃离'}</strong><p>${entries.filter(e=>e.state.status==='escaped').length} 个作品成功逃离 · 共运行 ${tick} tick · 追逐策略来自 ${esc(chosen.name)}</p></div></div>`:''}
      <div class="table-scroll"><table class="mz-ranking"><thead><tr><th>排名 / 作品</th><th>状态</th><th>得分构成</th><th class="numeric">总分</th><th class="numeric">结束 tick</th></tr></thead><tbody>${ordered.map((e,i)=>{const s=e.state,sc=score(map,s);return `<tr><td><button data-rank-focus="${esc(e.id)}"><span class="mz-place">${String(i+1).padStart(2,'0')}</span><i class="mz-dot" style="background:${e.color}"></i>${esc(e.name)}</button></td><td>${STATUS[s.status]}</td><td><div class="mz-scorebar" aria-label="逃生 ${sc.escape}，速度 ${sc.speed}，晶片 ${sc.loot}，探索 ${sc.explore}，生命 ${sc.health}">${['escape','speed','loot','explore','health'].map(k=>`<i class="${k}" style="width:${invalid?0:sc[k]/100}%" title="${k}: ${sc[k]}"></i>`).join('')}</div></td><td class="numeric mz-total">${invalid?'—':sc.total.toLocaleString()}</td><td class="numeric">${s.finishTick??'—'}</td></tr>`}).join('')}</tbody></table></div>
      <div class="mz-score-key"><span><i class="escape"></i> 逃生</span><span><i class="speed"></i> 速度</span><span><i class="loot"></i> 晶片</span><span><i class="explore"></i> 探索</span><span><i class="health"></i> 生命</span></div>
      ${entries.length&&!invalid?scoreChart(map,entries,cursor):''}`;
    root.querySelectorAll('[data-rank-focus]').forEach(b=>b.onclick=()=>{focus=b.dataset.rankFocus;renderFocus();update();$('#mz-focus').scrollIntoView({behavior:'smooth',block:'nearest'})});
  }
  function exportRound(){
    const data={version:RULES_VERSION,seed,level,map,hunter:chosen?{id:chosen.id,name:chosen.name,source:chosen.hunterSource}:null,phase,invalid,tick,
      scoreFormula:'escape(6000) + speed(floor(2000*(1-finishTick/maxTicks))) + loot(floor(1000*coins/totalCoins)) + explore(floor(500*visited/floorCount)) + health(floor(500*hp/3)); error=0',
      entries:entries.map(e=>({id:e.id,name:e.name,kind:e.kind,source:e.source,hunterSource:e.hunterSource,readme:e.readme,result:e.state,score:invalid?null:score(map,e.state),actions:e.actions,history:e.history}))};
    download(`maze-${seed.replace(/[^a-zA-Z0-9_-]/g,'_')}-${level}.json`,JSON.stringify(data,null,2),'application/json');
  }
  const resize=new ResizeObserver(()=>{if(alive&&map)root.querySelectorAll('[data-entry]').forEach((card,i)=>drawMap(card.querySelector('canvas'),map,at(entries[i]),entries[i].color,entries[i].history,cursor,false))});
  prepare();resize.observe(root);
  return ()=>{alive=false;epoch++;clearTimeout(timer);stopWorkers();resize.disconnect();$('#mz-upload')?.close()};
}

function drawMap(canvas,map,s,color,history,cursor,detail){
  if(!canvas)return;
  const cell=detail?24:16,w=map.width*cell,h=map.height*cell;
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
  const c=canvas.getContext('2d');c.fillStyle='#111c23';c.fillRect(0,0,w,h);
  const visited=new Set(s.visited);
  for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++){
    c.fillStyle=map.grid[y][x]?'#26343e':visited.has(`${x},${y}`)?'#192f33':'#111c23';
    c.fillRect(x*cell+1,y*cell+1,cell-2,cell-2);
  }
  const center=p=>[(p.x+.5)*cell,(p.y+.5)*cell];
  c.strokeStyle=color+'80';c.lineWidth=detail?2:1.2;c.beginPath();
  history.slice(0,cursor+1).forEach((s,i)=>{const [x,y]=center(s.player);i?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();
  c.font=`bold ${cell*.62}px system-ui`;c.textAlign='center';c.textBaseline='middle';
  let [x,y]=center(map.exit);c.fillStyle=s.key?'#43b397':'#315b55';c.fillRect(x-cell*.38,y-cell*.38,cell*.76,cell*.76);c.fillStyle='#d5ffed';c.fillText('E',x,y+1);
  if(!s.key){[x,y]=center(map.key);c.fillStyle='#f3ca72';c.fillText('K',x,y+1)}
  for(const p of map.coins)if(!s.coins.includes(`${p.x},${p.y}`)){
    [x,y]=center(p);c.fillStyle='#dfb66b';c.beginPath();c.moveTo(x,y-3);c.lineTo(x+3,y);c.lineTo(x,y+3);c.lineTo(x-3,y);c.closePath();c.fill();
  }
  for(const t of map.traps){[x,y]=center(t);c.fillStyle=active(t,s.tick)?'#e78664':'#624739';c.beginPath();c.moveTo(x,y-cell*.3);c.lineTo(x+cell*.3,y+cell*.26);c.lineTo(x-cell*.3,y+cell*.26);c.closePath();c.fill()}
  for(const g of map.gates){[x,y]=center(g);c.strokeStyle=active(g,s.tick)?'#9b8ac5':'#49475e';c.lineWidth=2;for(let d=-.25;d<=.25;d+=.25){c.beginPath();c.moveTo(x+cell*d,y-cell*.36);c.lineTo(x+cell*d,y+cell*.36);c.stroke()}}
  for(const hunter of s.hunters){[x,y]=center(hunter);c.fillStyle='#e37c80';c.beginPath();c.arc(x,y,cell*.31,0,Math.PI*2);c.fill();c.fillStyle='#3b202b';c.fillRect(x-3,y-1,2,2);c.fillRect(x+1,y-1,2,2)}
  [x,y]=center(s.player);c.shadowColor=color;c.shadowBlur=9;c.fillStyle=s.status==='dead'?'#89939a':color;c.beginPath();c.arc(x,y,cell*.34,0,Math.PI*2);c.fill();c.shadowBlur=0;c.strokeStyle='#fff';c.lineWidth=1.5;c.stroke();
}
function scoreChart(map,entries,cursor){
  const width=760,height=135,left=42,right=744,bottom=106,top=14;
  const x=t=>left+t/map.maxTicks*(right-left),y=v=>bottom-v/10000*(bottom-top);
  const grid=[0,5000,10000].map(v=>`<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text x="${left-9}" y="${y(v)+4}" text-anchor="end">${v/1000}k</text>`).join('');
  const lines=entries.map(e=>{const hist=e.history.slice(0,cursor+1),points=hist.filter((s,i)=>i%3===0||i===hist.length-1||s.status!=='running').map(s=>`${x(s.tick)},${y(score(map,s).total)}`).join(' ');return `<polyline points="${points}" stroke="${e.color}"/><circle cx="${x(hist.at(-1).tick)}" cy="${y(score(map,hist.at(-1)).total)}" r="2.5" fill="${e.color}"/>`}).join('');
  return `<div class="mz-chart"><span>得分进程</span><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="所有参赛作品随逻辑时钟变化的得分曲线">${grid}${lines}<text x="${left}" y="128">0 tick</text><text x="${right}" y="128" text-anchor="end">${map.maxTicks} tick</text></svg></div>`;
}
