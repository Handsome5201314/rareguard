"""Single-family, password-protected console. App credentials stay separate."""
import hashlib
import html
import hmac
import os
import secrets
import time
from collections import deque
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from .db import session
from .models import (AiRequest, Alert, Batch, ConsoleSession, Consent, Credential,
                     Delivery, Device, Pairing, Sample, now)

router = APIRouter(prefix='/console')
COOKIE = '__Secure-rareguard_console'
CSRF_COOKIE = '__Secure-rareguard_csrf'
attempts = deque(maxlen=100)

def hashed(value): return hashlib.sha256(value.encode()).hexdigest()

def service_info():
    configured = bool(os.getenv('HERMES_BASE_URL') and os.getenv('HERMES_API_KEY') and os.getenv('HERMES_RESTRICTED_CONTEXT_CONFIRMED') == 'true')
    return {'hermes_configured': configured, 'hermes_profile': os.getenv('HERMES_PROFILE') if configured else None,
            'hermes_web_url': os.getenv('HERMES_WEB_URL'), 'console_url': os.getenv('RAREGUARD_CONSOLE_URL')}

def cookie_path():
    return urlsplit(os.getenv('RAREGUARD_CONSOLE_URL', 'https://rareguard.tongyimoheai.top/console')).path.rstrip('/')

def origin_required(request):
    base = urlsplit(os.getenv('RAREGUARD_CONSOLE_URL', 'https://rareguard.tongyimoheai.top/console'))
    if request.headers.get('origin') != base.scheme + '://' + base.netloc:
        raise HTTPException(403, {'code':'console_origin_rejected', 'message':'请从控制台页面提交操作'})

def password_matches(password, encoded):
    try:
        algorithm, rounds, salt, expected = encoded.split('$')
        if algorithm != 'pbkdf2_sha256' or not 100000 <= int(rounds) <= 1000000: return False
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(rounds)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError): return False

def console_actor(request: Request, db=Depends(session)):
    token = request.cookies.get(COOKIE, '')
    row = db.get(ConsoleSession, hashed(token)) if token else None
    if not row or row.expires <= now() or row.family != os.getenv('RAREGUARD_CONSOLE_FAMILY_ID'):
        raise HTTPException(401, {'code':'console_login_required', 'message':'登录已失效，请重新登录'})
    return row

def console_write(request: Request, a=Depends(console_actor)):
    origin_required(request)
    csrf = request.headers.get('x-csrf-token', '')
    if not csrf or not hmac.compare_digest(hashed(csrf), a.csrf_hash):
        raise HTTPException(403, {'code':'console_csrf_rejected', 'message':'请刷新页面后重试'})
    return a

