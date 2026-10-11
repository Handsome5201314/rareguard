import asyncio
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session as DbSession
from starlette.exceptions import HTTPException as StarletteHTTPException
from .db import Session, session
from .models import (AiRequest, Alert, Batch, ConfigAck, ConfigVersion, Consent, Conversation,
                     Credential, Delivery, Device, Observation, Pairing, Sample, now, uid)
from .schemas import (AckConfig, AlertBody, ConsentBody, DeviceBody, Ingest, ObservationBody,
                      PairingExchange, PublishConfig, QuestionBody, ReceiptBody)
from .summary import summarize, validate_window

def digest(value):
    if not isinstance(value, str):
        value = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(value.encode()).hexdigest()

def fail(code, message, status=400):
    raise HTTPException(status, {'code': code, 'message': message})

async def worker_loop():
    from .worker import work_once
    while True:
        try:
            await work_once()
        except SQLAlchemyError:
            # Worker remains observable via readiness; no payloads or secrets logged.
            app.state.worker_error = 'database_unavailable'
        except Exception:
            app.state.worker_error = 'worker_iteration_failed'
        await asyncio.sleep(2)

@asynccontextmanager
async def lifespan(app):
    app.state.worker_error = None
    task = asyncio.create_task(worker_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

app = FastAPI(title='RareGuard single-family API', version='0.1.0', lifespan=lifespan)
from .console import router as console_router
app.include_router(console_router)

@app.middleware('http')
async def request_boundary(request: Request, call_next):
    request.state.request_id = str(uuid4())
    # Do not read or log Authorization or health payload in access logs.
    if request.method in ('POST', 'PUT', 'PATCH'):
        length = request.headers.get('content-length')
        if length and (not length.isdigit() or int(length) > 1048576):
            return JSONResponse(status_code=413, content={'code': 'payload_too_large', 'message': 'Maximum body is 1 MiB', 'request_id': request.state.request_id})
        chunks = []; size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 1048576:
                return JSONResponse(status_code=413, content={'code': 'payload_too_large', 'message': 'Maximum body is 1 MiB', 'request_id': request.state.request_id})
            chunks.append(chunk)
        # Starlette's cached request receive replays this bounded body to the route.
        request._body = b''.join(chunks)
    response = await call_next(request)
    response.headers['X-Request-ID'] = request.state.request_id
    response.headers['Cache-Control'] = 'no-store'
    return response

@app.exception_handler(StarletteHTTPException)
async def http_error(request, error):
    detail = error.detail if isinstance(error.detail, dict) else {'code': 'http_error', 'message': str(error.detail)}
    return JSONResponse(status_code=error.status_code, content={**detail, 'request_id': request.state.request_id})

@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    # Pydantic input can contain private data. Expose paths/messages only.
    return JSONResponse(status_code=422, content={'code': 'invalid_request', 'message': 'Request validation failed',
        'request_id': request.state.request_id, 'details': [{'path': list(e['loc']), 'message': e['msg']} for e in error.errors()]})

@app.exception_handler(SQLAlchemyError)
async def database_error(request, error):
    return JSONResponse(status_code=503, content={'code': 'database_unavailable', 'message': 'Database unavailable; retry later', 'request_id': request.state.request_id})

def actor(authorization: str | None = Header(default=None), db: DbSession = Depends(session)):
    if not authorization or not authorization.startswith('Bearer '):
        fail('authentication_required', 'A paired App credential is required', 401)
    credential = db.scalar(select(Credential).where(Credential.token_hash == digest(authorization[7:]), Credential.revoked.is_(False)))
    if not credential:
        fail('invalid_credential', 'Credential is invalid or revoked', 401)
    return credential

def consent(db, actor, scope):
    value = db.get(Consent, (actor.guardian, scope))
    if not value or not value.granted:
        fail('consent_required', f'Explicit {scope} consent is required', 403)

def device(db, actor, device_id, lock=False):
    query = select(Device).where(Device.id == str(device_id), Device.family == actor.family)
    if lock:
        query = query.with_for_update()
    found = db.scalar(query)
    if not found:
        fail('device_not_found', 'Device is not available to this family', 404)
    return found

@app.get('/healthz')
def health():
    return {'status': 'ok'}

@app.get('/internal/readyz')
def ready(db: DbSession = Depends(session)):
    db.execute(text('SELECT 1'))
    return {'database': 'ready', 'worker_error': app.state.worker_error,
            'hermes': 'configured' if os.getenv('HERMES_BASE_URL') and os.getenv('HERMES_API_KEY') and os.getenv('HERMES_RESTRICTED_CONTEXT_CONFIRMED') == 'true' else 'unconfigured'}

@app.post('/v1/pairings/exchange')
def exchange(body: PairingExchange, db: DbSession = Depends(session)):
    # Long random, one-time, 10-minute codes; row lock prevents double consumption.
    pair = db.scalar(select(Pairing).where(Pairing.code_hash == digest(body.code)).with_for_update())
    if not pair or pair.consumed or pair.expires <= now():
        fail('invalid_pairing_code', 'Pairing code is invalid, used or expired', 401)
    import secrets
    token = secrets.token_urlsafe(48)
    cred = Credential(family=pair.family, guardian=uid(), name=pair.name, token_hash=digest(token))
    pair.consumed = True
    db.add(cred)
    db.commit()
    return {'token': token, 'guardian_id': cred.guardian, 'family_id': cred.family, 'name': cred.name}

@app.get('/v1/me')
def me(a=Depends(actor), db=Depends(session)):
    from .console import service_info
    return {'guardian_id': a.guardian, 'family_id': a.family, 'name': a.name,
            'service': service_info(),
            'consents': {c.scope: c.granted for c in db.scalars(select(Consent).where(Consent.guardian == a.guardian))},
            'devices': [{'id': d.id, 'model': d.model, 'firmware_version': d.firmware} for d in db.scalars(select(Device).where(Device.family == a.family))]}

@app.post('/v1/credentials/revoke')
def revoke(a=Depends(actor), db=Depends(session)):
    cred = db.get(Credential, a.id); cred.revoked = True; db.commit()
    return {'status': 'revoked'}

@app.post('/v1/consents')
def grant(body: ConsentBody, a=Depends(actor), db=Depends(session)):
    db.merge(Consent(guardian=a.guardian, scope=body.scope, granted=body.granted, version=body.policy_version, updated=now()))
    db.commit(); return {'scope': body.scope, 'granted': body.granted}

@app.post('/v1/devices')
def register(body: DeviceBody, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'upload')
    # Family-scoped advisory transaction lock serializes concurrent registration.
    db.execute(text('SELECT pg_advisory_xact_lock(hashtext(:key))'), {'key': a.family})
    d = db.scalar(select(Device).where(Device.family == a.family, Device.local_id == str(body.local_id)))
    if not d:
        d = Device(family=a.family, local_id=str(body.local_id), model=body.model, firmware=body.firmware_version, protocol=body.protocol_version)
        db.add(d)
    else:
        d.firmware = body.firmware_version
    db.commit(); return {'device_id': d.id}

@app.post('/v1/measurement-batches')
def ingest(body: Ingest, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'upload'); d = device(db, a, body.device_id, lock=True)
    canonical = body.model_dump(mode='json'); content_hash = digest(canonical)
    existing = db.get(Batch, (d.id, str(body.batch_id)))
    if existing:
        if existing.content_hash != content_hash:
            fail('batch_content_conflict', 'Same batch ID has different content', 409)
        return existing.receipt
    accepted = duplicates = 0
    for measurement in body.samples:
        content = measurement.model_dump(mode='json'); h = digest(content)
        old = db.get(Sample, (d.id, str(measurement.sample_id)))
        if old:
            if old.content_hash != h:
                fail('sample_content_conflict', 'Same sample ID has different content; entire batch rejected', 409)
            duplicates += 1; continue
        data = measurement.model_dump()
        evidence = {key: data.pop(key) for key in ['vendor_sequence', 'firmware_version', 'decoder_version', 'device_local_time']}
        data['sample_id'] = str(data['sample_id'])
        db.add(Sample(device_id=d.id, content_hash=h, evidence=evidence, **data)); accepted += 1
        db.flush()  # Subsequent same-ID samples in this batch are checked too.
    receipt = {'batch_id': str(body.batch_id), 'status': 'committed', 'accepted': accepted,
               'duplicates': duplicates, 'received_at': now().isoformat()}
    db.add(Batch(device_id=d.id, batch_id=str(body.batch_id), content_hash=content_hash, receipt=receipt))
    db.commit(); return receipt

def samples_in(db, d, start, end):
    return list(db.scalars(select(Sample).where(Sample.device_id == d.id, Sample.observed_at >= start, Sample.observed_at < end).order_by(Sample.observed_at, Sample.sample_id)))

def sample_json(s):
    return {'sample_id': s.sample_id, 'device_id': s.device_id, 'metric': s.metric, 'value': float(s.value), 'unit': s.unit,
            'observed_at': s.observed_at.isoformat(), 'phone_received_at': s.phone_received_at.isoformat(),
            'stored_at': s.stored_at.isoformat(), 'source': s.source, 'quality': s.quality, 'time_basis': s.time_basis, **s.evidence}

@app.get('/v1/measurements')
def measurements(device_id: str, start: datetime = Query(alias='from'), end: datetime = Query(alias='to'),
                 metric: str | None = None, cursor: str | None = None, limit: int = Query(default=200, ge=1, le=500),
                 a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id)
    try: validate_window(start, end, 'UTC')
    except ValueError as e: fail('invalid_window', str(e), 422)
    q = select(Sample).where(Sample.device_id == d.id, Sample.observed_at >= start, Sample.observed_at < end)
    if metric: q = q.where(Sample.metric == metric)
    if cursor:
        import base64, binascii
        try:
            if len(cursor) > 2048: raise ValueError()
            decoded = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
            if not isinstance(decoded, list) or len(decoded) != 2 or not all(isinstance(v,str) for v in decoded): raise ValueError()
            t = datetime.fromisoformat(decoded[0]); sid = decoded[1]
            if t.tzinfo is None: raise ValueError()
        except (ValueError, TypeError, KeyError, IndexError, binascii.Error): fail('invalid_cursor', 'Invalid page cursor', 422)
        q = q.where(or_(Sample.observed_at > t, and_(Sample.observed_at == t, Sample.sample_id > sid)))
    rows = list(db.scalars(q.order_by(Sample.observed_at, Sample.sample_id).limit(limit+1)))
    next_cursor = None
    if len(rows) > limit:
        import base64
        rows = rows[:limit]; s = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps([s.observed_at.isoformat(), s.sample_id]).encode()).decode()
    return {'status': 'data_available' if rows else 'no_data', 'data': [sample_json(s) for s in rows], 'next_cursor': next_cursor}

