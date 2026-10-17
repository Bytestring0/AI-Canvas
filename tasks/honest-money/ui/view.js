import {esc,money,percent,time,download} from '../../ui.js';

export function preview(root,{submission}) {
  const sessions=submission.run?.sessions.slice(-60)||[];
  if(!sessions.length){root.innerHTML='<span class="preview-pending">等待运行</span>';return}
  const last=sessions.at(-1),low=Math.min(...sessions.map(s=>s.equity)),high=Math.max(...sessions.map(s=>s.equity));
  const span=Math.max(high-low,1);
  const points=sessions.map((s,i)=>`${8+i/Math.max(1,sessions.length-1)*264},${68-(s.equity-low)/span*52}`).join(' ');
  root.innerHTML=`<div class="trade-thumbnail"><span>¥ ${money(last.equity)}</span><small>${percent(last.return)}</small><svg viewBox="0 0 280 80" aria-hidden="true"><polyline points="${points}" fill="none" stroke="#555" stroke-width="1.5"/></svg></div>`;
}

export function mount(root,ctx) {
  const {task,model,submission,submissions,models,openDoc}=ctx;
  const env=task.payload.environment;
  let tab='events',compare=false,observer;
  const current=submission?.run;
  ctx.setRevision?.(current?.state.active_revision||submission?.revisions.at(-1)?.id);
  const last=current?.sessions.at(-1);
  const comparable=submissions.filter(s=>s.run?.sessions.length);

  function graph() {
    const series=compare?comparable:(last?[submission]:[]);
    const rows=series.flatMap(s=>s.run.sessions.slice(-240));
    const stamps=[...new Set(rows.map(r=>r.timestamp))].sort();
    const width=Math.max(270,root.clientWidth-42),left=55,right=width-15;
    let low=Math.min(env.initial_cash,...rows.map(r=>r.equity));
    let high=Math.max(env.initial_cash,...rows.map(r=>r.equity));
    const pad=Math.max((high-low)*.2,env.initial_cash*.002);low-=pad;high+=pad;
    const x=t=>left+(stamps.indexOf(t)/Math.max(1,stamps.length-1))*(right-left);
    const y=v=>180-(v-low)/(high-low)*155;
    const grid=[0,1,2,3,4].map(i=>`<line x1="${left}" x2="${right}" y1="${25+i*38.75}" y2="${25+i*38.75}"/><text x="0" y="${29+i*38.75}">${money(high-(high-low)*i/4)}</text>`).join('');
    const curves=series.map(s=>{
      const color=models.find(m=>m.id===s.model).color;
      const samples=s.run.sessions.slice(-240);
      return `<path d="${samples.map((r,i)=>`${i?'L':'M'}${x(r.timestamp)},${y(r.equity)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>${samples.map(r=>`<circle class="point" cx="${x(r.timestamp)}" cy="${y(r.equity)}" r="2.5" fill="${color}"><title>${esc(s.model)} · ${time(r.timestamp)} · ¥${money(r.equity)} · ${esc(r.revision)}</title></circle>`).join('')}${samples.filter(r=>r.events.some(e=>e.type==='revision')).map(r=>`<line class="revision-line" x1="${x(r.timestamp)}" x2="${x(r.timestamp)}" y1="15" y2="185"><title>${esc(r.revision)} · ${time(r.timestamp)}</title></line>`).join('')}`;
    }).join('');
    const labels=[...new Set([stamps[0],stamps.at(-1)])].filter(Boolean).map((stamp,i)=>`<text x="${x(stamp)}" y="209" text-anchor="${i?'end':'start'}">${stamp.slice(5,10)} ${stamp.slice(11,16)}</text>`).join('');
    return `<svg class="trade-chart" viewBox="0 0 ${width} 225" role="img" aria-label="按实际采集时刻记录的净值，虚线标识策略更新">${grid}${curves}${labels}</svg>`;
  }

  function details() {
    let body='';
    if(tab==='positions') {
      const positions=Object.entries(current.state.positions);
      if(positions.length)body=`<div class="table-scroll"><table><thead><tr><th>股票</th><th>股数 / 可卖</th><th>持仓成本</th><th>最新估值</th></tr></thead><tbody>${positions.map(([symbol,p])=>`<tr><td>${esc(symbol)}</td><td>${p.quantity} / ${p.sellable}</td><td>¥ ${money(p.cost)}</td><td>¥ ${money(p.last_price)}</td></tr>`).join('')}</tbody></table></div>`;
    }else{
      const events=current.sessions.flatMap(s=>s.events.filter(e=>tab!=='revisions'||e.type==='revision').map(e=>({...e,timestamp:s.timestamp}))).reverse().slice(0,80);
      if(events.length)body=`<div class="trade-events">${events.map(e=>{
        let description=e.message||'';
        if(e.type==='filled')description=`${e.side==='buy'?'买入':'卖出'} ${e.symbol} · ${e.quantity} 股 @ ¥${money(e.price)} · 费用 ¥${money(e.fee)} · ${e.revision}`;
        if(e.type==='signal')description=`下轮委托 ${e.orders.length} 笔 · ${e.commentary}`;
        if(e.type==='revision')description=`策略更新 ${e.previous||'初次'} → ${e.revision} · ${e.note}`;
        if(e.type==='interest')description=`借款利息 ¥${money(e.amount)}`;
        if(e.type==='corporate_action')description=`公司行为对账 ${e.symbol} · 入账 ¥${money(e.cash_credit)} · ${e.reference}`;
        return `<div class="trade-event"><time>${time(e.timestamp)}</time><div class="event-content">${esc(description)}</div></div>`;
      }).join('')}</div>`;
    }
    return body||'<div class="empty-inline">暂无记录</div>';
  }

  function draw() {
    observer?.disconnect();
    root.innerHTML=`<div class="view-toolbar"><span class="view-meta">每 10 分钟更新 <span class="badge">${last?(last.status==='ok'?'运行中':'策略报错'):submission?'等待运行':'等待提交'}</span></span><div class="view-actions"><button class="button subtle" id="environment">完整提示词</button>${last?`<button class="button" id="compare">${compare?'收起对比':'对比模型'}</button>`:''}</div></div>${last?`<div class="trade-metrics">${[['净资产',`¥ ${money(last.equity)}`],['累计收益',percent(last.return)],['当前债务',`¥ ${money(last.debt)}`],['最大回撤',percent(last.max_drawdown)]].map(([label,value])=>`<div class="trade-metric"><label>${label}</label><strong>${value}</strong></div>`).join('')}</div><div class="panel"><div class="panel-head"><span>资产净值 <span class="muted">/ CNY</span></span><span class="trade-legend">${(compare?comparable:[submission]).map(s=>{const m=models.find(m=>m.id===s.model);return `<span><i class="dot" style="background:${m.color}"></i>${esc(m.name)}</span>`}).join('')}</span></div><div class="trade-chart-box" id="chart"></div><div class="chart-note">实际采集 ${time(last.timestamp)} · 最近 240 轮 · 虚线为策略更新</div></div>${compare?`<div class="panel comparison table-scroll"><table><thead><tr><th>模型</th><th>净资产</th><th>收益</th><th>记录区间</th></tr></thead><tbody>${comparable.map(s=>{const l=s.run.sessions.at(-1);return `<tr><td>${esc(models.find(m=>m.id===s.model).name)}</td><td>¥ ${money(l.equity)}</td><td>${percent(l.return)}</td><td>${time(s.run.sessions[0].timestamp)} → ${time(l.timestamp)}</td></tr>`}).join('')}</tbody></table></div>`:''}<div class="panel trade-detail"><div class="tabs">${[['events','交易日志'],['positions','持仓'],['revisions','策略迭代']].map(([value,title])=>`<button class="tab ${tab===value?'active':''}" data-tab="${value}">${title}</button>`).join('')}<span class="trade-tab-caption">${esc(submission.model_version)} · ${esc(last.revision)}</span></div>${details()}</div><div class="trade-exports"><button class="button subtle" data-export="json">完整日志</button><button class="button subtle" data-export="csv">成交 CSV</button><button class="button subtle" data-export="review">AI 复盘包</button></div>`:`<div class="empty-state"><strong>${submission?'暂无运行记录':'暂无策略提交'}</strong><p>${submission?'策略已提交，等待下一次运行。':'提交策略文件后，运行结果将显示在这里。'}</p></div>`}`;
    root.querySelector('#environment').onclick=()=>openDoc(task.title+' · 完整提示词',task.payload.prompt_text);
    const help=root.querySelector('#getting-started');if(help)help.onclick=()=>openDoc(task.title+' · 提交约定',task.readme_text);
    const button=root.querySelector('#compare');if(button)button.onclick=()=>{compare=!compare;draw()};
    root.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.tab;draw()});
    root.querySelectorAll('[data-export]').forEach(button=>button.onclick=()=>exportRun(button.dataset.export));
    const chart=root.querySelector('#chart');
    if(chart){chart.innerHTML=graph();observer=new ResizeObserver(()=>{chart.innerHTML=graph()});observer.observe(root)}
  }

  function exportRun(kind) {
    if(kind==='json')download(`${model.id}-run.json`,JSON.stringify(current,null,2),'application/json');
    if(kind==='csv') {
      const rows=[['timestamp','revision','side','symbol','quantity','price','fee','quote_time','reason']];
      current.sessions.forEach(s=>s.events.filter(e=>e.type==='filled').forEach(e=>rows.push([s.timestamp,e.revision,e.side,e.symbol,e.quantity,e.price,e.fee,e.quote_time,e.reason||''])));
      const csv=rows.map(row=>row.map(v=>'"'+String(v).replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');
      download(`${model.id}-trades.csv`,'\ufeff'+csv,'text/csv;charset=utf-8');
    }
    if(kind==='review'){
      const previous=submission.revisions.find(r=>r.id===current.state.active_revision)||submission.revisions.at(-1);
      download(`${model.id}-review.md`,`# 策略复盘包\n\n你无法访问项目文件；本包已经附上完整协议、真实运行日志及当前策略全文。请分析后直接交付新版 strategy.py 与 README.md，保留原账户和旧版本。新版生效时间必须晚于 ${last.timestamp}，由操作者登记。不要将已见行情回放冒充未来表现，不要要求补充仓库文件。\n\n## 完整生成提示词\n\n${task.payload.prompt_text}\n\n## 本次实际环境\n\n\`\`\`json\n${JSON.stringify(env,null,2)}\n\`\`\`\n\n## 全部运行记录\n\n\`\`\`json\n${JSON.stringify(current,null,2)}\n\`\`\`\n\n## 当前策略全文（${previous.id}）\n\n\`\`\`python\n${previous.source}\n\`\`\`\n\n## 当前策略说明\n\n${previous.readme}`,'text/markdown;charset=utf-8');
    }
  }
  draw();
  return ()=>observer?.disconnect();
}