def page():
    content = (Path(__file__).parent/'web'/'console.html').read_text(encoding='utf-8')
    return HTMLResponse(content.replace('{{console_path}}', html.escape(cookie_path(), quote=True)), headers={
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'})

@router.get('', include_in_schema=False)
@router.get('/', include_in_schema=False)
def index(request: Request, db=Depends(session)):
    try: console_actor(request, db)
    except HTTPException: return RedirectResponse(cookie_path()+'/login', status_code=303)
    return page()

@router.get('/login', include_in_schema=False)
def login_page(): return page()

@router.get('/assets/{name}', include_in_schema=False)
def asset(name: str):
    if name not in ('console.js','console.css'): raise HTTPException(404)
    return Response((Path(__file__).parent/'web'/name).read_text(encoding='utf-8'),
        media_type='application/javascript' if name.endswith('.js') else 'text/css', headers={'X-Content-Type-Options':'nosniff'})

class Login(BaseModel):
    username: str = Field(min_length=1,max_length=80)
    password: str = Field(min_length=1,max_length=256)

@router.post('/login')
def login(body: Login, request: Request, db=Depends(session)):
    origin_required(request)
    stamp = time.monotonic()
    while attempts and attempts[0] < stamp-300: attempts.popleft()
    if len(attempts)>=10: raise HTTPException(429, {'code':'console_rate_limited','message':'尝试次数过多，请 5 分钟后重试'})
    attempts.append(stamp)
    username, encoded, family = (os.getenv(k,'') for k in ('RAREGUARD_CONSOLE_USERNAME','RAREGUARD_CONSOLE_PASSWORD_HASH','RAREGUARD_CONSOLE_FAMILY_ID'))
    if not username or not encoded or not family: raise HTTPException(503, {'code':'console_not_configured','message':'控制台登录尚未配置'})
    password_ok = password_matches(body.password,encoded)
    if not hmac.compare_digest(body.username.encode(),username.encode()) or not password_ok:
        raise HTTPException(401, {'code':'console_invalid_login','message':'用户名或密码不正确'})
    token, csrf = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
    db.execute(delete(ConsoleSession).where(ConsoleSession.expires<=now()))
    db.add(ConsoleSession(token_hash=hashed(token),csrf_hash=hashed(csrf),family=family,expires=now()+timedelta(hours=6))); db.commit()
    response=JSONResponse({'status':'authenticated'})
    response.set_cookie(COOKIE,token,secure=True,httponly=True,samesite='strict',path=cookie_path(),max_age=21600)
    response.set_cookie(CSRF_COOKIE,csrf,secure=True,httponly=False,samesite='strict',path=cookie_path(),max_age=21600)
    return response

@router.post('/logout')
def logout(a=Depends(console_write), db=Depends(session)):
    db.execute(delete(ConsoleSession).where(ConsoleSession.token_hash==a.token_hash)); db.commit()
    response=JSONResponse({'status':'signed_out'})
    for name in (COOKIE,CSRF_COOKIE): response.delete_cookie(name,path=cookie_path(),secure=True,samesite='strict')
    return response

@router.get('/data')
def data(a=Depends(console_actor), db=Depends(session)):
    devices=list(db.scalars(select(Device).where(Device.family==a.family))); ids=[d.id for d in devices]
    guardians=list(db.scalars(select(Credential).where(Credential.family==a.family,Credential.revoked.is_(False))))
    metrics=db.execute(select(Sample.metric,Sample.quality,func.count(),func.max(Sample.phone_received_at)).where(Sample.device_id.in_(ids)).group_by(Sample.metric,Sample.quality)).all()
    latest=db.scalars(select(Sample).where(Sample.device_id.in_(ids)).order_by(Sample.phone_received_at.desc()).limit(20))
    tasks=db.scalars(select(AiRequest).where(AiRequest.device_id.in_(ids)).order_by(AiRequest.created.desc()).limit(10))
    alerts=db.scalars(select(Alert).where(Alert.device_id.in_(ids)).order_by(Alert.created.desc()).limit(10))
    return {'generated_at':now().isoformat(),'service':service_info(),
        'devices':[{'id':d.id,'model':d.model,'firmware':d.firmware,'protocol':d.protocol} for d in devices],
        'guardians':[{'name':g.name,'consents':{c.scope:c.granted for c in db.scalars(select(Consent).where(Consent.guardian==g.guardian))}} for g in guardians],
        'batch_count':db.scalar(select(func.count()).select_from(Batch).where(Batch.device_id.in_(ids))),
        'metrics':[{'metric':m,'quality':q,'count':n,'last_received':t.isoformat()} for m,q,n,t in metrics],
        'latest_samples':[{'metric':s.metric,'value':float(s.value),'unit':s.unit,'received_at':s.phone_received_at.isoformat(),'source':s.source,'quality':s.quality,'time_basis':s.time_basis} for s in latest],
        'ai_requests':[{'created_at':t.created.isoformat(),'status':t.state,'attempts':t.attempts,'error':t.error,'answer':t.result} for t in tasks],
        'alerts':[{'created_at':r.created.isoformat(),'kind':r.kind,'text':r.text,
            'assigned':db.scalar(select(func.count()).select_from(Delivery).where(Delivery.alert_id==r.id)),
            'received':db.scalar(select(func.count()).select_from(Delivery).where(Delivery.alert_id==r.id,Delivery.received_at.is_not(None))),
            'confirmed':db.scalar(select(func.count()).select_from(Delivery).where(Delivery.alert_id==r.id,Delivery.confirmed_at.is_not(None)))} for r in alerts]}

class PairBody(BaseModel):
    name: str = Field(min_length=1,max_length=80)

@router.post('/pairings')
def pairing(body: PairBody, a=Depends(console_write), db=Depends(session)):
    code=secrets.token_urlsafe(24)
    db.add(Pairing(code_hash=hashed(code),family=a.family,name=body.name,expires=now()+timedelta(minutes=10))); db.commit()
    return {'code':code,'expires_in_minutes':10}