@app.get('/v1/summaries/night')
def night(device_id: str, start: datetime = Query(alias='from'), end: datetime = Query(alias='to'), timezone: str = 'UTC', a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id)
    try: validate_window(start, end, timezone)
    except ValueError as e: fail('invalid_window', str(e), 422)
    return summarize(samples_in(db, d, start, end), start, end, timezone)

@app.post('/v1/observations')
def observe(body: ObservationBody, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'upload'); d = device(db, a, body.device_id, lock=True)
    previous = db.get(Observation, str(body.id))
    if previous:
        if previous.device_id != d.id or previous.guardian != a.guardian or previous.text != body.text or previous.occurred_at != body.occurred_at:
            fail('observation_conflict', 'Observation ID already has different content', 409)
    else: db.add(Observation(id=str(body.id), device_id=d.id, guardian=a.guardian, occurred_at=body.occurred_at, text=body.text))
    db.commit(); return {'id': str(body.id), 'status': 'committed'}

@app.get('/v1/observations')
def observations(device_id: str, a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id)
    return {'data': [{'id': o.id, 'text': o.text, 'occurred_at': o.occurred_at.isoformat(), 'recorded_at': o.recorded_at.isoformat(), 'guardian_id': o.guardian}
                    for o in db.scalars(select(Observation).where(Observation.device_id == d.id).order_by(Observation.occurred_at.desc()).limit(200))]}

