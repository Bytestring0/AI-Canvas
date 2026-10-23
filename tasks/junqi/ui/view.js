import {esc,download} from '../../ui.js';
import {RULES_VERSION,LEVELS,TICKS_PER_SECOND,LAND_PERIOD,GROWTH_PERIOD,productionRate,MAX_MOVES,MAX_PLAYERS,DIRS,TERRAIN,seeded,createGame,observation,score,rank,visibleMask} from './engine.js';
import {StrategySandbox} from './sandbox.js';
import {BASELINE} from './baseline.js';
import {resolveTick,snapshot} from './game.js';

const TEAM_NAMES=['甲','乙','丙','丁'];
// 席位色：色相每档约 22° 均匀铺开，明度一致，相邻座位一眼可分，白字可读。
const TEAM_COLORS=['#b54444','#4a74b0','#559748','#b0813a'];
const SEAT_COLORS=['#b54444','#b5623c','#b0813a','#9d9038','#7d9c3c','#559748','#3f9a63','#37988a','#3a97a4','#4089ad','#4a74b0','#5c63ae','#7a58ad','#9a53a3','#ad4d84','#647a8f'];
const KIND_LABEL={official:'正式提交',local:'本地导入',baseline:'内置基准',human:'真人'};
const STORAGE='ai-canvas-junqi-entries-v1';
const SERIES='ai-canvas-junqi-series-v2';
const SVG_ICON='<svg viewBox="0 0 24 24" aria-hidden="true">';
const SVG_CROWN=SVG_ICON+'<path fill="currentColor" d="M4.4 16.6 4.4 8.2 8.9 11.6 12 5.4 15.1 11.6 19.6 8.2 19.6 16.6 Z M3.8 17.6 H20.2 V19.6 H3.8 Z"/></svg>';
const SVG_FORTRESS=SVG_ICON+'<path fill="currentColor" d="M3 19 V10 H6.4 V6.6 H9.4 V10 H14.6 V6.6 H17.6 V10 H21 V19 Z"/></svg>';
const SVG_MOUNTAIN=SVG_ICON+'<path fill="currentColor" d="M2 19 9.4 5.8 12.9 11.2 16.3 6.6 22 19 Z"/></svg>';
const PHASE_TEXT={ready:'准备就绪',running:'对局进行中',paused:'已暂停',finished:'对局结束'};
const DIR_ARROWS={up:[0,-1],right:[1,0],down:[0,1],left:[-1,0]};

export function mountGallery(root,ctx){return arena(root,ctx)}
export function mount(root,ctx){return arena(root,ctx)}

const readLocal=()=>{try{return JSON.parse(localStorage.getItem(STORAGE)||'[]').filter(e=>e&&typeof e.id==='string'&&typeof e.name==='string'&&typeof e.source==='string'&&e.source.length<=100000).slice(0,12).map(e=>({...e,kind:'local'}))}catch{return []}};
const readSeries=()=>{try{const s=JSON.parse(localStorage.getItem(SERIES));return s&&typeof s==='object'&&s.rows&&typeof s.rows==='object'?s:{rows:{}}}catch{return {rows:{}}}};

