import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.JUNQI_PLAYWRIGHT_MODULE||'playwright');
const url=process.env.JUNQI_BASE_URL||'http://127.0.0.1:4173/';
let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.JUNQI_BROWSER_PATH?{executablePath:process.env.JUNQI_BROWSER_PATH}:{})})});
after(async()=>{await browser?.close()});
async function open(){
  const context=await browser.newContext(),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/data/catalog.json',async route=>{
    const response=await route.fetch(),data=await response.json();
    data.submissions=data.submissions.filter(s=>s.task!=='junqi');
    await route.fulfill({response,json:data});
  });
  await page.goto(url+'#task=junqi');await page.locator('#jq-add-human').waitFor();
  return {context,page,errors};
}
async function addHuman(page,name='Human'){
  await page.locator('#jq-add-human').click();
  await page.locator('#jq-human [name=name]').fill(name);
  await page.locator('#jq-human-form button[type=submit]').click();
}
async function addAI(page,source){
  await page.locator('#jq-import').click();
  await page.locator('#jq-upload [name=name]').fill('Test AI');
  await page.locator('#jq-upload [name=files]').setInputFiles([
    {name:'strategy.js',mimeType:'text/javascript',buffer:Buffer.from(source)},
    {name:'README.md',mimeType:'text/markdown',buffer:Buffer.from('test')},
  ]);
  await page.locator('#jq-upload-form button[type=submit]').click();
  await page.locator('#jq-upload').waitFor({state:'hidden'});
  await page.locator('[data-pick^="local-"]').check();
}
test('one human only, including unchecked humans; removing frees the seat',async()=>{
  const {context,page,errors}=await open();
  try{
    await addHuman(page);
    assert(await page.locator('#jq-add-human').isDisabled());
    await page.locator('[data-pick^="human-"]').uncheck();
    assert(await page.locator('#jq-add-human').isDisabled());
    await page.locator('#jq-human-form').evaluate(form=>{
      form.elements.name.value='Second';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    });
    assert.equal(await page.locator('[data-pick^="human-"]').count(),1);
    await page.locator('[data-remove^="human-"]').click();
    assert(await page.locator('#jq-add-human').isEnabled());
    await addHuman(page,'Replacement');
    await page.locator('#jq-all').click();
    assert(await page.locator('[data-pick^="human-"]').isChecked());
    await page.locator('#jq-start').click();await page.locator('#jq-step').click();
    await page.waitForFunction(()=>document.querySelector('#jq-clock')?.textContent.startsWith('tick 1 /'));
    assert.equal(await page.locator('#jq-board-rows tr').count(),2);
    assert.equal(await page.locator('#jq-board-rows').getByText('策略错误',{exact:true}).count(),0);
    await page.locator('#jq-seek').fill('0');
    assert((await page.locator('#jq-clock').textContent()).includes('tick 0 /'));
    await page.locator('#jq-reset').click();
    assert((await page.locator('#jq-clock').textContent()).startsWith('tick 0 /'));
    assert.deepEqual(errors,[]);
  }finally{await context.close()}
});
test('invalid and hung scripts lose without executing injected HTML',async()=>{
  for(const source of ['function decide(){throw Error("<img src=x onerror=alert(1)>")}', 'function decide(){while(true){}}']){
    const {context,page,errors}=await open();
    try{
      await addHuman(page,'<b>Human</b>');
      await addAI(page,source);
      await page.locator('[data-pick="demo-baseline"]').uncheck();
      await page.locator('#jq-start').click();await page.locator('#jq-step').click();
      await page.waitForFunction(()=>document.querySelector('#jq-results .jq-settlement'));
      assert.equal(await page.locator('#jq-results img,#jq-results b').count(),0);
      assert.equal(await page.locator('#jq-board-rows').getByText('策略错误',{exact:true}).count(),1);
      assert.deepEqual(errors,[]);
    }finally{await context.close()}
  }
});
