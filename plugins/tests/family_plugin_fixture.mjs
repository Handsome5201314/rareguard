// Synthetic-only subprocess fixture. Tokens travel over private parent/child pipes.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../server');
const { startFamilyServer } = await import(pathToFileURL(resolve(root, 'dist/src/server/http.js')));
const { agentScopes } = await import(pathToFileURL(resolve(root, 'dist/src/shared/types.js')));
const app = await startFamilyServer({ dataDir: process.argv[2], port: 0 });
const password = 'synthetic-plugin-test-password';
const a = app.store.register({ username: 'synthetic_plugin_a', displayName: '合成家庭甲', password, consent: true });
const invite = app.store.createInvite(a.user);
const b = app.store.register({ username: 'synthetic_plugin_b', displayName: '合成家庭乙', password, consent: true, inviteCode: invite.code });
const grant = app.store.createFamilyAgentGrant(a.user, { name: 'synthetic-plugin', scopes: agentScopes, days: 1, consent: true });
const grantB = app.store.createFamilyAgentGrant(b.user, { name: 'synthetic-plugin-b', scopes: agentScopes.filter(x => x !== 'invites:write'), days: 1, consent: true });
const limited = app.store.createFamilyAgentGrant(a.user, { name: 'synthetic-readonly', scopes: ['profiles:read', 'records:read'], days: 1, consent: true });
const child = app.store.createChild(a.user, { nickname: '合成旧患者', relationship: 'child', birthYear: null, diagnosis: '', validationConsent: false });
const legacy = app.store.createAgentGrant(a.user, child.id, { name: 'synthetic-legacy', scopes: ['records:read', 'drafts:write', 'attachments:write'], days: 1, consent: true });
console.log(JSON.stringify({ url: app.url, grant, grantB, limited, legacy, child }));
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line);
    if (command.action === 'stop') break;
    try {
      let result;
      if (command.action === 'snapshot') result = { profiles: app.store.listChildren(a.user), other: app.store.listChildren(b.user), records: command.patientId ? app.store.listRecords(a.user, command.patientId) : [] };
      else if (command.action === 'revoke') { app.store.revokeFamilyAgentGrant(a.user, grant.id); result = { ok: true }; }
      else if (command.action === 'web-edit') { const current = app.store.assertChild(a.user, command.patientId); result = { profile: app.store.updateChild(a.user, current.id, { ...current, diagnosis: '合成网页改动' }, current.version, '合成网页更新') }; }
      else throw new Error('Unknown synthetic fixture command');
      console.log(JSON.stringify(result));
    } catch (error) { console.log(JSON.stringify({ error: error.code || 'FIXTURE_ERROR' })); }
  }
} finally { await app.close(); }