@app.post('/v1/conversations')
def conversation(a=Depends(actor), db=Depends(session)):
    consent(db, a, 'ai_analysis'); c = Conversation(family=a.family, guardian=a.guardian); db.add(c); db.commit()
    return {'id': c.id}

@app.post('/v1/conversations/{conversation_id}/messages', status_code=202)
def question(conversation_id: str, body: QuestionBody, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'ai_analysis'); d = device(db, a, body.device_id)
    c = db.get(Conversation, conversation_id)
    if not c or c.guardian != a.guardian or c.family != a.family: fail('conversation_not_found', 'Conversation unavailable', 404)
    if not (os.getenv('HERMES_BASE_URL') and os.getenv('HERMES_API_KEY') and os.getenv('HERMES_RESTRICTED_CONTEXT_CONFIRMED') == 'true'):
        fail('hermes_unavailable', 'Hermes endpoint and restricted context boundary must be configured on the server', 503)
    try: context = summarize(samples_in(db, d, body.from_, body.to), body.from_, body.to, body.timezone)
    except ValueError as e: fail('invalid_window', str(e), 422)
    context['observations'] = [{'text': o.text, 'occurred_at': o.occurred_at.isoformat()} for o in db.scalars(select(Observation).where(Observation.device_id == d.id, Observation.occurred_at >= body.from_, Observation.occurred_at < body.to))]
    task = AiRequest(conversation_id=c.id, device_id=d.id, guardian=a.guardian, question=body.question,
                     context=context, context_hash=digest(context), deadline=now()+timedelta(minutes=3))
    db.add(task); db.commit(); return {'request_id': task.id, 'status': task.state}

