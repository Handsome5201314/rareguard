// Manual browser smoke fixture. Creates and removes only its own temporary data.
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { startFamilyServer } from '../dist/src/server/http.js';
const dir=await mkdtemp(join(tmpdir(),'dravet-ui-smoke-'));
const app=await startFamilyServer({dataDir:dir,port:0});
const account=app.store.register({username:'synthetic_ui',displayName:'合成界面账户',password:'constructed-ui-password-2026',consent:true});
app.store.createChild(account.user,{nickname:'合成测试档案',birthYear:null,diagnosis:'',validationConsent:false});
app.store.createChild(account.user,{nickname:'合成测试档案 B',birthYear:null,diagnosis:'',validationConsent:false});
process.stdout.write(JSON.stringify({url:app.url})+'\n');
const input=createInterface({input:process.stdin});
for await(const line of input) { if(line.trim()==='stop') break; }
input.close();process.stdin.destroy();await app.close();await rm(dir,{recursive:true,force:true});
