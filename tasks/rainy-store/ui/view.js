import {esc,time} from '../../ui.js';
const versions=new Map();
const policy=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;

export function preview(root,{submission}) {
  const revision=submission.revisions.at(-1);
  if(!revision){root.textContent='暂无作品';return}
  const frame=document.createElement('iframe');
  frame.className='html-thumbnail';frame.title='作品缩略预览';frame.sandbox='allow-scripts';frame.tabIndex=-1;
  frame.referrerPolicy='no-referrer';frame.loading='lazy';frame.srcdoc=policy+revision.source;
  root.append(frame);
  const resize=new ResizeObserver(()=>{frame.style.transform=`scale(${root.clientWidth/960})`});resize.observe(root);
  return ()=>resize.disconnect();
}
export function mount(root,ctx) {
  const {task,model,submission,openDoc}=ctx;
  let showSource=false;
  function draw() {
    const revision=submission?.revisions.find(r=>r.id===versions.get(model.id))||submission?.revisions.at(-1);
    ctx.setRevision?.(revision?.id);
    root.innerHTML=`<div class="view-toolbar"><span class="view-meta">${esc(submission?.model_version||model.name)} <span class="badge">${submission?'已提交':'等待提交'}</span></span><div class="view-actions"><button class="button subtle" id="prompt">提示词</button>${revision?`<select class="version-select" aria-label="作品版本">${submission.revisions.map(r=>`<option value="${esc(r.id)}" ${r.id===revision.id?'selected':''}>${esc(r.id)}</option>`).join('')}</select><button class="button" id="source">${showSource?'预览作品':'查看源码'}</button>`:''}</div></div>${revision?`<div class="panel html-stage">${showSource?`<pre>${esc(revision.source)}</pre>`:`<iframe title="${esc(model.name)} · ${esc(task.title)}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`}</div><p class="small-note">${esc(revision.note)} · ${time(revision.effective_from)}</p>`:`<div class="empty-state"><strong>暂无作品</strong><p>${task.payload.prompt_text.includes('待填写。')?'统一提示词尚未填写。':'提交 HTML 文件后可在这里预览。'}</p></div>`}`;
    root.querySelector('#prompt').onclick=()=>openDoc(task.title+' · 提示词',task.payload.prompt_text);
    const select=root.querySelector('select');
    if(select)select.onchange=()=>{versions.set(model.id,select.value);draw()};
    const button=root.querySelector('#source');if(button)button.onclick=()=>{showSource=!showSource;draw()};
    const frame=root.querySelector('iframe');
    if(frame)frame.srcdoc=policy+revision.source;
  }
  draw();
}
