"""Actual Octop loader / ToolNode / MCP SDK against an ephemeral synthetic server."""
import asyncio
import importlib
import json
import logging
from pathlib import Path
import subprocess
import tempfile
import unittest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from octop_harness.plugins.loader import load_plugin_dir
from octop_harness.plugins.tools import build_plugin_tools

ROOT = Path(__file__).resolve().parents[2]
load_plugin_dir(ROOT / 'plugins' / 'dravet-monitor-plugin', install_deps=False)
main = importlib.import_module('harness_plugin_dravet_monitor_plugin')
client = importlib.import_module('harness_plugin_dravet_monitor_plugin.client')
storage = importlib.import_module('harness_plugin_dravet_monitor_plugin.storage')
TOOLS = [t for t in build_plugin_tools(global_plugins={'dravet-monitor-plugin':True}) if t.name.startswith('dravet_')]
b = StateGraph(MessagesState); b.add_node('tools', ToolNode(TOOLS)); b.add_edge(START,'tools'); b.add_edge('tools',END); GRAPH=b.compile()
for name in ('httpx','mcp'): logging.getLogger(name).setLevel(logging.CRITICAL)

def package(token):
    return json.dumps({'kind':'dravet-monitor-connection','version':1,'url':client.ENDPOINT,'token':token})

class ContractTests(unittest.TestCase):
    def test_loader_schemas_have_no_model_credential_or_identity_arguments(self):
        self.assertEqual(len(TOOLS),5)
        for t in TOOLS:
            properties=t.tool_call_schema.model_json_schema().get('properties',{})
            self.assertFalse(set(properties) & {'state','token','ownerId','userId','patientId'})
            json.dumps(t.args_schema.model_json_schema())
    def test_packages_strict_and_fixed_endpoint(self):
        token='da_'+'a'*43
        self.assertEqual(main._parse_package(package(token)),token)
        for raw in [package(token)+package(token),package(token).replace(client.ENDPOINT,'https://evil.invalid'),package(token).replace('"version": 1','"version": true'),package('dd_'+'a'*43),package(token).replace('"version": 1','"version": 1, "version": 1')]:
            with self.assertRaises(client.PluginError): main._parse_package(raw)
    def test_no_redirect_proxy_and_redaction(self):
        async def run():
            async with client._http_client() as c:
                self.assertFalse(c.follow_redirects);self.assertFalse(c.trust_env)
        asyncio.run(run())
        for p in ['da_','dd_','dp_','family_']: self.assertNotIn(p+'a'*43,client.redact(p+'a'*43))
    def test_private_storage_restart_and_user_isolation(self):
        with tempfile.TemporaryDirectory(prefix='dravet-plugin-storage-') as directory:
            root=Path(directory)/'private'; s=storage.BindingStore(root)
            token='da_'+'b'*43;s.bind(storage.owner_key(1),{'token':token,'connection':{}})
            self.assertEqual(storage.BindingStore(root).get(storage.owner_key(1))['token'],token)
            self.assertNotIn(token.encode(),s.path.read_bytes())
            with self.assertRaises(client.PluginError):s.get(storage.owner_key(2))

class LiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix='dravet-plugin-live-')
        self.proc=subprocess.Popen(['node',str(ROOT/'plugins/tests/dravet_plugin_fixture.mjs'),str(Path(self.directory.name)/'server')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
        self.fixture=json.loads(await asyncio.to_thread(self.proc.stdout.readline))
        main._store=storage.BindingStore(Path(self.directory.name)/'bindings')
        main._client=client.DravetClient(self.fixture['url']+'/mcp/dravet')
    async def asyncTearDown(self):
        self.proc.stdin.write('{"action":"stop"}\n');self.proc.stdin.flush();self.proc.stdin.close()
        await asyncio.to_thread(self.proc.wait,10)
        self.proc.stdout.close();main._store=None;main._client=client.DravetClient();self.directory.cleanup()
    async def call(self,name,raw,args=None,user=1,extra=None):
        config={'user':user,'thread_id':'synthetic-thread','source':'dashboard/octop-dashboard',**(extra or {})}
        result=await GRAPH.ainvoke({'messages':[HumanMessage(content=raw),AIMessage(content='',tool_calls=[{'name':name,'args':args or {},'id':'synthetic-call'}])]},{'configurable':config})
        return json.loads(result['messages'][-1].content)
    async def bind(self,user=1,grant=None):return await self.call('dravet_bind',package((grant or self.fixture['grant'])['token']),user=user)
    async def test_real_bind_query_isolation_and_no_model_spoofing(self):
        self.assertTrue((await self.bind())['bound'])
        self.assertEqual((await self.call('dravet_status','状态',user=2))['error']['code'],'NOT_BOUND')
        args={'tool_name':'get_night_summary','arguments':{'from':'2026-10-13T23:00:00+08:00','to':'2026-10-14T08:00:00+08:00'}}
        data=await self.call('dravet_request','查看昨晚合成数据',args)
        self.assertEqual(data['patientId'],self.fixture['ca']['id']);self.assertEqual(data['groups'][0]['source'],'synthetic')
        args['arguments']['ownerId']='forged-other-owner'
        self.assertEqual((await self.call('dravet_request','查询',args))['error']['code'],'INVALID_INPUT')
        self.assertEqual((await self.call('dravet_request','修改规则',{'tool_name':'change_rule','arguments':{}}))['error']['code'],'TOOL_NOT_ALLOWED')
    async def test_revoke_live_and_explicit_unbind(self):
        await self.bind();self.proc.stdin.write('{"action":"revoke"}\n');self.proc.stdin.flush();await asyncio.to_thread(self.proc.stdout.readline)
        self.assertEqual((await self.call('dravet_status','状态'))['error']['code'],'AGENT_UNAUTHORIZED')
        self.assertEqual((await self.call('dravet_unbind','查询'))['error']['code'],'CONFIRMATION_REQUIRED')
        self.assertTrue((await self.call('dravet_unbind','解除夜间监测绑定'))['unbound'])
    async def test_im_private_sender_isolation_and_groups_refused(self):
        extra={'source':'feishu/test-channel','agent_id':'synthetic-agent','session_key':'synthetic-agent:feishu:sender-a:dm'}
        self.assertTrue((await self.call('dravet_bind',package(self.fixture['grant']['token']),extra=extra))['bound'])
        extra['session_key']='synthetic-agent:feishu:sender-b:dm'
        self.assertEqual((await self.call('dravet_status','状态',extra=extra))['error']['code'],'NOT_BOUND')
        extra['session_key']='synthetic-agent:feishu:sender-a:group'
        self.assertEqual((await self.call('dravet_status','状态',extra=extra))['error']['code'],'PRIVATE_CHAT_REQUIRED')
        self.assertEqual((await self.call('dravet_status','状态',user=True))['error']['code'],'TRUSTED_USER_REQUIRED')

if __name__=='__main__':unittest.main()
