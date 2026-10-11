import asyncio
import json
from datetime import timedelta
import httpx
import pytest
from sqlalchemy import delete
from server.db import Session
from server.models import AiRequest, Consent, now
from server.worker import work_once

def queued(actors, monkeypatch):
    c, a, d = actors
    for key, value in {'HERMES_BASE_URL':'http://agent.test/p/dravet-night', 'HERMES_API_KEY':'test-only',
            'HERMES_MODEL':'dravet-night', 'HERMES_RESTRICTED_CONTEXT_CONFIRMED':'true'}.items():monkeypatch.setenv(key,value)
    conv = c.post('/v1/conversations',headers=a[0]['headers']).json()['id']
    response = c.post(f'/v1/conversations/{conv}/messages',headers=a[0]['headers'],json={'device_id':d,
        'question':'Explain only this window','from':(now()-timedelta(hours=1)).isoformat(),'to':now().isoformat(),'timezone':'UTC'})
    assert response.status_code == 202
    return response.json()['request_id'], a[0]['guardian']

def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs))

@pytest.mark.parametrize('finish,model,answer,error',[
    ('stop','dravet-night','Window has no samples',None),
    ('length','dravet-night','Partial answer','hermes_incomplete_answer'),
    ('stop','other-profile','Unexpected routing','hermes_unexpected_model'),
    ('stop','dravet-night','','hermes_empty_answer'),
])
def test_worker_requires_complete_answer_from_expected_profile(actors,monkeypatch,finish,model,answer,error):
    task, _ = queued(actors,monkeypatch)
    def handle(request):
        assert request.url.path == '/p/dravet-night/v1/chat/completions'
        body = json.loads(request.content)
        assert body['model']=='dravet-night' and body['stream'] is False
        context = json.loads(body['messages'][1]['content'])
        assert context['summary']['status']=='no_data'
        return httpx.Response(200,json={'model':model,'choices':[{'finish_reason':finish,'message':{'content':answer}}]})
    transport(monkeypatch,handle);asyncio.run(work_once())
    with Session() as db:
        row = db.get(AiRequest,task)
        assert row.state == ('failed' if error else 'completed') and row.error == error
        assert row.result == (None if error else answer)

@pytest.mark.parametrize('change',['revoke','delete','expire','reclaim'])
def test_worker_does_not_commit_after_authority_or_lease_changes(actors,monkeypatch,change):
    task, guardian = queued(actors,monkeypatch)
    def handle(request):
        with Session() as db:
            row = db.get(AiRequest,task)
            if change=='delete':db.execute(delete(AiRequest).where(AiRequest.id==task))
            elif change=='revoke':db.get(Consent,(guardian,'ai_analysis')).granted=False
            elif change=='expire':row.deadline=now()-timedelta(seconds=1)
            else:row.attempts+=1
            db.commit()
        return httpx.Response(200,json={'model':'dravet-night','choices':[{'finish_reason':'stop','message':{'content':'Must not be committed'}}]})
    transport(monkeypatch,handle);asyncio.run(work_once())
    with Session() as db:
        row=db.get(AiRequest,task)
        assert row is None if change=='delete' else row.result is None and row.state!='completed'
