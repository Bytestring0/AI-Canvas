// Optional integration suite. Run a built site and install Playwright before using this command.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.MAZE_PLAYWRIGHT_MODULE||'playwright');
const url=process.env.MAZE_BASE_URL||'http://127.0.0.1:4173/';
let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.MAZE_BROWSER_PATH?{executablePath:process.env.MAZE_BROWSER_PATH}:{})});await mkdir('qa',{recursive:true})});
after(async()=>{await browser?.close()});

async function open(viewport={width:1440,height:1100}){
  const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  // Isolate the baselines from future real submissions without changing the built site.
  await page.route('**/data/catalog.json',async route=>{
    const response=await route.fetch(),catalog=await response.json();
    catalog.submissions=catalog.submissions.filter(s=>s.task!=='maze');
    await route.fulfill({response,json:catalog});
  });
  await page.goto(url+'#task=maze');await page.locator('.mz-card').first().waitFor();
  return {context,page,errors};
}
async function add(page,name,source,hunterSource){
  await page.locator('#mz-import').click();await page.locator('[name=name]').fill(name);
  await page.locator('[name=files]').setInputFiles([
    {name:'strategy.js',mimeType:'text/javascript',buffer:Buffer.from(source)},
    {name:'hunter.js',mimeType:'text/javascript',buffer:Buffer.from(hunterSource)},
    {name:'README.md',mimeType:'text/markdown',buffer:Buffer.from('Disposable integration test entry')},
  ]);
  await page.locator('#mz-upload-form button[type=submit]').click();
  await page.locator('#mz-upload').waitFor({state:'hidden'});
}
const waitHunter='function decide(o){return {actions:o.hunters.map(h=>({id:h.id,action:"wait"}))}}';

async function selectHunterSeed(page,name){
  const seed=await page.evaluate(async name=>{
    const [{chooseHunter},{hunterCandidates},{EXAMPLES}]=await Promise.all([
      import('./task-ui/maze/engine.js'),import('./task-ui/maze/hunters.js'),import('./task-ui/maze/examples.js'),
    ]);
    const local=JSON.parse(localStorage.getItem('ai-canvas-maze-entries-v1')||'[]');
    const pool=hunterCandidates([...(document.querySelector('#mz-demos').checked?EXAMPLES:[]),...local]);
    const level=document.querySelector('#mz-level').value;
    for(let i=0;i<1000;i++){
      const seed='browser-hunter-'+i;
      if(chooseHunter(pool,`${seed}:${level}`).name===name)return seed;
    }
    throw Error('Could not select the requested hunter');
  },name);
  await page.locator('#mz-seed').fill(seed);await page.locator('#mz-seed').dispatchEvent('change');
  assert.equal(await page.locator('#mz-hunter-info').textContent(),name);
}

