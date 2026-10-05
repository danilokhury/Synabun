import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const zeroUsage = () => Object.fromEntries(USAGE_FIELDS.map(k => [k, 0]));
const hash = s => createHash('sha256').update(s).digest('hex');
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).join('\n');
  return content?.type === 'text' ? content.text || '' : '';
}
function metrics(content) {
  const text = contentText(content);
  return { text_characters: Array.from(text).length, utf8_bytes: Buffer.byteLength(text),
    images: Array.isArray(content) ? content.filter(b=>b?.type==='image').length : 0,
    sha256: hash(text), token_count: null, token_count_source: 'unavailable' };
}
function isPrompt(record) {
  if (record.type !== 'user' || record.isMeta || record.isCompactSummary) return false;
  const content=record.message?.content;
  if (Array.isArray(content) && (!content.some(b=>b.type==='text') || content.some(b=>b.type==='tool_result'))) return false;
  if (typeof content !== 'string' && !Array.isArray(content)) return false;
  return !/^<(local-command|command-name|bash-input|system-reminder)>/.test(contentText(content));
}
export function transcriptFiles(directory) {
  const files=[];
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isDirectory()) files.push(...transcriptFiles(path));
    else if(entry.isFile() && entry.name.endsWith('.jsonl'))files.push(path);
  }
  return files.sort();
}

