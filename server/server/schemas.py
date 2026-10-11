from datetime import datetime, timezone
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)

def aware(value: datetime):
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('RFC3339 timestamp must include UTC offset')
    return value.astimezone(timezone.utc)

UNITS = {'hr': 'bpm', 'spo2': '%', 'bp_sys': 'mmHg', 'bp_dia': 'mmHg',
         'bp_hr': 'bpm', 'temp': '°C', 'glu': 'mmol/L',
         'stress': 'vendor_scalar', 'hrv': 'vendor_scalar', 'pi': 'vendor_pi'}

class Measurement(Strict):
    sample_id: UUID
    metric: str
    value: float
    unit: str
    observed_at: datetime
    phone_received_at: datetime
    time_basis: Literal['device', 'phone_receive']
    quality: Literal['unknown', 'invalid', 'good', 'poor']
    source: Literal['live_device', 'device_history', 'manual', 'replay', 'synthetic']
    vendor_sequence: int | None = None
    firmware_version: str | None = Field(default=None, max_length=80)
    decoder_version: str = Field(default='efe-mr11-reviewed-1', max_length=80)
    device_local_time: str | None = Field(default=None, max_length=40)

    _time = field_validator('observed_at', 'phone_received_at')(aware)

    @model_validator(mode='after')
    def unit_and_source(self):
        if UNITS.get(self.metric) != self.unit:
            raise ValueError('Unknown metric or mismatched registered unit')
        # Validate wire representability, never clinical reference ranges.
        bounds = (-6553.5, 6553.5) if self.metric == 'temp' else (0, 280.5 if self.metric == 'glu' else 255)
        if not bounds[0] <= self.value <= bounds[1]:
            raise ValueError('Value is outside registered protocol representation')
        if self.source == 'device_history' and self.time_basis == 'phone_receive':
            raise ValueError('Historical reception time cannot stand in for observation time')
        return self

class Ingest(Strict):
    schema_version: Literal[1]
    batch_id: UUID
    device_id: UUID
    app_version: str = Field(max_length=40)
    samples: list[Measurement] = Field(min_length=1, max_length=500)

class PairingExchange(Strict):
    code: str = Field(min_length=12, max_length=100)

class ConsentBody(Strict):
    scope: Literal['upload', 'ai_analysis', 'remote_alerts']
    granted: bool
    policy_version: Literal['demo-1']

class DeviceBody(Strict):
    local_id: UUID
    model: str = Field(max_length=80)
    firmware_version: str | None = Field(default=None, max_length=80)
    protocol_version: str = Field(max_length=80)

class ObservationBody(Strict):
    id: UUID
    device_id: UUID
    occurred_at: datetime
    text: str = Field(min_length=1, max_length=2000)
    _time = field_validator('occurred_at')(aware)

class QuestionBody(Strict):
    device_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    from_: datetime = Field(alias='from')
    to: datetime
    timezone: str
    _time = field_validator('from_', 'to')(aware)

class AlertBody(Strict):
    id: UUID
    device_id: UUID
    kind: Literal['experimental_change', 'data_gap', 'delivery_test']
    text: str = Field(min_length=1, max_length=1000)
    evidence: dict = Field(default_factory=dict)

class ReceiptBody(Strict):
    status: Literal['received', 'confirmed']
    note: str | None = Field(default=None, max_length=2000)

class ExperimentalParameters(Strict):
    enabled: bool = False
    hr_low: float | None = Field(default=None, ge=1, le=255)
    hr_high: float | None = Field(default=None, ge=1, le=255)
    spo2_low: float | None = Field(default=None, ge=1, le=100)
    duration_seconds: int = Field(ge=30, le=3600)
    max_gap_seconds: int = Field(ge=1, le=300)
    required_signals: Literal[1, 2]
    allow_unknown_quality: bool = False

    @model_validator(mode='after')
    def edges(self):
        if self.hr_low is not None and self.hr_high is not None and self.hr_low >= self.hr_high:
            raise ValueError('Lower heart-rate boundary must be below upper boundary')
        signals = int(self.hr_low is not None or self.hr_high is not None) + int(self.spo2_low is not None)
        if self.enabled and (signals < self.required_signals or not self.allow_unknown_quality):
            raise ValueError('MR11 quality is unknown; explicit experimental acceptance and sufficient signals required')
        return self

class PublishConfig(Strict):
    base_version: int = Field(ge=0)
    parameters: ExperimentalParameters
    confirmed_experimental_use: Literal[True]

class AckConfig(Strict):
    version: int = Field(ge=1)
    status: Literal['applied', 'failed']
    reason: str | None = Field(default=None, max_length=200)
