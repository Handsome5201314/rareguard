from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from server.models import now, Pairing
from server.db import Session
from server.main import digest

def sample(value=80):
    return {'sample_id':str(uuid4()),'metric':'hr','value':value,'unit':'bpm','observed_at':now().isoformat(),
            'phone_received_at':now().isoformat(),'time_basis':'phone_receive','quality':'unknown','source':'live_device'}
def batch(device,rows):
    return {'schema_version':1,'batch_id':str(uuid4()),'device_id':device,'app_version':'test','samples':rows}
def send(client,actor,payload):return client.post('/v1/measurement-batches',headers=actor['headers'],json=payload)
def test_commit_retry_and_conflicting_batch(actors):
    c,a,d=actors;p=batch(d,[sample()]);r=send(c,a[0],p);assert r.status_code==200;assert r.json()['accepted']==1
    assert send(c,a[0],p).json()==r.json()
    p['samples'][0]['value']=99;assert send(c,a[0],p).status_code==409
def test_conflict_rolls_back_entire_batch(actors):
    c,a,d=actors;s=sample();assert send(c,a[0],batch(d,[s])).status_code==200
    other=sample();s['value']=92;assert send(c,a[0],batch(d,[other,s])).status_code==409
    records=c.get('/v1/export',headers=a[0]['headers'],params={'device_id':d}).json()['samples'];assert len(records)==1
def test_concurrent_duplicate_batch_is_committed_once(actors):
    c,a,d=actors;p=batch(d,[sample()])
    with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda _:send(c,a[0],p),range(2)))
    assert all(r.status_code==200 for r in results);assert results[0].json()==results[1].json()
def test_authorization_and_revocation(actors):
    c,a,d=actors;p=batch(d,[sample()]);assert c.post('/v1/measurement-batches',json=p).status_code==401
    assert send(c,a[2],p).status_code==404
    assert c.post('/v1/consents',headers=a[0]['headers'],json={'scope':'upload','granted':False,'policy_version':'demo-1'}).status_code==200
    assert send(c,a[0],p).status_code==403
def test_source_unit_time_contract(actors):
    c,a,d=actors;s=sample();s['source']='device_history';assert send(c,a[0],batch(d,[s])).status_code==422
    s=sample();s['observed_at']='2026-10-10T20:00:00';assert send(c,a[0],batch(d,[s])).status_code==422
    s=sample();s['unit']='mmol/L';assert send(c,a[0],batch(d,[s])).status_code==422
def test_unknown_and_sparse_summary_not_normal(actors):
    c,a,d=actors;start=now()-timedelta(hours=12);end=now()+timedelta(seconds=5)
    assert send(c,a[0],batch(d,[sample()])).status_code==200
    r=c.get('/v1/summaries/night',headers=a[0]['headers'],params={'device_id':d,'from':start.isoformat(),'to':end.isoformat(),'timezone':'Asia/Shanghai'}).json()
    assert r['continuous_coverage'] is None;assert r['baseline_status']=='not_established';assert r['metrics']['hr']['unknown_quality_count']==1
    assert r['metrics']['hr']['maximum_interval_seconds'] is None
def test_two_guardians_have_independent_receipts(actors):
    c,a,d=actors;id=str(uuid4());assert c.post('/v1/alerts',headers=a[0]['headers'],json={'id':id,'device_id':d,'kind':'delivery_test','text':'test only'}).status_code==200
    assert c.post(f'/v1/alerts/{id}/receipt',headers=a[0]['headers'],json={'status':'confirmed'}).status_code==200
    rows=c.get(f'/v1/alerts/{id}/deliveries',headers=a[0]['headers']).json()['data'];assert len(rows)==2
    assert sum(row['confirmed_at'] is not None for row in rows)==1
    assert c.post(f'/v1/alerts/{id}/receipt',headers=a[2]['headers'],json={'status':'received'}).status_code==404
