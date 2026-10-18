// Synthetic data and ephemeral listener only; credentials stay in private process pipes.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const { startFamilyServer } = await import(pathToFileURL(resolve(import.meta.dirname, '../../server/dist/src/server/http.js')));
const app = await startFamilyServer({dataDir:process.argv[2],port:0});
const a = app.store.register({username:'synthetic_dravet',displayName:'合成家庭',password:'synthetic-fixture-password-2026',consent:true});
const b = app.store.register({username:'synthetic_other',displayName:'合成其他',password:'synthetic-fixture-password-2026',consent:true,inviteCode:app.store.createInvite(a.user).code});
const child = user => app.store.createChild(user,{nickname:'合成患者',birthYear:null,diagnosis:'',validationConsent:false});
const ca = child(a.user), cb = child(b.user), grant=app.dravet.grant(a.user,ca.id,'合成Octop',1), grantB=app.dravet.grant(b.user,cb.id,'合成Octop B',1);
const d=app.dravet.redeem(app.dravet.pair(a.user,ca.id,{name:'合成设备',model:'test',protocol:'test',consent:true}).pairingCode);
app.dravet.ingest(d.token,{batchId:randomUUID(),samples:[{id:randomUUID(),sessionId:randomUUID(),sequence:0,kind:'hr',value:80,unit:'bpm',sampledAt:'2026-10-14T00:00:00+08:00',receivedAt:'2026-10-14T00:00:00+08:00',timeSource:'phone_received',rawTimestamp:null,quality:'unknown',source:'synthetic'}]});
console.log(JSON.stringify({url:app.url,grant,grantB,ca,cb}));
try { for await (const line of createInterface({input:process.stdin})) { const command=JSON.parse(line); if(command.action==='stop')break; if(command.action==='revoke'){app.dravet.revoke(a.user,ca.id,grant.id,'agent');console.log('{"ok":true}');} } }
finally { await app.close(); }