@app.get('/v1/ai-requests/{request_id}')
def ai_result(request_id: str, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'ai_analysis'); task = db.get(AiRequest, request_id)
    if not task or task.guardian != a.guardian: fail('request_not_found', 'Request unavailable', 404)
    device(db, a, task.device_id)
    return {'request_id': task.id, 'status': task.state, 'answer': task.result, 'error': task.error,
            'context_hash': task.context_hash, 'context': task.context, 'created_at': task.created.isoformat()}

@app.post('/v1/alerts')
def alert(body: AlertBody, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'remote_alerts'); d = device(db, a, body.device_id, lock=True)
    h = digest(body.model_dump(mode='json')); previous = db.get(Alert, str(body.id))
    if previous:
        if previous.device_id != d.id or previous.content_hash != h: fail('alert_conflict', 'Alert ID content conflict', 409)
    else:
        db.add(Alert(id=str(body.id), device_id=d.id, creator=a.guardian, kind=body.kind, text=body.text, evidence=body.evidence, content_hash=h)); db.flush()
        guardians = db.scalars(select(Credential).where(Credential.family == a.family, Credential.revoked.is_(False)))
        for guardian in guardians:
            c = db.get(Consent, (guardian.guardian, 'remote_alerts'))
            if c and c.granted: db.add(Delivery(alert_id=str(body.id), guardian=guardian.guardian))
    db.commit(); return {'id': str(body.id), 'status': 'stored', 'delivery_status': 'awaiting_device_receipts'}

@app.get('/v1/alerts')
def alerts(a=Depends(actor), db=Depends(session)):
    consent(db, a, 'remote_alerts')
    records = db.execute(select(Alert, Delivery).join(Delivery).join(Device).where(Device.family == a.family, Delivery.guardian == a.guardian).order_by(Alert.created.desc()).limit(100))
    return {'data': [{'id': alert.id, 'device_id': alert.device_id, 'kind': alert.kind, 'text': alert.text, 'created_at': alert.created.isoformat(), 'evidence': alert.evidence,
                     'received_at': delivery.received_at.isoformat() if delivery.received_at else None,
                     'confirmed_at': delivery.confirmed_at.isoformat() if delivery.confirmed_at else None} for alert, delivery in records]}

