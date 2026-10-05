import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { auditClaudeTranscripts, transcriptFiles } from '../lib/claude-usage-audit.js';

const args=process.argv.slice(2);
function option(name) {const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
const directory=option('--directory') || join(homedir(),'.claude/projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
const report=auditClaudeTranscripts(transcriptFiles(directory),{since:option('--since'),until:option('--until')});
const output=option('--output');
if(output){mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({output:output || null,window:report.window,...report.summary,accounting_limits:report.accounting_limits},null,2));
