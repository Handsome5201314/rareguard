from statistics import median
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from datetime import timedelta

def validate_window(start, end, timezone):
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError('Time window must include offsets')
    if not start < end or end-start > timedelta(days=31):
        raise ValueError('Select a positive time window of at most 31 days')
    try:
        ZoneInfo(timezone)
    except ZoneInfoNotFoundError as e:
        raise ValueError('Unknown IANA timezone') from e

def summarize(samples, start, end, timezone):
    validate_window(start, end, timezone)
    result = {'from': start.isoformat(), 'to': end.isoformat(), 'timezone': timezone,
              'status': 'data_available' if samples else 'no_data', 'metrics': {},
              'continuous_coverage': None, 'baseline_status': 'not_established',
              'limitations': ['Sparse samples do not establish continuous monitoring or seizure absence.',
                              'MR11 signal quality is not validated. Historical/experimental values are not medical diagnoses.']}
    for metric in sorted({s.metric for s in samples}):
        records = sorted([s for s in samples if s.metric == metric], key=lambda s: s.observed_at)
        actual = [s for s in records if s.quality != 'invalid' and s.source in ('live_device', 'device_history')]
        values = [float(s.value) for s in actual]
        intervals = [(b.observed_at-a.observed_at).total_seconds() for a,b in zip(actual,actual[1:])]
        result['metrics'][metric] = {'count': len(records), 'usable_numeric_count': len(values),
            'min': min(values) if values else None, 'max': max(values) if values else None,
            'median': median(values) if values else None, 'unit': records[0].unit,
            'first': records[0].observed_at.isoformat(), 'last': records[-1].observed_at.isoformat(),
            'maximum_interval_seconds': max(intervals) if intervals else None,
            'leading_empty_seconds': (records[0].observed_at-start).total_seconds(),
            'trailing_empty_seconds': (end-records[-1].observed_at).total_seconds(),
            'unknown_quality_count': sum(s.quality == 'unknown' for s in records),
            'phone_time_count': sum(s.time_basis == 'phone_receive' for s in records),
            'sources': sorted({s.source for s in records})}
    return result
