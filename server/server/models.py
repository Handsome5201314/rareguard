from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

def now():
    return datetime.now(timezone.utc)

def uid():
    return str(uuid4())

class Base(DeclarativeBase):
    pass

class ConsoleSession(Base):
    __tablename__ = 'console_sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    family: Mapped[str] = mapped_column(String(36))
    expires: Mapped[datetime] = mapped_column(DateTime(timezone=True))

class Credential(Base):
    __tablename__ = 'credentials'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    family: Mapped[str] = mapped_column(String(36))
    guardian: Mapped[str] = mapped_column(String(36))
    name: Mapped[str] = mapped_column(String(80))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    revoked: Mapped[bool] = mapped_column(default=False)

class Pairing(Base):
    __tablename__ = 'pairings'
    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    family: Mapped[str] = mapped_column(String(36))
    name: Mapped[str] = mapped_column(String(80))
    expires: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed: Mapped[bool] = mapped_column(default=False)

class Consent(Base):
    __tablename__ = 'consents'
    guardian: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope: Mapped[str] = mapped_column(String(30), primary_key=True)
    granted: Mapped[bool]
    version: Mapped[str] = mapped_column(String(30))
    updated: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class Device(Base):
    __tablename__ = 'devices'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    family: Mapped[str] = mapped_column(String(36))
    local_id: Mapped[str] = mapped_column(String(80))
    model: Mapped[str] = mapped_column(String(80))
    firmware: Mapped[str | None] = mapped_column(String(80))
    protocol: Mapped[str] = mapped_column(String(80))
    __table_args__ = (UniqueConstraint('family', 'local_id'),)

class Batch(Base):
    __tablename__ = 'batches'
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), primary_key=True)
    batch_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    receipt: Mapped[dict] = mapped_column(JSONB)

class Sample(Base):
    __tablename__ = 'samples'
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), primary_key=True)
    sample_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    metric: Mapped[str] = mapped_column(String(30))
    value: Mapped[float] = mapped_column(Numeric(12, 4))
    unit: Mapped[str] = mapped_column(String(30))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    phone_received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    stored_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    source: Mapped[str] = mapped_column(String(30))
    quality: Mapped[str] = mapped_column(String(30))
    time_basis: Mapped[str] = mapped_column(String(30))
    evidence: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (Index('samples_metric_time', 'device_id', 'metric', 'observed_at', 'sample_id'),)

class Observation(Base):
    __tablename__ = 'observations'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'))
    guardian: Mapped[str] = mapped_column(String(36))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    text: Mapped[str] = mapped_column(Text)

class Conversation(Base):
    __tablename__ = 'conversations'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    family: Mapped[str] = mapped_column(String(36))
    guardian: Mapped[str] = mapped_column(String(36))

class AiRequest(Base):
    __tablename__ = 'ai_requests'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    conversation_id: Mapped[str] = mapped_column(ForeignKey('conversations.id'))
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'))
    guardian: Mapped[str] = mapped_column(String(36))
    question: Mapped[str] = mapped_column(Text)
    context: Mapped[dict] = mapped_column(JSONB)
    context_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(30), default='queued')
    result: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(String(200))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class Alert(Base):
    __tablename__ = 'alerts'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'))
    creator: Mapped[str] = mapped_column(String(36))
    kind: Mapped[str] = mapped_column(String(30))
    text: Mapped[str] = mapped_column(Text)
    evidence: Mapped[dict] = mapped_column(JSONB)
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    content_hash: Mapped[str] = mapped_column(String(64))

class Delivery(Base):
    __tablename__ = 'deliveries'
    alert_id: Mapped[str] = mapped_column(ForeignKey('alerts.id'), primary_key=True)
    guardian: Mapped[str] = mapped_column(String(36), primary_key=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)

class ConfigVersion(Base):
    __tablename__ = 'config_versions'
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    guardian: Mapped[str] = mapped_column(String(36))
    parameters: Mapped[dict] = mapped_column(JSONB)
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class ConfigAck(Base):
    __tablename__ = 'config_acks'
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), primary_key=True)
    guardian: Mapped[str] = mapped_column(String(36), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str | None] = mapped_column(String(200))
