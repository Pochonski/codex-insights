import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root}).toString('utf8').split('\0').filter(Boolean);
const packages=readdirSync(root).filter(name=>/^codex-insights-.*\.vsix$/.test(name));
const packaged=packages.flatMap(name=>execFileSync('unzip',['-Z1',name],{cwd:root}).toString('utf8').split(/\r?\n/).filter(Boolean).map(item=>`${name}:${item}`));
const forbidden=/(^|\/)(node_modules|coverage|backups?|codex-insights-v0\.3\.0)(\/|$)|(^|\/)(auth\.json|\.env(?:\..*)?)$|\.(?:db|sqlite|sqlite3|jsonl|log)$/i;
const badPaths=[...tracked,...packaged].filter(item=>forbidden.test(item));
const secretPatterns=[/\bsk-[A-Za-z0-9_-]{20,}\b/g,/\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g];
const secretFiles=[];
for(const file of tracked){const full=path.join(root,file);if(!statSync(full).isFile()||statSync(full).size>2*1024*1024||/\.(?:png|jpg|jpeg|gif|ico|vsix)$/i.test(file))continue;const content=readFileSync(full,'utf8');if(secretPatterns.some(pattern=>{pattern.lastIndex=0;return pattern.test(content);} ))secretFiles.push(file);}
if(badPaths.length||secretFiles.length){if(badPaths.length)console.error('Forbidden paths:',badPaths.join(', '));if(secretFiles.length)console.error('Potential secrets:',secretFiles.join(', '));process.exit(1);}
console.log(`Sensitive-file check passed (${tracked.length} tracked files, ${packaged.length} packaged entries).`);
