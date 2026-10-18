import {esc,time} from './ui.js';

export function renderHome(catalog) {
  const activeModels=catalog.models.filter(model=>catalog.submissions.some(s=>s.model===model.id));
  const latest=catalog.submissions.flatMap(submission=>{
    const revision=submission.revisions.at(-1);
    return revision?[{submission,revision}]:[];
  }).sort((a,b)=>b.revision.effective_from.localeCompare(a.revision.effective_from)).slice(0,8);
  return `<p class="home-summary">${catalog.tasks.length} 项任务 · ${catalog.submissions.length} 个提交</p>
    <section class="home-section" aria-labelledby="recent-title">
      <h2 id="recent-title">最近提交</h2>
      ${latest.length?`<div class="table-scroll"><table><thead><tr><th>任务</th><th>模型</th><th>版本</th><th>日期</th></tr></thead><tbody>${latest.map(({submission:s,revision:r})=>`<tr><td><a class="content-link" href="#task=${s.task}&model=${encodeURIComponent(s.model)}">${esc(catalog.tasks.find(t=>t.id===s.task)?.title||s.task)}</a></td><td>${esc(catalog.models.find(m=>m.id===s.model)?.name||s.model)}</td><td>${esc(r.id)}</td><td class="muted">${time(r.effective_from)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="home-empty">暂无提交。</p>'}
    </section>
    ${activeModels.length?`<section class="home-section" aria-labelledby="models-title">
      <h2 id="models-title">已提交模型</h2>
      <div class="table-scroll"><table><thead><tr><th>名称</th><th class="numeric">提交数</th></tr></thead><tbody>${activeModels.map(model=>`<tr><td>${esc(model.name)}</td><td class="numeric">${catalog.submissions.filter(s=>s.model===model.id).length}</td></tr>`).join('')}</tbody></table></div>
    </section>`:''}`;
}