function arena(root,{task,models,submissions,openDoc}){
  const official=submissions.map(s=>{
    const m=models.find(m=>m.id===s.model),r=s.revisions.at(-1);
    return {id:m.id,name:m.name,color:m.color,kind:'official',source:r.source,readme:r.readme,revision:r.id};
  });
  let local=readLocal(),humans=[];
  let picked=new Map();           // candidate id -> {on:bool}
  let teamOf=new Map();           // participant id -> team number (组队模式)
  let mode='ffa',teamCount=2,level='standard',seed=new URLSearchParams(location.search).get('junqiSeed')||'CANVAS-'+Math.floor(Math.random()*900+100);
  let phase='setup',round=0,speed=1,tick=0,cursor=0,game=null,seats=[],history=[],eventsLog=[];
  let memories={},humanQueues={},selections={},fogPid=null,activeHumanPid=null;
  let alive=true,epoch=0,inFlight=false,timer=null,notice='',series=readSeries(),recorded=false;
  const $=s=>root.querySelector(s);

  function candidates(){return [...official,...local,BASELINE]}
  function participants(){
    const list=candidates().filter(e=>picked.get(e.id)?.on);
    return [...list,...humans.filter(h=>picked.get(h.id)?.on)];
  }
  function persistLocal(){try{localStorage.setItem(STORAGE,JSON.stringify(local))}catch{notice='浏览器存储不可用；导入作品在本次页面内仍可运行。'}}
  function persistSeries(){try{localStorage.setItem(SERIES,JSON.stringify(series))}catch{notice='浏览器存储不可用，战绩仅在本页内保留。'}}
  function stopWorkers(){seats.forEach(s=>{s.sandbox?.close();s.sandbox=null})}
  const humanSeats=()=>seats.filter(s=>s.human);
  const aliveHumanPids=()=>humanSeats().filter(s=>game?.players[s.pid].alive).map(s=>s.pid);
  const isBusy=()=>phase==='running'||inFlight;

  // 开局名单只裁不扩：保留手动勾选，仅当超出人数上限时按"真人→正式提交→本地→基准"截断。
  function trimPicks(){
    const order=[...humans,...candidates()];
    const current=new Map(order.map(e=>[e.id,{on:Boolean(picked.get(e.id)?.on)}]));
    for(const h of humans)current.set(h.id,{on:true}); // 真人默认上场
    if(order.filter(e=>current.get(e.id).on).length>MAX_PLAYERS){
      const keep=new Set(order.slice(0,MAX_PLAYERS).map(e=>e.id));
      for(const e of order)if(!keep.has(e.id))current.set(e.id,{on:false});
    }
    picked=current;
    if(mode==='team')defaultTeams();
  }
  function defaultTeams(){
    const counts=Array(teamCount).fill(0),parts=participants();
    for(const p of parts)if(teamOf.has(p.id)&&teamOf.get(p.id)>=teamCount)teamOf.delete(p.id);
    for(const p of parts)if(teamOf.has(p.id))counts[teamOf.get(p.id)]++;
    for(const p of parts)if(!teamOf.has(p.id)){
      const team=counts.indexOf(Math.min(...counts));
      teamOf.set(p.id,team);counts[team]++;
    }
  }
  function randomTeams(){
    const ids=participants().map(p=>p.id),rng=seeded(`${RULES_VERSION}:teams:${seed}:${ids.length}:${ids.join(',')}`);
    for(let i=ids.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]]}
    teamOf=new Map(ids.map((id,i)=>[id,i%teamCount]));
  }

  /* ---------- 设置界面 ---------- */
  function renderSetup(){
    const pool=candidates(),parts=participants();
    if(mode==='team')defaultTeams();
    const teamsInPlay=new Set(parts.map(p=>teamOf.get(p.id)??-1));
    const canStart=parts.length>=2&&parts.length<=MAX_PLAYERS&&(mode==='ffa'||teamsInPlay.size>=2);
    const reason=parts.length<2?`至少选择 2 名参赛者（当前 ${parts.length}）`:parts.length>MAX_PLAYERS?`最多 ${MAX_PLAYERS} 名参赛者`:mode==='team'&&teamsInPlay.size<2?'组队模式需要至少 2 个不同队伍':'';
    const row=e=>{
      const on=picked.get(e.id)?.on;
      const team=teamOf.get(e.id)??0;
      return `<li class="jq-pick${on?' on':''}" data-id="${esc(e.id)}"><label class="jq-pick-check"><input type="checkbox" data-pick="${esc(e.id)}" ${on?'checked':''} aria-label="选择 ${esc(e.name)}"></label><i style="background:${e.color||SEAT_COLORS[0]}"></i><div class="jq-pick-name"><strong>${esc(e.name)}</strong><span>${esc(KIND_LABEL[e.kind]||e.kind)}${e.revision?' · '+esc(e.revision):''}</span></div>${mode==='team'?`<select data-team="${esc(e.id)}" aria-label="${esc(e.name)} 的队伍">${TEAM_NAMES.slice(0,teamCount).map((n,t)=>`<option value="${t}" ${team===t?'selected':''}>${n}队</option>`).join('')}</select>`:''}${e.kind==='official'?`<button class="button subtle" data-source="${esc(e.id)}">源码</button>`:''}${(e.kind==='local'||e.kind==='human')?`<button class="jq-remove" data-remove="${esc(e.id)}" aria-label="移除 ${esc(e.name)}">移除</button>`:''}</li>`;
    };
    root.innerHTML=`<div class="junqi">
      <div class="jq-notice" id="jq-notice" role="status">${esc(notice)}</div>
      <section class="jq-panel">
        <div class="jq-sectionline"><div><h3>对局设置</h3><span>generals.io 规则 · 战争迷雾 · 统一离散时钟 · 种子可复现</span></div><span class="jq-count">${parts.length} / ${MAX_PLAYERS} 名参赛者</span></div>
        <div class="jq-settings">
          <div class="jq-mode-switch" role="group" aria-label="对局模式"><button data-mode="ffa" aria-pressed="${mode==='ffa'}">自由混战</button><button data-mode="team" aria-pressed="${mode==='team'}">组队作战</button></div>
          ${mode==='team'?`<label>队伍数<select id="jq-team-count">${[2,3,4].map(t=>`<option value="${t}" ${teamCount===t?'selected':''}>${t} 队</option>`).join('')}</select></label><button class="button" id="jq-random-teams">随机组队</button>`:''}
          <label>地图种子<input id="jq-seed" maxlength="64" value="${esc(seed)}" aria-label="地图种子"></label>
          <button class="button" id="jq-random-map">⤨ 随机地图</button>
          <label>场地<select id="jq-level">${Object.entries(LEVELS).map(([id,v])=>{const w=v.width(Math.max(2,parts.length)),h=v.height(Math.max(2,parts.length));return `<option value="${id}" ${id===level?'selected':''}>${v.name} · ${w}×${h} · ${v.maxTicks} tick</option>`}).join('')}</select></label>
        </div>
        <div class="jq-start-line"><p>${reason?esc(reason):mode==='team'?'同队玩家互相增援而不交战，擒获全部敌队将军即获胜':'各自为战，擒获其他所有玩家的将军即获胜'}</p><button class="jq-primary" id="jq-start" ${canStart?'':'disabled'}>开始比赛 ▶</button></div>
      </section>
      <section class="jq-panel">
        <div class="jq-sectionline"><div><h3>参赛阵容</h3><span>正式提交始终可选 · 本地导入保存在浏览器 · 真人通过点击棋盘下场</span></div><div class="jq-entry-actions"><label>抽签人数<input id="jq-draw-count" type="number" min="2" max="${Math.max(2,pool.length)}" value="${Math.min(Math.max(pool.length,2),4)}" aria-label="随机抽签人数"></label><button class="button" id="jq-draw" ${pool.length<2?'disabled':''}>随机抽签</button><button class="button" id="jq-all">全部参赛</button><button class="button" id="jq-none">清空</button><button class="button subtle" id="jq-add-human" ${humans.length?'disabled':''}>＋ 加入真人</button><button class="button subtle" id="jq-import">＋ 导入策略</button></div></div>
        ${pool.length||humans.length?`<ul class="jq-picks">${pool.map(row).join('')}${humans.map(row).join('')}</ul>`:`<div class="empty-state"><strong>还没有可选策略</strong><p>在 submissions/junqi/&lt;模型名&gt;/ 放入 strategy.js 与 README.md，或导入本地文件、加入真人试玩。内置基准可随时勾选参赛。</p></div>`}
      </section>
      ${renderSeries(true)}
      <dialog id="jq-upload"><form id="jq-upload-form"><div class="dialog-head"><h2>导入 AI 策略</h2><button class="icon-button" type="button" id="jq-upload-close" aria-label="关闭">×</button></div><div class="jq-upload-body"><label>AI / 作品名称<input name="name" required maxlength="40" placeholder="例如：某模型 · v1"></label><label>选择两个文件<input name="files" type="file" multiple required accept=".js,.md"></label><p>strategy.js · README.md<br>JavaScript 无依赖脚本，顶层定义 decide(observation)。TypeScript 请先编译为标准 JS。</p><p id="jq-upload-error" role="alert"></p><button class="jq-primary" type="submit">加入名单</button></div></form></dialog>
      <dialog id="jq-human"><form id="jq-human-form"><div class="dialog-head"><h2>加入真人</h2><button class="icon-button" type="button" id="jq-human-close" aria-label="关闭">×</button></div><div class="jq-upload-body"><label>真人名称<input name="name" required maxlength="20" placeholder="例如：我自己"></label><p>真人通过点击棋盘操作：点击己方格子选中并默认带走全部军队，双击改为带走一半，再点击相邻格子或按 WASD / 方向键移动。每 tick 最多 ${MAX_MOVES} 条指令。</p><p id="jq-human-error" role="alert"></p><button class="jq-primary" type="submit">加入名单</button></div></form></dialog>
    </div>`;
    notice='';
    root.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{if(b.dataset.mode===mode)return;mode=b.dataset.mode;renderSetup()});
    if(mode==='team'){
      $('#jq-team-count').onchange=e=>{teamCount=Number(e.target.value);randomTeams();renderSetup()};
      $('#jq-random-teams').onclick=()=>{randomTeams();renderSetup()};
    }
    $('#jq-seed').onchange=e=>{seed=e.target.value.trim()||'CANVAS';renderSetup()};
    $('#jq-random-map').onclick=()=>{seed='CANVAS-'+Math.floor(Math.random()*9000+1000);renderSetup()};
    $('#jq-level').onchange=e=>{level=e.target.value;renderSetup()};
    $('#jq-start').onclick=startMatch;
    $('#jq-draw').onclick=()=>{
      if(pool.length<2)return;
      const count=Math.max(2,Math.min(Number($('#jq-draw-count').value)||2,pool.length,MAX_PLAYERS-humans.filter(h=>picked.get(h.id)?.on).length));
      // 名单抽签是操作行为，不进入对局复现；用时间熵打散即可。
      const rng=seeded(`draw:${Date.now().toString(36)}:${Math.random()}`);
      const indexes=[...pool.keys()];
      for(let i=indexes.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[indexes[i],indexes[j]]=[indexes[j],indexes[i]]}
      const chosen=new Set(indexes.slice(0,count).map(i=>pool[i].id)); // 下标 → 选手 id
      picked=new Map([...pool.map(e=>[e.id,{on:chosen.has(e.id)}]),...humans.map(h=>[h.id,{on:!!picked.get(h.id)?.on}])]);
      if(mode==='team')randomTeams();
      renderSetup();
    };
    $('#jq-all').onclick=()=>{picked=new Map([...humans,...pool].slice(0,MAX_PLAYERS).map(e=>[e.id,{on:true}]));if(mode==='team')defaultTeams();renderSetup()};
    $('#jq-none').onclick=()=>{picked=new Map();renderSetup()};
    $('#jq-add-human').onclick=()=>{if(!humans.length)$('#jq-human').showModal()};
    $('#jq-human-close').onclick=()=>$('#jq-human').close();
    $('#jq-human-form').onsubmit=event=>{
      event.preventDefault();
      const name=event.target.elements.name.value.trim();
      if(!name)return;
      if(humans.length){$('#jq-human-error').textContent='只能添加一位真人，请先移除已有真人。';return}
      const entry={id:'human-'+crypto.randomUUID(),name,color:SEAT_COLORS[(official.length+local.length+humans.length)%SEAT_COLORS.length],kind:'human'};
      humans.push(entry);
      trimPicks(); // 新真人默认上场，仅在超上限时裁剪候选
      $('#jq-human').close();renderSetup();
    };
    $('#jq-import').onclick=()=>$('#jq-upload').showModal();
    $('#jq-upload-close').onclick=()=>$('#jq-upload').close();
    $('#jq-upload-form').onsubmit=importFiles;
    root.querySelectorAll('[data-pick]').forEach(box=>box.onchange=()=>{
      const entry=picked.get(box.dataset.pick)||{on:false};
      picked.set(box.dataset.pick,{on:box.checked});
      renderSetup();
    });
    root.querySelectorAll('[data-team]').forEach(select=>select.onchange=()=>{teamOf.set(select.dataset.team,Number(select.value));renderSetup()});
    root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{
      humans=humans.filter(h=>h.id!==b.dataset.remove);
      local=local.filter(e=>e.id!==b.dataset.remove);
      teamOf.delete(b.dataset.remove);picked.delete(b.dataset.remove);
      persistLocal();renderSetup();
    });
    root.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>{
      const e=official.find(o=>o.id===b.dataset.source);
      if(e)openDoc(`${e.name} · 策略源码`,`${e.source}\n\n# 说明\n\n${e.readme||''}`);
    });
    bindSeries();
  }

  async function importFiles(event){
    event.preventDefault();
    try{
      if(local.length>=12)throw Error('本地最多保存 12 个策略，请先移除旧条目。正式提交始终全部可选。');
      const form=event.target,files=[...form.elements.files.files];
      const strategy=files.find(f=>f.name==='strategy.js');
      if(!strategy)throw Error('请选择名为 strategy.js 的文件（README.md 可一并选择）。');
      const readmeFile=files.find(f=>f.name==='README.md');
      if(files.some(f=>f.size>100000))throw Error('每个文件最多 100 KB。');
      const source=await strategy.text();
      const name=form.elements.name.value.trim();
      if(!name)throw Error('请填写名称。');
      local.push({id:'local-'+crypto.randomUUID(),name,color:SEAT_COLORS[(official.length+local.length)%SEAT_COLORS.length],kind:'local',source,readme:readmeFile?await readmeFile.text():''});
      persistLocal();$('#jq-upload').close();notice='策略已加入名单。';renderSetup();
    }catch(e){$('#jq-upload-error').textContent=e.message}
  }

  /* ---------- 进入对局 ---------- */
  function startMatch(){
    const parts=participants();
    if(mode==='team')defaultTeams();
    try{
      game=createGame(seed,parts.map((p,i)=>({team:mode==='ffa'?i:(teamOf.get(p.id)??i%teamCount),name:p.name})),level);
    }catch(reason){
      notice=`无法开局：${reason.message}`;phase='setup';renderSetup();return;
    }
    seats=parts.map((p,i)=>({pid:i,entry:p,human:p.kind==='human',name:p.name,kind:p.kind,team:game.players[i].team,
      color:mode==='team'?TEAM_COLORS[game.players[i].team]:SEAT_COLORS[i%SEAT_COLORS.length]}));
    memories={};humanQueues={};selections={};eventsLog=[];recorded=false;round++;
    fogPid=seats.find(s=>s.human&&game.players[s.pid].alive)?.pid??null;
    seats.forEach(s=>{memories[s.pid]=null;humanQueues[s.pid]=[];selections[s.pid]=null});
    activeHumanPid=seats.find(s=>s.human)?.pid??null;
    history=[snapshot(game,aliveHumanPids())];
    game.events.forEach(text=>eventsLog.push({tick:0,text}));
    tick=cursor=0;phase='ready';
    stopWorkers();
    renderArena();update(true);
  }

  /* ---------- 对局界面 ---------- */
  function renderArena(){
    const humanSeat=humanSeats()[0];
    root.innerHTML=`<div class="junqi">
      <div class="jq-roundbar"><span><i class="jq-dot"></i> ROUND ${String(round).padStart(2,'0')} <b id="jq-phase"></b></span><span>${mode==='team'?'组队作战':'自由混战'} · ${LEVELS[level].name} · 种子 <strong>${esc(seed)}</strong></span><span>1× = ${TICKS_PER_SECOND} tick/s · 每 tick 最多 ${MAX_MOVES} 指令</span><button class="button subtle" id="jq-back">← 返回设置</button></div>
      <div class="jq-notice" id="jq-notice" role="status" hidden></div>
      <div class="jq-controls">
        <div class="jq-play"><label class="jq-speed">速度<select id="jq-speed">${[.25,.5,1,2,4,8,16].map(v=>`<option value="${v}" ${v===speed?'selected':''}>${v}×</option>`).join('')}</select></label><button class="button" id="jq-step">单步</button><button class="jq-primary" id="jq-start">开始对局 ▶</button><button class="button" id="jq-reset">同图重赛</button></div>
        <div class="jq-viewbar">${humanSeat?`<span class="jq-humans-chips">操作真人：${esc(humanSeat.name)}</span>`:''}<label class="jq-fog">视角<select id="jq-view" aria-label="棋盘视角"></select></label></div>
      </div>
      <div class="jq-stats" id="jq-stats"></div>
      <div class="jq-battle">
        <div class="jq-board-wrap"><button class="jq-fullscreen" id="jq-fullscreen" title="全屏查看棋盘（Esc 退出）">⛶ 全屏</button><canvas id="jq-board" aria-label="将军棋棋盘" tabindex="0"></canvas><div class="jq-hint" id="jq-hint"></div></div>
        <aside class="jq-side">
          <section><div class="jq-side-head"><h4>实时排行榜</h4><span id="jq-board-note"></span></div><div class="table-scroll"><table class="jq-ranking"><thead><tr><th>#</th><th>选手</th><th>状态</th><th class="numeric">军力</th><th class="numeric">领土</th><th class="numeric">城市</th><th class="numeric">得分</th></tr></thead><tbody id="jq-board-rows"></tbody></table></div></section>
          <section><div class="jq-side-head"><h4>战况事件</h4></div><div class="jq-events" id="jq-events"></div></section>
        </aside>
      </div>
      <div class="jq-timeline"><button class="button" id="jq-live">回到最新</button><input id="jq-seek" type="range" min="0" max="0" value="0" aria-label="统一回放时间轴"><span id="jq-clock"></span></div>
      <div class="jq-legend"><span><i class="jq-mark land"></i> 中立土地</span><span><i class="jq-mark mountain">${SVG_MOUNTAIN}</i> 山地</span><span><i class="jq-mark city">${SVG_FORTRESS}</i> 城市（中立驻军 40~50）</span><span><i class="jq-mark general">${SVG_CROWN}</i> 将军（被攻陷即出局）</span><span><i class="jq-mark fog"></i> 迷雾（-1 未知）</span><span>将军/城市每 tick 产兵 · 土地每 ${LAND_PERIOD} tick 产兵 · 每 ${GROWTH_PERIOD} tick 产量 +1</span></div>
      <section class="jq-results" id="jq-results"></section>
      ${renderSeries(false)}
      <div class="jq-bottom"><span>浏览器独立运行 · 策略在隔离 Worker 中执行 · 同种子同名单可复现</span><button class="button subtle" id="jq-export">导出本局记录 ↓</button></div>
    </div>`;
    $('#jq-start').onclick=()=>{if(phase==='running'){phase='paused';clearTimeout(timer);update(true)}else startRun()};
    $('#jq-step').onclick=async()=>{if(isBusy()||!game)return;if(phase==='finished')return;phase='paused';await advance();update(true)};
    $('#jq-reset').onclick=()=>startMatch();
    $('#jq-back').onclick=()=>{clearTimeout(timer);stopWorkers();phase='setup';renderSetup()};
    $('#jq-speed').onchange=e=>{speed=Number(e.target.value)};
    $('#jq-view').onchange=e=>{fogPid=e.target.value===''?null:Number(e.target.value);update(true)};
    refreshViewOptions();
    $('#jq-seek').oninput=e=>{if(inFlight)return;if(phase==='running'){phase='paused';clearTimeout(timer)}cursor=Number(e.target.value);update(true)};
    $('#jq-live').onclick=()=>{cursor=tick;update(true)};
    $('#jq-export').onclick=exportRound;
    const canvas=$('#jq-board');
    const fsButton=$('#jq-fullscreen');
    if(fsButton){
      fsButton.hidden=typeof canvas.parentElement.requestFullscreen!=='function';
      fsButton.onclick=()=>{
        if(document.fullscreenElement)document.exitFullscreen();
        else canvas.parentElement.requestFullscreen?.().catch(reason=>{notice=`无法进入全屏：${reason?.message||reason}`;update(true)});
      };
    }
    canvas.addEventListener('click',onBoardClick);
    canvas.addEventListener('dblclick',e=>{
      if(!game||phase==='setup'||phase==='finished'||inFlight||cursor!==tick)return;
      const pid=activeHumanPid;
      if(pid==null||!game.players[pid].alive)return;
      const cell=cellFromEvent(e);if(!cell)return;
      const p=cell.y*game.width+cell.x;
      if(game.owner[p]===pid){selections[pid]={idx:p,half:true};update()}
    });
    canvas.addEventListener('contextmenu',e=>{e.preventDefault();const pid=activeHumanPid;if(pid!=null&&game?.players[pid].alive){selections[pid]=null;update()}});
    bindSeries();
  }

  function startRun(){
    if(!game||inFlight)return;
    if(phase==='finished')return;
    cursor=tick;phase='running';update(true);schedule();
  }
  function schedule(){
    clearTimeout(timer);
    if(!alive||phase!=='running')return;
    // Background tabs clamp setTimeout to ~1s; run several barrier ticks per wake-up
    // to catch up toward the target pace. Simulation order and determinism are unchanged.
    const perWake=Math.min(8,Math.max(1,Math.round(speed*TICKS_PER_SECOND/4)));
    timer=setTimeout(async()=>{
      for(let i=0;i<perWake;i++){await advance();if(!alive||phase!=='running')break}
      if(alive&&phase==='running')schedule();
    },Math.max(250,500/speed));
  }

  function initWorkers(){
    for(const seat of seats)
      if(!seat.human&&game.players[seat.pid].alive&&!seat.sandbox){
        seat.sandbox=new StrategySandbox(seat.entry.source);
        // Attach rejection handlers immediately, even when a frame fails before its first request.
        seat.sandbox.initialized.catch(()=>{});
      }
  }
  async function advance(){
    if(inFlight||!game||game.finished||phase==='setup')return;
    inFlight=true;const current=epoch;
    initWorkers();
    const outputs=await Promise.all(seats.map(async seat=>{
      const pid=seat.pid;
      if(!game.players[pid].alive)return null;
      if(seat.human)return {status:'fulfilled',value:{moves:humanQueues[pid].splice(0,MAX_MOVES)}};
      try{return {status:'fulfilled',value:await seat.sandbox.decide(observation(game,pid,memories[pid]))}}
      catch(reason){return {status:'rejected',reason}}
    }));
    if(!alive||epoch!==current){inFlight=false;return}
    outputs.forEach((out,i)=>{if(out?.status==='fulfilled')memories[seats[i].pid]=out.value.memory??null});
    game=resolveTick(game,outputs).state;
    history.push(snapshot(game,aliveHumanPids()));
    game.events.forEach(text=>eventsLog.push({tick:game.tick,text}));
    tick=cursor=game.tick;
    seats.forEach(seat=>{
      if(!seat.human&&!game.players[seat.pid].alive&&seat.sandbox){seat.sandbox.close();seat.sandbox=null}
      if(seat.human&&!game.players[seat.pid].alive){humanQueues[seat.pid]=[];selections[seat.pid]=null}
    });
    inFlight=false;
    if(game.finished){phase='finished';stopWorkers();if(!recorded){recorded=true;recordSeries()}}
    update(game.finished);
  }

  /* ---------- 真人操作 ---------- */
  function cellFromEvent(event){
    const canvas=$('#jq-board');if(!canvas)return null;
    const rect=canvas.getBoundingClientRect();
    const x=Math.floor((event.clientX-rect.left)/rect.width*game.width);
    const y=Math.floor((event.clientY-rect.top)/rect.height*game.height);
    if(x<0||y<0||x>=game.width||y>=game.height)return null;
    return {x,y};
  }
  function queueHumanMove(pid,from,dir){
    const [dx,dy]=DIRS[dir],x=from.x+dx,y=from.y+dy;
    if(x<0||y<0||x>=game.width||y>=game.height||game.terrain[y*game.width+x]===TERRAIN.MOUNTAIN)return false;
    const queue=humanQueues[pid];
    if(queue.length>=MAX_MOVES){notice=`每 tick 最多 ${MAX_MOVES} 条指令，稍候再试。`;return false}
    const selection=selections[pid];
    const half=Boolean(selection&&selection.idx===from.y*game.width+from.x&&selection.half);
    queue.push({from:{...from},dir,half});
    selections[pid]={idx:(from.y+dy)*game.width+(from.x+dx),half:false}; // 选框跟随，恢复全军默认
    return true;
  }
  function onBoardClick(event){
    if(!game||phase==='setup'||phase==='finished'||inFlight)return;
    if(cursor!==tick)return; // 回放时不接受操作
    const pid=activeHumanPid;
    if(pid==null||!game.players[pid].alive)return;
    const cell=cellFromEvent(event);if(!cell)return;
    const p=cell.y*game.width+cell.x,selection=selections[pid];
    if(game.owner[p]===pid){
      selections[pid]={idx:p,half:false}; // 双击事件会随后把本格改为半军
      update();return;
    }
    if(selection){
      const sx=selection.idx%game.width,sy=(selection.idx/game.width)|0;
      for(const [dir,[dx,dy]] of Object.entries(DIRS)){
        if(sx+dx===cell.x&&sy+dy===cell.y){queueHumanMove(pid,{x:sx,y:sy},dir);update();return}
      }
    }
    selections[pid]=null;
    update();
  }
  function onKeydown(event){
    if(!game||phase==='setup'||phase==='finished'||inFlight)return;
    if(['INPUT','SELECT','TEXTAREA'].includes(event.target?.tagName))return;
    const pid=activeHumanPid;
    if(pid==null||!game?.players[pid]?.alive)return;
    if(event.key==='Escape'){selections[pid]=null;update();return}
    if(cursor!==tick)return;
    const map={ArrowUp:'up',ArrowRight:'right',ArrowDown:'down',ArrowLeft:'left',w:'up',d:'right',s:'down',a:'left'};
    const dir=map[event.key.length===1?event.key.toLowerCase():event.key];
    if(!dir)return;
    const selection=selections[pid];
    if(!selection)return;
    event.preventDefault();
    const from={x:selection.idx%game.width,y:(selection.idx/game.width)|0};
    queueHumanMove(pid,from,dir);
    update();
  }

  /* ---------- 视角 ---------- */
  function refreshViewOptions(){
    const select=$('#jq-view');
    if(!select||!game)return;
    if(fogPid!=null&&!game.players[fogPid].alive)fogPid=null;
    const key=game.players.filter(p=>p.alive).map(p=>p.id).join(',');
    if(select.dataset.key===key)return;
    select.dataset.key=key;
    select.innerHTML=`<option value="">上帝视角</option>`+seats.filter(s=>game.players[s.pid].alive)
      .map(s=>`<option value="${s.pid}" ${fogPid===s.pid?'selected':''}>以 ${esc(s.name)} 视角</option>`).join('');
  }

  /* ---------- 渲染 ---------- */
  function atCursor(){return history[Math.min(cursor,history.length-1)]}
  let lastPaint=0;
  // Full DOM + canvas repaints are throttled; at high tick speeds the main thread must
  // stay free to relay worker messages, or every strategy looks like it timed out.
  function update(force=false){
    if(!alive||!game||phase==='setup')return;
    const now=performance.now();
    if(!force&&now-lastPaint<90)return;
    lastPaint=now;
    const snap=atCursor(),live=cursor===tick;
    $('#jq-phase').textContent=PHASE_TEXT[phase]||phase;
    $('#jq-start').textContent=phase==='running'?'暂停 Ⅱ':phase==='paused'?'继续对局 ▶':phase==='finished'?'对局已结束':'开始对局 ▶';
    $('#jq-start').disabled=!game||inFlight&&phase!=='running';
    $('#jq-step').disabled=isBusy()||phase==='finished'||!game;
    $('#jq-reset').disabled=isBusy();
    $('#jq-back').disabled=inFlight;
    $('#jq-seek').disabled=inFlight;$('#jq-seek').max=tick;$('#jq-seek').value=cursor;
    $('#jq-clock').textContent=`tick ${cursor} / ${game.maxTicks}${live?'':' · 回放中'}`;
    const noticeText=notice;$('#jq-notice').textContent=noticeText;$('#jq-notice').hidden=!noticeText;notice='';
    const aliveCount=snap.players.filter(p=>p.alive).length;
    const armyLeader=[...snap.players].sort((a,b)=>b.armyTotal-a.armyTotal)[0];
    $('#jq-stats').innerHTML=[['存活 / 参赛',`${aliveCount} / ${game.players.length}`,game.teamMode?`${new Set(snap.players.filter(p=>p.alive).map(p=>p.team)).size} 支队伍幸存`:'各自为战'],['统一时钟',String(cursor).padStart(4,'0'),`实际已运行 ${tick} tick`],['军力领先',seats[armyLeader.id].name,`${armyLeader.armyTotal.toLocaleString()} 军 · ${armyLeader.landTotal} 格`],['观察视角',fogPid!=null&&game.players[fogPid]&&game.players[fogPid].alive?seats[fogPid].name:'上帝视角',cursor<tick?'回放时显示全图':'迷雾按所选选手视野']].map(([a,b,c])=>`<div><span>${a}</span><strong>${esc(b)}</strong><small>${esc(c)}</small></div>`).join('');
    drawBoard($('#jq-board'),snap);
    const ordered=rank(snap);
    $('#jq-board-note').textContent=live?(game.finished?'最终排名':'实时'):`回放至 tick ${cursor}`;
    $('#jq-board-rows').innerHTML=ordered.map((p,i)=>{
      const seat=seats[p.id],sc=score(snap,p.id);
      const status=p.error?'策略错误':p.alive?'存活':`出局 @${p.eliminatedTick}`;
      return `<tr><td class="jq-place">${String(i+1).padStart(2,'0')}</td><td><span class="jq-player"><i style="background:${seat.color}"></i><button data-seat="${p.id}" ${seat.human?'disabled':''} title="${seat.human?'真人选手':esc(seat.name)+' 的策略源码'}">${esc(seat.name)}</button>${game.teamMode?`<em>${TEAM_NAMES[seat.team]}队</em>`:''}</span></td><td>${status}</td><td class="numeric">${p.armyTotal.toLocaleString()}</td><td class="numeric">${p.landTotal}</td><td class="numeric">${p.cities}</td><td class="numeric jq-total">${sc.total.toLocaleString()}</td></tr>`;
    }).join('');
    root.querySelectorAll('[data-seat]').forEach(b=>b.onclick=()=>{
      const seat=seats[Number(b.dataset.seat)];
      if(!seat.human)openDoc(`${seat.name} · 策略源码`,seat.entry.source);
    });
    const events=eventsLog.filter(e=>e.tick<=cursor).slice(-22).reverse();
    $('#jq-events').innerHTML=events.map(e=>`<div><time>${String(e.tick).padStart(4,'0')}</time><span>${esc(e.text)}</span></div>`).join('')||'<p>暂无战况</p>';
    const human=humanSeats().find(s=>s.pid===activeHumanPid);
    $('#jq-hint').innerHTML=human&&game.players[human.pid].alive
      ?`操作 <strong>${esc(human.name)}</strong>：点击己方格子选中并默认带走全部军队（留 1 军）；双击该格子改为带走一半；点击相邻格或按 WASD / 方向键移动；右键 / Esc 取消。已排队 ${humanQueues[human.pid].length}/${MAX_MOVES} 条指令。`
      :human?'你的将军已被攻陷，本局观战。':'观战模式：可拖动时间轴回看。';
    refreshViewOptions();
    renderResults(ordered);
  }
  function renderResults(ordered){
    const panel=$('#jq-results');
    if(!game.finished||cursor!==tick){panel.innerHTML=`<div class="jq-sectionline"><div><h3>${game.finished?'对局结束':'实时战况'}</h3><span>${game.finished?'拖动时间轴回看过程':'擒获全部敌方将军即获胜 · 满 10,000 分'}</span></div><span class="jq-formula">胜利 4000 + 击杀 1500 + 领土 2000 + 军力 2000 + 存活 500</span></div>`;return}
    const winnerSide=game.winnerTeam==null?'没有队伍幸存':game.teamMode?`队伍${TEAM_NAMES[game.winnerTeam]} 获胜`:`${seats.find(s=>s.team===game.winnerTeam)?.name||'—'} 获胜`;
    panel.innerHTML=`<div class="jq-sectionline"><div><h3>本轮结算</h3><span>共 ${tick} tick · ${esc(game.events.at(-1)||'')}</span></div><span class="jq-formula">胜利 4000 + 击杀 1500 + 领土 2000 + 军力 2000 + 存活 500</span></div>
      <div class="jq-settlement"><span class="jq-trophy">${game.winnerTeam!=null?'✦':'◇'}</span><div><strong>${esc(winnerSide)}</strong><p>成绩已计入战绩排行榜，可“同图重赛”验证复现性。</p></div></div>
      <div class="table-scroll"><table class="jq-ranking"><thead><tr><th>排名</th><th>选手</th><th>击杀</th><th class="numeric">胜利</th><th class="numeric">击杀分</th><th class="numeric">领土分</th><th class="numeric">军力分</th><th class="numeric">存活分</th><th class="numeric">总分</th></tr></thead><tbody>${ordered.map((p,i)=>{const seat=seats[p.id],sc=score(game,p.id);return `<tr><td class="jq-place">${String(i+1).padStart(2,'0')}</td><td><span class="jq-player"><i style="background:${seat.color}"></i>${esc(seat.name)}${game.teamMode?`<em>${TEAM_NAMES[seat.team]}队</em>`:''}</span></td><td>${p.kills}</td><td class="numeric">${sc.win}</td><td class="numeric">${sc.kills}</td><td class="numeric">${sc.land}</td><td class="numeric">${sc.army}</td><td class="numeric">${sc.survive}</td><td class="numeric jq-total">${sc.total.toLocaleString()}</td></tr>`}).join('')}</tbody></table></div>`;
  }

  /* ---------- 棋盘绘制 ---------- */
  const armyText=n=>n>=10000?Math.round(n/1000)+'k':n>=1000?(n/1000).toFixed(1).replace(/\.0$/,'')+'k':String(n);
  const initialOf=name=>{const first=(name||'').trim()[0]||'';return/[a-z]/.test(first)?first.toUpperCase():first};
  function drawCrown(c,x,y,s){
    c.beginPath();
    c.moveTo(x-s*.42,y+s*.30);c.lineTo(x-s*.42,y-s*.06);c.lineTo(x-s*.20,y+s*.08);
    c.lineTo(x,y-s*.34);c.lineTo(x+s*.20,y+s*.08);c.lineTo(x+s*.42,y-s*.06);c.lineTo(x+s*.42,y+s*.30);
    c.closePath();c.fill();
    c.fillRect(x-s*.46,y+s*.34,s*.92,s*.12);
  }
  function drawFortress(c,x,y,s){
    c.beginPath();
    c.moveTo(x-s*.5,y+s*.32);c.lineTo(x-s*.5,y-s*.02);c.lineTo(x-s*.34,y-s*.02);c.lineTo(x-s*.34,y-s*.3);
    c.lineTo(x-s*.13,y-s*.3);c.lineTo(x-s*.13,y-s*.02);c.lineTo(x+s*.13,y-s*.02);c.lineTo(x+s*.13,y-s*.3);
    c.lineTo(x+s*.34,y-s*.3);c.lineTo(x+s*.34,y-s*.02);c.lineTo(x+s*.5,y-s*.02);c.lineTo(x+s*.5,y+s*.32);
    c.closePath();c.fill();
    c.lineWidth=1;c.strokeStyle='rgba(0,0,0,.3)';c.stroke();
  }
  function drawMountain(c,x,y,s){
    c.beginPath();
    c.moveTo(x-s*.56,y+s*.34);c.lineTo(x-s*.16,y-s*.36);c.lineTo(x+s*.02,y+s*.02);
    c.lineTo(x+s*.22,y-s*.26);c.lineTo(x+s*.56,y+s*.34);
    c.closePath();c.fill();
  }
  function drawBoard(canvas,snap){
    if(!canvas||!snap)return;
    const w=snap.width,h=snap.height;
    // Fill the available width at device resolution; never shrink below readable
    // cells — the wrap scrolls instead. Bigger area (e.g. fullscreen) means bigger cells.
    const wrap=canvas.parentElement;
    const available=Math.max(260,(wrap?wrap.clientWidth:760)-24);
    const cell=Math.max(15,Math.min(28,Math.floor(available/w)));
    const cssWidth=cell*w,cssHeight=cell*h;
    const dpr=Math.min(2.5,window.devicePixelRatio||1);
    canvas.style.width=cssWidth+'px';canvas.style.height=cssHeight+'px';
    const backingW=Math.round(cssWidth*dpr),backingH=Math.round(cssHeight*dpr);
    if(canvas.width!==backingW||canvas.height!==backingH){canvas.width=backingW;canvas.height=backingH}
    const c=canvas.getContext('2d');
    c.setTransform(dpr,0,0,dpr,0,0);
    const viewPid=fogPid!=null&&cursor===tick&&game&&game.players[fogPid]&&game.players[fogPid].alive?fogPid:null;
    const useFog=viewPid!=null;
    const mask=useFog?visibleMask(game,viewPid):null;
    const seen=useFog?game.seen[viewPid]:null;
    c.fillStyle='#23282c';c.fillRect(0,0,cssWidth,cssHeight);
    c.textAlign='center';c.textBaseline='middle';
    const gap=1;
    const fitFont=(label,base)=>{
      let size=Math.max(7,base);
      c.font=`bold ${size}px system-ui`;
      const width=c.measureText(label).width;
      if(width>cell-3){size=Math.max(6,size*(cell-3)/width);c.font=`bold ${size}px system-ui`}
    };
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const p=y*w+x,px=x*cell,py=y*cell,tile=cell-gap*2;
      const tx=px+gap,tw=tile;
      const visible=!useFog||mask[p]===1,known=!useFog||seen[p]===1;
      if(useFog&&!known){c.fillStyle='#10151a';c.fillRect(tx,py+gap,tw,tile);continue}
      const terrain=snap.terrain[p],owner=snap.owner[p],army=snap.army[p];
      const cx=px+cell/2,cy=py+cell/2;
      if(terrain===TERRAIN.MOUNTAIN){
        c.fillStyle=visible?'#2f363a':'#242a2e';c.fillRect(tx,py+gap,tw,tile);
        c.fillStyle=visible?'#6b787c':'#414a4e';
        drawMountain(c,cx,cy+(visible?cell*.03:0),cell*.82);
        continue;
      }
      const owned=visible&&owner>=0;
      if(owned)c.fillStyle=seats[owner].color;
      else if(terrain===TERRAIN.CITY)c.fillStyle=visible?'#cfc7b4':'#4c473d';
      else c.fillStyle=visible?'#e9e6da':'#57544b';
      c.fillRect(tx,py+gap,tw,tile);
      if(!visible){ // 已侦察但视野外：压暗，只保留地形轮廓
        c.fillStyle='rgba(16,21,26,.42)';c.fillRect(tx,py+gap,tw,tile);
      }
      const ink=owned?'rgba(255,255,255,.94)':'rgba(52,48,38,.85)';
      const iconInk=owned?'rgba(255,255,255,.96)':visible?'rgba(52,48,38,.72)':'rgba(210,206,196,.5)';
      const hasIcon=terrain!==TERRAIN.EMPTY;
      if(terrain===TERRAIN.GENERAL){ // 将军位置一旦侦察过就保持皇冠标记
        c.fillStyle=iconInk;
        drawCrown(c,cx,py+cell*.24,cell*.56);
      }else if(terrain===TERRAIN.CITY){
        c.fillStyle=iconInk;
        drawFortress(c,cx,py+cell*.25,cell*.66);
      }
      if(visible&&army>0){
        const label=armyText(army);
        if(owned){c.shadowColor='rgba(0,0,0,.45)';c.shadowBlur=Math.max(1.5,cell*.09)}
        c.fillStyle=ink;
        fitFont(label,cell*(label.length>3?.3:label.length>2?.36:.46));
        c.fillText(label,cx,py+cell*(hasIcon?.62:.52));
        if(owned&&cell>=15){ // 很淡的模型首字母水印
          c.fillStyle='rgba(255,255,255,.42)';
          c.font=`${Math.max(7,cell*.24)}px system-ui`;
          c.fillText(initialOf(seats[owner].name),cx,py+cell*(hasIcon?.85:.8));
        }
        c.shadowBlur=0;
      }
    }
    // 真人选中与排队指令
    const humanSeat=humanSeats().find(s=>s.pid===activeHumanPid&&snap.players[s.pid]?.alive);
    if(humanSeat&&cursor===tick){
      const selection=selections[activeHumanPid];
      if(selection){
        const x=selection.idx%w,y=(selection.idx/w)|0;
        c.strokeStyle='#f0c05a';c.lineWidth=2.5;
        if(selection.half)c.setLineDash([4,3]); // 双击的半军模式
        c.strokeRect(x*cell+1,y*cell+1,cell-2,cell-2);
        c.setLineDash([]);
      }
      for(const move of humanQueues[activeHumanPid]){
        const [dx,dy]=DIR_ARROWS[move.dir]||[0,0];
        const x=(move.from.x+.5)*cell+dx*cell*.28,y=(move.from.y+.5)*cell+dy*cell*.28;
        c.fillStyle='#f0c05a';c.beginPath();c.arc(x,y,Math.max(2,cell*.09),0,Math.PI*2);c.fill();
      }
    }
  }

  /* ---------- 战绩 ---------- */
  function recordSeries(){
    for(const seat of seats){
      const sc=score(game,seat.pid),p=game.players[seat.pid];
      const row=series.rows[seat.entry.id]||{name:seat.name,color:seat.color,kind:KIND_LABEL[seat.kind]||seat.kind,rounds:0,wins:0,kills:0,points:0};
      row.rounds++;row.kills+=p.kills;row.points+=sc.total;
      if(game.winnerTeam!=null&&seat.team===game.winnerTeam&&!p.error)row.wins++;
      series.rows[seat.entry.id]=row;
    }
    persistSeries();
    const panel=root.querySelector('#jq-series-body');
    if(panel)panel.innerHTML=seriesRows();
  }
  function seriesRows(){
    const rows=Object.entries(series.rows).map(([id,r])=>({id,...r})).sort((a,b)=>b.points-a.points||b.wins-a.wins||a.name.localeCompare(b.name));
    if(!rows.length)return '<p class="jq-series-empty">还没有完成过的对局。每完成一局，参赛者自动记入战绩。</p>';
    return `<div class="table-scroll"><table class="jq-ranking"><thead><tr><th>#</th><th>选手</th><th>身份</th><th class="numeric">局数</th><th class="numeric">胜场</th><th class="numeric">击杀</th><th class="numeric">总积分</th><th class="numeric">场均</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td class="jq-place">${String(i+1).padStart(2,'0')}</td><td><span class="jq-player"><i style="background:${/^#[0-9a-f]{6}$/i.test(r.color)?r.color:'#8a9a5b'}"></i>${esc(r.name)}</span></td><td>${esc(r.kind||'')}</td><td class="numeric">${r.rounds}</td><td class="numeric">${r.wins}</td><td class="numeric">${r.kills}</td><td class="numeric jq-total">${r.points.toLocaleString()}</td><td class="numeric">${Math.round(r.points/Math.max(1,r.rounds)).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderSeries(inSetup){
    return `<section class="jq-panel" id="jq-series"><div class="jq-sectionline"><div><h3>战绩排行榜</h3><span>跨对局累计 · 保存在本浏览器</span></div><div class="jq-entry-actions"><button class="button subtle" id="jq-series-clear">清空战绩</button></div></div><div id="jq-series-body">${seriesRows()}</div></section>`;
  }
  function bindSeries(){
    const clear=root.querySelector('#jq-series-clear');
    if(clear)clear.onclick=()=>{series={rows:{}};persistSeries();const body=root.querySelector('#jq-series-body');if(body)body.innerHTML=seriesRows()};
  }

  function exportRound(){
    const data={version:RULES_VERSION,mode,seed,level,tick,maxTicks:game.maxTicks,winnerTeam:game.winnerTeam,
      seats:seats.map(s=>({name:s.name,kind:KIND_LABEL[s.kind]||s.kind,team:s.team,human:s.human,source:s.human?undefined:s.entry.source})),
      players:game.players,scores:seats.map(s=>score(game,s.pid)),events:eventsLog};
    download(`junqi-${seed.replace(/[^a-zA-Z0-9_-]/g,'_')}-${mode}-${level}.json`,JSON.stringify(data,null,2),'application/json');
  }

  const onResize=()=>{if(alive&&game&&phase!=='setup')drawBoard($('#jq-board'),atCursor())};
  const onFullscreen=()=>onResize();
  const resize=new ResizeObserver(onResize);
  resize.observe(root);
  document.addEventListener('keydown',onKeydown);document.addEventListener('fullscreenchange',onFullscreen);
  picked=new Map(candidates().map(e=>[e.id,{on:e.kind!=='local'}]));
  trimPicks(); // 默认：正式提交与基准参赛（超 16 人时裁剪），本地导入手动勾选
  renderSetup();
  return ()=>{alive=false;epoch++;clearTimeout(timer);stopWorkers();resize.disconnect();document.removeEventListener('keydown',onKeydown);document.removeEventListener('fullscreenchange',onFullscreen);$('#jq-upload')?.close();$('#jq-human')?.close()};
}