@app.post('/v1/alerts/{alert_id}/receipt')
def alert_receipt(alert_id: str, body: ReceiptBody, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'remote_alerts'); alert = db.get(Alert, alert_id)
    if not alert: fail('alert_not_found', 'Alert unavailable', 404)
    device(db, a, alert.device_id)
    row = db.scalar(select(Delivery).where(Delivery.alert_id == alert_id, Delivery.guardian == a.guardian).with_for_update())
    if not row: fail('delivery_not_found', 'No delivery assigned to this guardian', 404)
    if row.received_at is None: row.received_at = now()
    if body.status == 'confirmed' and row.confirmed_at is None: row.confirmed_at = now(); row.note = body.note
    db.commit(); return {'status': body.status}

@app.get('/v1/alerts/{alert_id}/deliveries')
def delivery_status(alert_id: str, a=Depends(actor), db=Depends(session)):
    consent(db, a, 'remote_alerts')
    alert = db.get(Alert, alert_id)
    if not alert: fail('alert_not_found', 'Alert unavailable', 404)
    device(db, a, alert.device_id)
    return {'data': [{'guardian_id': row.guardian, 'received_at': row.received_at.isoformat() if row.received_at else None,
        'confirmed_at': row.confirmed_at.isoformat() if row.confirmed_at else None, 'note': row.note} for row in db.scalars(select(Delivery).where(Delivery.alert_id == alert_id))]}

@app.get('/v1/devices/{device_id}/config')
def config(device_id: str, a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id)
    row = db.scalar(select(ConfigVersion).where(ConfigVersion.device_id == d.id).order_by(ConfigVersion.version.desc()).limit(1))
    return {'version': row.version if row else 0, 'parameters': row.parameters if row else None, 'status': 'published' if row else 'not_configured'}

@app.post('/v1/devices/{device_id}/config')
def publish_config(device_id: str, body: PublishConfig, a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id, lock=True)
    version = db.scalar(select(func.max(ConfigVersion.version)).where(ConfigVersion.device_id == d.id)) or 0
    if body.base_version != version: fail('config_version_conflict', 'Configuration changed; review the latest version', 409)
    db.add(ConfigVersion(device_id=d.id, version=version+1, guardian=a.guardian, parameters=body.parameters.model_dump()))
    db.commit(); return {'version': version+1, 'status': 'published', 'applied': False}

@app.post('/v1/devices/{device_id}/config-acks')
def ack_config(device_id: str, body: AckConfig, a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id)
    if not db.get(ConfigVersion, (d.id, body.version)): fail('config_not_found', 'Published configuration unavailable', 404)
    db.merge(ConfigAck(device_id=d.id, guardian=a.guardian, version=body.version, status=body.status, reason=body.reason)); db.commit()
    return {'status': 'recorded'}

@app.post('/v1/config-proposals/generate')
def proposals(a=Depends(actor)):
    fail('medical_rules_unavailable', 'No reviewed personal-baseline schema; AI proposals remain unavailable', 503)

@app.get('/v1/export')
def export(device_id: str, a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id)
    rows = list(db.scalars(select(Sample).where(Sample.device_id == d.id).order_by(Sample.observed_at, Sample.sample_id)))
    return {'device_id': d.id, 'samples': [sample_json(s) for s in rows]}

@app.delete('/v1/devices/{device_id}/data')
def delete_data(device_id: str, confirmation: str, a=Depends(actor), db=Depends(session)):
    d = device(db, a, device_id, lock=True)
    if confirmation != 'delete_health_data': fail('confirmation_required', 'Explicit deletion confirmation required', 422)
    # Explicit, family-authorized deletion covers derived AI contexts and delivery notes.
    from sqlalchemy import delete
    alert_ids = select(Alert.id).where(Alert.device_id == d.id)
    db.execute(delete(Delivery).where(Delivery.alert_id.in_(alert_ids)))
    for table in [Alert, AiRequest, Observation, Batch, Sample]: db.execute(delete(table).where(table.device_id == d.id))
    db.commit(); return {'status': 'deleted'}