def test_config_requires_explicit_boundary_and_versions(actors):
    c,a,d=actors;p={'enabled':True,'duration_seconds':60,'max_gap_seconds':30,'required_signals':1,'hr_high':100,'allow_unknown_quality':False}
    payload={'base_version':0,'parameters':p,'confirmed_experimental_use':True}
    assert c.post(f'/v1/devices/{d}/config',headers=a[0]['headers'],json=payload).status_code==422
    p['allow_unknown_quality']=True;assert c.post(f'/v1/devices/{d}/config',headers=a[0]['headers'],json=payload).json()['applied'] is False
    assert c.post(f'/v1/devices/{d}/config',headers=a[1]['headers'],json=payload).status_code==409
def test_pairing_single_use_and_concurrent_exchange(actors):
    c,a,d=actors;code=str(uuid4())
    with Session() as db:db.add(Pairing(code_hash=digest(code),family=a[0]['family'],name='new guardian',expires=now()+timedelta(minutes=10)));db.commit()
    with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda _:c.post('/v1/pairings/exchange',json={'code':code}),range(2)))
    assert sorted(r.status_code for r in results)==[200,401]
def test_hermes_unconfigured_is_visible(actors, monkeypatch):
    monkeypatch.delenv('HERMES_API_KEY', raising=False)
    c,a,d=actors;conv=c.post('/v1/conversations',headers=a[0]['headers']).json()['id']
    result=c.post(f'/v1/conversations/{conv}/messages',headers=a[0]['headers'],json={'device_id':d,'question':'test-only','from':(now()-timedelta(hours=1)).isoformat(),'to':now().isoformat(),'timezone':'UTC'})
    assert result.status_code==503;assert result.json()['code']=='hermes_unavailable'
def test_export_and_delete(actors):
    c,a,d=actors;assert send(c,a[0],batch(d,[sample()])).status_code==200
    assert c.delete(f'/v1/devices/{d}/data',headers=a[0]['headers'],params={'confirmation':'wrong'}).status_code==422
    assert c.delete(f'/v1/devices/{d}/data',headers=a[0]['headers'],params={'confirmation':'delete_health_data'}).status_code==200
    assert c.get('/v1/export',headers=a[0]['headers'],params={'device_id':d}).json()['samples']==[]

def test_malformed_cursor_is_validation_error(actors):
    import base64, json
    c,a,d=actors
    p={'device_id':d,'from':(now()-timedelta(hours=1)).isoformat(),'to':now().isoformat()}
    for value in ('a', base64.urlsafe_b64encode(json.dumps([{}, []]).encode()).decode()):
        r=c.get('/v1/measurements',headers=a[0]['headers'],params={**p,'cursor':value})
        assert r.status_code==422

def test_confirmation_is_idempotent_and_delivery_requires_consent(actors):
    c,a,d=actors;id=str(uuid4())
    c.post('/v1/alerts',headers=a[0]['headers'],json={'id':id,'device_id':d,'kind':'delivery_test','text':'test only'})
    path=f'/v1/alerts/{id}/receipt';body={'status':'confirmed','note':'test observation'}
    assert c.post(path,headers=a[0]['headers'],json=body).status_code==200
    first=c.get(f'/v1/alerts/{id}/deliveries',headers=a[0]['headers']).json()
    assert c.post(path,headers=a[0]['headers'],json=body).status_code==200
    assert c.get(f'/v1/alerts/{id}/deliveries',headers=a[0]['headers']).json()==first
    c.post('/v1/consents',headers=a[0]['headers'],json={'scope':'remote_alerts','granted':False,'policy_version':'demo-1'})
    assert c.get(f'/v1/alerts/{id}/deliveries',headers=a[0]['headers']).status_code==403

def test_oversized_request_without_declared_length_is_rejected(actors):
    c,a,d=actors
    r=c.post('/v1/measurement-batches',headers={**a[0]['headers'],'Content-Type':'application/json'},content=iter([b' '*600000,b' '*600000]))
    assert r.status_code==413