test('simultaneous full race, deterministic rematch, replay, export and mobile layout',async()=>{
  const {context,page,errors}=await open();
  try{
    assert.equal(await page.locator('.mz-card').count(),3);
    await page.screenshot({path:'qa/maze-desktop.png',fullPage:true});
    await page.locator('#mz-step').click();
    await page.waitForFunction(()=>document.querySelector('#mz-clock')?.textContent.startsWith('1 /'));
    assert.deepEqual(await page.locator('[data-status]').allTextContents(),['探索中','探索中','探索中']);
    await page.locator('[data-focus]').first().click();await page.locator('#mz-large').waitFor();
    await page.locator('#mz-speed').selectOption('16');await page.locator('#mz-start').click();
    await page.waitForFunction(()=>document.querySelector('#mz-phase')?.textContent==='比赛结束',null,{timeout:45000});
    const result=await page.locator('.mz-ranking tbody').textContent();
    const download=page.waitForEvent('download');await page.locator('#mz-export').click();await (await download).saveAs('qa/maze-round.json');
    await page.screenshot({path:'qa/maze-finished.png',fullPage:true});
    await page.locator('#mz-seek').fill('3');await page.locator('#mz-seek').dispatchEvent('input');
    assert((await page.locator('#mz-clock').textContent()).includes('回放'));
    await page.locator('#mz-reset').click();await page.locator('#mz-start').click();
    await page.waitForFunction(()=>document.querySelector('#mz-phase')?.textContent==='比赛结束',null,{timeout:45000});
    assert.equal(await page.locator('.mz-ranking tbody').textContent(),result);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'qa/maze-mobile.png',fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#mz-reset').click();await page.locator('#mz-step').click();
    await page.waitForFunction(()=>document.querySelector('#mz-clock')?.textContent.startsWith('1 /'));
    await page.locator('#menu').click();await page.locator('a[href="#task=rainy-store"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('iframe[title="迷宫策略隔离执行器"]').length===0);
    assert.deepEqual(errors,[]);
  }finally{await context.close()}
});

test('worker isolation rejects invalid actions, infinite loops, nonfinite memory, network and storage',async()=>{
  const {context,page,errors}=await open();
  try{
    const results=await page.evaluate(async()=>{
      const {StrategySandbox}=await import('./task-ui/maze/sandbox.js');const results=[];
      for(const [label,source] of [
        ['valid','function decide(o){return {action:"wait",memory:{seen:2}}}'],
        ['badAction','function decide(){return {action:"teleport"}}'],
        ['infinite','function decide(){while(true){}}'],
        ['initLoop','while(true){};function decide(){return {action:"wait"}}'],
        ['nonfinite','function decide(){return {action:"wait",memory:NaN}}'],
        ['network','async function decide(){await fetch("https://example.invalid/");return {action:"wait"}}'],
        ['storage','function decide(){return {action:"wait",memory:localStorage.getItem("a")}}'],
      ]){
        const sandbox=new StrategySandbox(source);sandbox.initialized.catch(()=>{});
        try{const value=await sandbox.decide({role:'runner'});results.push({label,ok:true,value})}catch(e){results.push({label,ok:false,error:e.message})}finally{sandbox.close()}
      }
      return results;
    });
    assert.equal(results.find(r=>r.label==='valid').ok,true);
    for(const label of ['badAction','infinite','initLoop','nonfinite','network','storage'])assert.equal(results.find(r=>r.label===label).ok,false,label);
    assert.equal(await page.locator('iframe[title="迷宫策略隔离执行器"]').count(),0);assert.deepEqual(errors,[]);
  }finally{await context.close()}
});

test('three-file import persists, bad runner only loses itself, bad hunter voids round',async()=>{
  const {context,page,errors}=await open();
  try{
    await page.locator('#mz-demos').uncheck();
    await add(page,'GOOD','function decide(o){return {action:"wait"}}',waitHunter);
    await add(page,'BAD RUNNER','function decide(o){throw Error("bad runner")}',waitHunter);
    await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.mz-card').length===5);
    await page.locator('#mz-demos').uncheck();assert.equal(await page.locator('.mz-card').count(),2);
    await page.locator('#mz-step').click();await page.waitForFunction(()=>document.querySelector('#mz-clock')?.textContent.startsWith('1 /'));
    assert.deepEqual(await page.locator('[data-status]').allTextContents(),['探索中','策略错误']);
    assert.equal(await page.locator('.mz-total').last().textContent(),'0');
    // These are disposable entries in an isolated test browser context.
    await page.locator('[data-remove]').first().click();await page.locator('[data-remove]').first().click();
    await add(page,'BROKEN HUNTER','function decide(){return {action:"wait"}}','function decide(){return {actions:[]}}');
    await selectHunterSeed(page,'BROKEN HUNTER');
    await page.locator('#mz-speed').selectOption('16');await page.locator('#mz-start').click();
    await page.waitForFunction(()=>document.querySelector('#mz-phase')?.textContent==='本轮作废');
    assert((await page.locator('#mz-notice').textContent()).includes('BROKEN HUNTER'));
    assert.equal(await page.locator('.mz-total').textContent(),'—');
    await page.locator('#mz-seek').fill('0');await page.locator('#mz-seek').dispatchEvent('input');
    assert.equal(await page.locator('#mz-phase').textContent(),'本轮作废');
    assert.equal(await page.locator('iframe[title="迷宫策略隔离执行器"]').count(),0);assert.deepEqual(errors,[]);
  }finally{await context.close()}
});

test('built-in guard can be drawn in all levels, executes in worker and stays out of runner ranking',async()=>{
  const {context,page,errors}=await open();
  try{
    for(const level of ['scout','standard','expert']){
      await page.locator('#mz-level').selectOption(level);await selectHunterSeed(page,'我自己写的');
      assert.equal(await page.locator('.mz-card').count(),3);
      assert.equal(await page.locator('.mz-ranking tbody tr').count(),3);
      await page.locator('#mz-hunter-info').click();
      assert((await page.locator('#doc-body').textContent()).includes('抽签池（4 种）'));
      await page.locator('#close-doc').click();
      for(let tick=1;tick<=3;tick++){
        await page.locator('#mz-step').click();
        await page.waitForFunction(tick=>document.querySelector('#mz-clock')?.textContent.startsWith(tick+' /'),tick);
      }
      assert.equal(await page.locator('#mz-phase').textContent(),'已暂停');
      assert.deepEqual(await page.locator('[data-status]').allTextContents(),['探索中','探索中','探索中']);
    }
    const pending=page.waitForEvent('download');await page.locator('#mz-export').click();
    await (await pending).saveAs('qa/guard-hunter-round.json');
    const log=JSON.parse(await readFile('qa/guard-hunter-round.json','utf8'));
    assert.equal(log.hunter.name,'我自己写的');assert.equal(log.entries.length,3);
    for(const entry of log.entries){
      const pursuit=entry.actions.find(a=>a.hunter)?.hunter;
      assert.equal(pursuit.actions.length,3);
      assert.equal(Object.values(pursuit.memory.roles).filter(role=>role==='key').length,2);
    }
    assert.deepEqual(errors,[]);
  }finally{await context.close()}
});