/** Provenance joins are positional; provider usage is never split by character ratios. */
export function auditClaudeRecords(sources, { since, until } = {}) {
  const requests=new Map(), prompts=new Map(), payloads=[], groups=new Map();
  const seenPayloads=new Set();
  let first=null,last=null;
  const inWindow=t => t && (!since || Date.parse(t)>=Date.parse(since)) && (!until || Date.parse(t)<=Date.parse(until));
  for(const {file,records} of sources) {
    const sidechain=/[/\\]subagents[/\\]/.test(file);
    const tools=new Map();let prompt=null;
    // Link only to the first following recorded API response in this file.
    // This does not assert that a payload survived compaction or was billed.
    const nextRequests=new Map();let next=null;
    for(let i=records.length-1;i>=0;i--) {
      const r=records[i];
      nextRequests.set(i,next);
      if(r.type==='assistant' && r.message?.id && r.message?.usage)
        next={message_id:r.message.id,request_id:r.requestId || r.request_id || null};
    }
    for(const [index,r] of records.entries()) {
      const session=r.sessionId || r.session_id || basename(file,'.jsonl');
      const content=r.message?.content;
      if(isPrompt(r)) {
        prompt=r.promptId || r.uuid || `${file}:${index}`;
        if(!prompts.has(prompt)) prompts.set(prompt,{id:prompt,session_id:session,sidechain,timestamp:r.timestamp,submitted_in_window:!!inWindow(r.timestamp),request_ids:[]});
      }
      if(r.type==='assistant' && Array.isArray(content)) for(const block of content) {
        if(block.type==='tool_use') tools.set(block.id,{name:block.name,message_id:r.message.id,request_id:r.requestId || r.request_id || null});
      }
      if(!inWindow(r.timestamp))continue;
      if(!first || r.timestamp<first)first=r.timestamp;
      if(!last || r.timestamp>last)last=r.timestamp;
      if(r.type==='assistant' && r.message?.id && r.message.usage) {
        const id=r.message.id, usage=r.message.usage;
        let entry=requests.get(id);
        if(!entry) {
          entry={message_id:id,request_id:r.requestId || r.request_id || null,session_id:session,prompt_id:prompt,
            sidechain,timestamp:r.timestamp,model:r.message.model,usage:zeroUsage()};
          requests.set(id,entry);
          if(prompt)prompts.get(prompt)?.request_ids.push(id);
        }
        for(const k of USAGE_FIELDS)if(Number.isFinite(usage[k]))entry.usage[k]=Math.max(entry.usage[k],usage[k]);
      }
      const provenance={session_id:session,prompt_id:prompt,timestamp:r.timestamp,sidechain,
        file,line:index+1,next_recorded_request:nextRequests.get(index),attribution:'next-recorded-request; retention unverified'};
      const attachment=r.attachment;
      if(attachment?.type==='hook_additional_context') {
        const texts=Array.isArray(attachment.content)?attachment.content:[attachment.content];
        for(const [part,text] of texts.entries()) {
          if(typeof text!=='string' || !text.includes('SynaBun'))continue;
          const identity=`${r.uuid || file+':'+index}:${part}`;
          if(seenPayloads.has(identity))continue;seenPayloads.add(identity);
          const event=attachment.hookEvent || attachment.hookName || 'unknown';
          const occurrence=event==='UserPromptSubmit'?prompt:event==='SessionStart'?r.uuid:attachment.toolUseID;
          const key=JSON.stringify([session,event,occurrence || r.uuid || index]);
          const payload={...provenance,kind:'hook',hook_event:event,event_key:key,...metrics(text)};
          payloads.push(payload);
          if(!groups.has(key))groups.set(key,[]);groups.get(key).push(payload);
        }
      }
      if(r.type==='user' && Array.isArray(content)) for(const b of content) {
        if(b.type!=='tool_result')continue;
        const key=`tool:${b.tool_use_id}`;
        if(seenPayloads.has(key))continue;seenPayloads.add(key);
        const producer=tools.get(b.tool_use_id);
        const tool=producer?.name || 'unknown';
        const short=tool.split(/Syna[Bb]un_+/)[1];
        const kind=short?.startsWith('browser_')?'synabun_browser':short==='recall'?'synabun_recall':short?'synabun_other':'other_tool';
        payloads.push({...provenance,kind,tool,tool_use_id:b.tool_use_id,producer,...metrics(b.content)});
      }
    }
  }
  const requestList=[...requests.values()];
  const scopeSummary=sidechain=>{
    const selected=requestList.filter(r=>r.sidechain===sidechain),usage=zeroUsage();
    for(const r of selected)for(const k of USAGE_FIELDS)usage[k]+=r.usage[k];
    const active=[...prompts.values()].filter(p=>p.sidechain===sidechain && p.request_ids.length);
    const input=usage.input_tokens+usage.cache_creation_input_tokens+usage.cache_read_input_tokens;
    return {requests:selected.length,prompts_submitted:[...prompts.values()].filter(p=>p.sidechain===sidechain && p.submitted_in_window).length,
      prompts_with_requests:active.length,usage,input_including_cache:input,
      input_per_active_prompt:active.length?input/active.length:null};
  };
  const components={};
  for(const p of payloads) {
    const entry=components[p.kind] ||= {payloads:0,text_characters:0,utf8_bytes:0,images:0,token_count:null};
    entry.payloads++;for(const k of ['text_characters','utf8_bytes','images'])entry[k]+=p[k];
  }
  const hooks={};
  for(const group of groups.values()) {
    const entry=hooks[group[0].hook_event] ||= {events:0,blocks:0,extra_blocks:0,exact_repeats:0,extra_characters:0};
    entry.events++;entry.blocks+=group.length;entry.extra_blocks+=group.length-1;
    entry.exact_repeats+=group.length-new Set(group.map(p=>p.sha256)).size;
    entry.extra_characters+=group.slice(1).reduce((n,p)=>n+p.text_characters,0);
  }
  return {version:1,window:{since:since || first,until:until || last},summary:{main:scopeSummary(false),subagents:scopeSummary(true),components,hooks},
    accounting_limits:['Provider usage is deduplicated by API message ID; cache fields remain separate.',
      'Component token counts are unavailable, never estimated from characters.',
      'Payload request joins identify the next recorded response, not retention or marginal billing.',
      'Active-prompt averages include prompts submitted before the reporting window.'],
    requests:requestList,prompts:[...prompts.values()].filter(p=>p.submitted_in_window || p.request_ids.length),payloads};
}

export function auditClaudeTranscripts(files, options) {
  return auditClaudeRecords(files.map(file=>({file,records:readFileSync(file,'utf8').split('\n').flatMap(line=>{
    try{return line.trim()?[JSON.parse(line)]:[];}catch{return [];}
  })})),options);
}
