import pytest
from conftest import validate_test_database_url


@pytest.mark.parametrize('value', [
    None,
    'not-a-url',
    'postgresql+psycopg://test@production.invalid/rareguard_test',
    'postgresql+psycopg://test@127.0.0.1/rareguard',
    'postgresql+psycopg://test@127.0.0.1/rareguard_test?host=production.invalid',
    'postgresql+psycopg://test@127.0.0.1/rareguard_test?dbname=rareguard',
    'postgresql://test@127.0.0.1/rareguard_test',
])
def test_test_database_guard_rejects_unsafe_connections(value):
    with pytest.raises(pytest.UsageError):
        validate_test_database_url(value)


@pytest.mark.parametrize('host', ['127.0.0.1', 'localhost', '[::1]'])
def test_test_database_guard_accepts_only_explicit_loopback_test_database(host):
    value = f'postgresql+psycopg://test@{host}:5432/rareguard_test'
    assert validate_test_database_url(value) == value
