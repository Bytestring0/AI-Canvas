import {esc} from './ui.js';
import {renderHome} from './home.js';

let catalog,taskId,modelId,revision=0;
let cleanups=[];
const $=selector=>document.querySelector(selector);
const moduleCache=new Map();

function selection() {
  const query=new URLSearchParams(location.hash.slice(1));
  taskId=catalog.tasks.some(t=>t.id===query.get('task'))?query.get('task'):null;
  modelId=catalog.submissions.some(s=>s.task===taskId&&s.model===query.get('model'))?query.get('model'):null;
}

function openDoc(title,body) {
  $('#doc-title').textContent=title;$('#doc-body').textContent=body;$('#docs').showModal();
}

async function render() {
  const current=++revision;
  cleanups.forEach(cleanup=>cleanup?.());cleanups=[];
  const task=catalog.tasks.find(t=>t.id===taskId);
  const model=catalog.models.find(m=>m.id===modelId);
  const all=task?catalog.models.flatMap(model=>{const entry=catalog.submissions.find(s=>s.task===taskId&&s.model===model.id);return entry?[entry]:[]}):[];
  const showingResult=Boolean(task&&model);
  const submission=all.find(entry=>entry.model===modelId);
  let displayedRevision=submission?.revisions.at(-1);
  const setRevision=id=>{displayedRevision=submission?.revisions.find(entry=>entry.id===id)||submission?.revisions.at(-1)};
  document.title=showingResult?`${model.name} · ${task.title} · AI Canvas`:task?`${task.title} · AI Canvas`:'AI Canvas';
  const content=showingResult
    ? '<div class="detail-content"><section id="task-view" aria-label="模型成果"></section></div>'
    : task?`<section id="task-gallery" aria-label="模型成果">${all.length?`<div class="model-grid">${all.map(s=>{const m=catalog.models.find(m=>m.id===s.model);return `<article class="model-card"><a class="card-open" data-model="${m.id}" href="#task=${taskId}&model=${m.id}" aria-label="查看 ${esc(m.name)} 的结果"><div class="card-preview" data-preview="${m.id}" aria-hidden="true"></div><div class="card-caption"><strong>${esc(m.name)}</strong><span>${esc(s.revisions.at(-1)?.id||'')}</span></div><div class="card-version">${esc(s.model_version)}</div></a></article>`}).join('')}</div>`:'<p class="home-empty">暂无提交。</p>'}</section>`
    : `<div id="home-view">${renderHome(catalog)}</div>`;
  $('#app').innerHTML=`<div class="workspace"><aside class="sidebar" aria-label="任务导航"><a class="brand" href="#">AI Canvas</a><nav><a href="#" class="home-link ${!task?'active':''}" ${!task?'aria-current="page"':''}>主页</a><div class="nav-label">任务</div>${catalog.tasks.map(t=>`<a href="#task=${t.id}" class="task-link ${t.id===taskId?'active':''}" ${t.id===taskId?'aria-current="page"':''}>${esc(t.title)}</a>`).join('')}</nav><div class="sidebar-bottom"><button class="side-action" id="guide">使用说明</button></div></aside><div class="mobile-shade" id="shade"></div><main class="main${showingResult?' detail-mode':''}"><div class="mobile-topbar"><button id="menu" class="button subtle" aria-label="打开导航" aria-expanded="false">目录</button><a href="#">AI Canvas</a></div><header class="page-heading${showingResult?' detail-heading':''}"><div>${showingResult?`<a class="back-link" href="#task=${taskId}">← 返回列表</a>`:''}<h1 tabindex="-1">${showingResult?esc(model.name):task?esc(task.title):'主页'}</h1></div><div class="page-actions">${showingResult?'<button class="button subtle" id="view-readme">查看 README</button>':''}<button class="button subtle" id="readme">${task?'任务说明':'使用说明'}</button></div></header>${content}</main></div><dialog id="docs"><div class="dialog-head"><h2 id="doc-title"></h2><button class="icon-button" id="close-doc" aria-label="关闭">×</button></div><pre id="doc-body"></pre></dialog>`;
  $('#readme').onclick=()=>openDoc(task?task.title:'使用说明',task?task.readme_text:catalog.guide_text);
  if(showingResult)$('#view-readme').onclick=()=>openDoc(`${model.name} · ${displayedRevision?.id||''} · README`,displayedRevision?.readme||'当前版本未提供 README。');
  $('#guide').onclick=()=>openDoc('使用说明',catalog.guide_text);
  $('#close-doc').onclick=()=>$('#docs').close();
  const closeNavigation=()=>{$('.workspace').classList.remove('nav-open');$('#menu').setAttribute('aria-expanded','false')};
  $('#menu').onclick=()=>{const open=$('.workspace').classList.toggle('nav-open');$('#menu').setAttribute('aria-expanded',String(open))};
  $('#shade').onclick=closeNavigation;
  document.onkeydown=event=>{if(event.key==='Escape')closeNavigation()};
  window.scrollTo(0,0);
  if(showingResult)$('h1').focus({preventScroll:true});
  $('#task-style')?.remove();
  if(!task)return;
  if(!all.length)return;
  let styles=$('#task-style');
  if(!styles){styles=document.createElement('link');styles.id='task-style';styles.rel='stylesheet';document.head.append(styles)}
  const moduleUrl=new URL(task.view_url,location.href);
  styles.href=new URL('./styles.css',moduleUrl).href;
  try {
    if(!moduleCache.has(task.id))moduleCache.set(task.id,import(moduleUrl.href));
    const view=await moduleCache.get(task.id);
    if(current!==revision)return;
    if(model){
      cleanups.push(view.mount($('#task-view'),{task,model,models:catalog.models,submissions:all,submission,openDoc,setRevision}));
    }else for(const submission of all){
      const preview=$(`[data-preview="${submission.model}"]`);
      const context={task,model:catalog.models.find(m=>m.id===submission.model),models:catalog.models,submissions:all,submission,openDoc};
      if(view.preview)cleanups.push(view.preview(preview,context));
      else preview.textContent='查看结果';
    }
  }catch(error){if(current===revision)$(model?'#task-view':'#task-gallery').innerHTML=`<div class="empty-state"><strong>任务组件加载失败</strong><p>${esc(error.message)}</p></div>`}
}

try {
  const response=await fetch('./data/catalog.json');
  if(!response.ok)throw Error(`HTTP ${response.status}`);
  catalog=await response.json();selection();await render();
}catch(error){$('#app').innerHTML=`<div class="loading">框架加载失败：${esc(error.message)}</div>`}
window.addEventListener('hashchange',()=>{if(catalog){selection();render()}});
