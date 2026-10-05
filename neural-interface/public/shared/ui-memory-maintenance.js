async function api(path,body) {
  const response=await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error || DEFAULT_STRINGS.requestFailed);
  return data;
}
function element(tag,text,className) {
  const el=document.createElement(tag); if(text)el.textContent=text; if(className)el.className=className; return el;
}
function button(label,action,tag,help) {
  const el=element('button',label,'conn-action-btn'); el.type='button';
  if(tag)el.dataset.stgId=tag;
  if(help)el.title=help;
  el.addEventListener('click',async()=>{el.disabled=true;try{await action();}finally{el.disabled=false;}});
  return el;
}
const fill=(text,params)=>String(text).replace(/\{(\w+)\}/g,(m,name)=>params&&params[name]!=null?params[name]:m);

// English defaults. Settings passes translated copy as `strings`, which is merged over these
// (the browser test mounts this module alone and relies on the defaults).
// `tag` ids are the Settings inventory ids of the controls this module renders.
const DEFAULT_STRINGS = {
  requestFailed:'Memory request failed',
  loading:'Loading memory status…',
  running:'Maintenance running',
  paused:'Maintenance paused',
  noWork:'No pending work',
  pause:'Pause maintenance',
  resume:'Resume maintenance',
  refresh:'Refresh',
  retry:'Retry failed jobs',
  undo:'Undo relationship',
  confirm:'Confirm conflict',
  noReview:'No relationships awaiting review.',
  jobCount:'{count} {status}',
  help:{pause:'',resume:'',refresh:'',retry:'',undo:'',confirm:'',details:''},
  jobStatus:{},
  relationKind:{},
};

export function mountMemoryMaintenance(root,{strings={},onStatus}={}) {
  if(!root || root.dataset.mounted)return;
  root.dataset.mounted='true';
  const text={...DEFAULT_STRINGS,...strings,help:{...DEFAULT_STRINGS.help,...strings.help},jobStatus:{...DEFAULT_STRINGS.jobStatus,...strings.jobStatus},relationKind:{...DEFAULT_STRINGS.relationKind,...strings.relationKind}};
  const status=element('p',text.loading,'stg-help');
  status.setAttribute('role','status');
  const actions=element('div');actions.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin:8px 0';
  const review=element('div');
  root.append(status,actions,review);
  async function load(operation) {
    try {
      const data=await api('/api/memory-maintenance',operation);
      const jobs=data.jobs.map(j=>fill(text.jobCount,{count:j.count,status:text.jobStatus[j.status]||j.status})).join(' · ') || text.noWork;
      status.textContent=`${data.paused ? text.paused : text.running} · ${jobs}`;
      if(onStatus)try{onStatus(data);}catch{}
      actions.replaceChildren(
        data.paused ? button(text.resume,()=>load({operation:'resume'}),'MEM012',text.help.resume) : button(text.pause,()=>load({operation:'pause'}),'MEM012',text.help.pause),
        button(text.refresh,()=>load(),'MEM013',text.help.refresh),button(text.retry,()=>load({operation:'retry'}),'MEM014',text.help.retry),
      );
      review.replaceChildren();
      for(const relation of data.relationships || []) {
        const row=element('details');row.style.margin='8px 0';
        const summary=element('summary',`${text.relationKind[relation.kind]||relation.kind.replaceAll('_',' ')} · ${relation.from_id.slice(0,8)} → ${relation.to_id.slice(0,8)}`);
        summary.dataset.stgId='MEM001';
        if(text.help.details)summary.title=text.help.details;
        row.append(summary);
        const evidence=element('div');
        let loaded=false;
        row.addEventListener('toggle',async()=>{
          if(!row.open || loaded)return; loaded=true;
          try {
            for(const id of [relation.from_id,relation.to_id]) {
              const m=await api('/api/memory/'+encodeURIComponent(id));
              const pre=element('pre',`[${id}]\n${m.payload.content}`);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto';evidence.append(pre);
            }
          }catch(error){evidence.textContent=error.message;loaded=false;}
        });
        row.append(evidence,button(text.undo,()=>load({operation:'undo-relation',id:relation.id}),'MEM015',text.help.undo));
        if(relation.kind==='possible_conflict')row.append(button(text.confirm,()=>load({operation:'confirm-relation',id:relation.id,from_id:relation.from_id,to_id:relation.to_id,kind:'conflicts_with'}),'MEM016',text.help.confirm));
        review.append(row);
      }
      if(!data.relationships?.length)review.append(element('p',text.noReview,'stg-help'));
    }catch(error){status.textContent=error.message;}
  }
  load();
}

export function mountMemoryHistory(root,id,onRestore=()=>{}) {
  if(!root)return;
  const details=element('details'); details.style.marginTop='12px';
  details.append(element('summary','Revision history'));
  const body=element('div');details.append(body);root.append(details);
  async function load() {
    body.textContent='Loading revisions…';
    try {
      const data=await api(`/api/memory/${encodeURIComponent(id)}/history`);
      body.replaceChildren();
      for(const revision of data.revisions) {
        const entry=element('details');entry.append(element('summary',`Revision ${revision.revision} · ${revision.recorded_at}`));
        const pre=element('pre',revision.payload.content);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto';
        entry.append(pre);
        if(revision.revision!==data.revision)entry.append(button('Restore this revision',async()=>{
          try {await api(`/api/memory/${encodeURIComponent(id)}/undo`,{revision:revision.revision,expected_revision:data.revision});await onRestore();await load();}
          catch(error){body.prepend(element('p',error.message));}
        }));
        body.append(entry);
      }
    }catch(error){body.textContent=error.message;}
  }
  details.addEventListener('toggle',()=>{if(details.open)load();});
}
