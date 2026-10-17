export const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money = value => new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value);
export const percent = value => `${(value*100).toFixed(2)}%`;
export const time = value => value ? value.replace('T',' ').slice(0,19) : '—';
export function download(name,text,type='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([text],{type}));
  const link=document.createElement('a');link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
