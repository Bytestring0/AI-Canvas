// Each entrant runs in a terminable worker inside an opaque-origin, network-blocked iframe.
function workerMain(){
  let decide;
  self.onmessage=async ({data})=>{
    try{
      if(data.type==='init'){
        decide=new Function('"use strict";\n'+data.source+'\n;return typeof decide === "function" ? decide : null;')();
        if(!decide)throw Error('请定义 function decide(observation)');
        self.postMessage({id:data.id,ok:true});return;
      }
      const value=await decide(data.observation);
      // Only a small JSON value leaves the worker. Cloning arbitrary objects is never needed.
      const json=JSON.stringify(value,(_,v)=>{if(typeof v==='number'&&!Number.isFinite(v))throw Error('JSON 数字必须有限');return v});
      if(!json||json.length>32768)throw Error('输出必须是小于 32768 字符的 JSON 对象');
      const result=JSON.parse(json);
      if(!result||typeof result!=='object'||Array.isArray(result))throw Error('必须返回 JSON 对象');
      if(data.observation.role==='runner'&&!['up','right','down','left','wait'].includes(result.action))throw Error('action 必须是 up/right/down/left/wait');
      self.postMessage({id:data.id,ok:true,result});
    }catch(e){self.postMessage({id:data.id,ok:false,error:String(e?.message||e).slice(0,300)})}
  };
}
function frameMain(workerSource,token){
  const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
  let worker;
  const send=data=>parent.postMessage({token,...data},'*');
  try{
    worker=new Worker(url);URL.revokeObjectURL(url);
    worker.onmessage=e=>send(e.data);
    worker.onerror=e=>send({id:0,ok:false,error:e.message||'Worker 启动失败'});
    window.addEventListener('message',e=>{if(e.source===parent&&e.data?.token===token)worker.postMessage(e.data.payload)});
    send({ready:true});
  }catch(e){send({id:0,ok:false,error:String(e.message)})}
}
export class StrategySandbox {
  constructor(source){
    this.pending=new Map();this.sequence=0;this.closed=false;
    this.frame=document.createElement('iframe');this.frame.hidden=true;this.frame.sandbox='allow-scripts';this.frame.title='迷宫策略隔离执行器';
    const token=crypto.randomUUID();
    this.onMessage=e=>{
      if(e.source!==this.frame.contentWindow||e.data?.token!==token)return;
      if(e.data.ready){this.readyResolve();return}
      const p=this.pending.get(e.data.id);
      if(p){clearTimeout(p.timer);this.pending.delete(e.data.id);e.data.ok?p.resolve(e.data.result):p.reject(Error(e.data.error||'策略执行失败'))}
      else if(e.data.id===0)this.readyReject(Error(e.data.error));
    };
    window.addEventListener('message',this.onMessage);
    const ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject});
    const script=`(${frameMain.toString()})(${JSON.stringify('('+workerMain.toString()+')()')},${JSON.stringify(token)})`;
    this.frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'"><script>${script.replaceAll('</script','<\\/script')}<\/script>`;
    this.send=(payload)=>this.frame.contentWindow.postMessage({token,payload},'*');
    document.body.append(this.frame);
    let timer;
    this.initialized=Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('隔离环境启动超时')),5000)})])
      .then(()=>this.request({type:'init',source},1500)).finally(()=>clearTimeout(timer));
  }
  request(payload,timeout=200){
    if(this.closed)return Promise.reject(Error('策略已停止'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`策略超过 ${timeout}ms 执行时限`));this.close()},timeout);
      this.pending.set(id,{resolve,reject,timer});this.send({...payload,id});
    });
  }
  async decide(observation){await this.initialized;return this.request({type:'step',observation})}
  close(){
    if(this.closed)return;this.closed=true;
    this.readyReject(Error('策略已停止'));
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('策略已停止'))}
    this.pending.clear();window.removeEventListener('message',this.onMessage);this.frame.remove();
  }
}
