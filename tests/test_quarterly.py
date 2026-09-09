from datetime import date
import pytest
import domain
from test_ledger import item, app, client, post


@pytest.mark.parametrize('start,expected', [
    ('2024-01-31', ['2024-04-30', '2024-07-31', '2024-10-31', '2025-01-31']),
    ('2023-11-30', ['2024-02-29', '2024-05-30']),
    ('2024-11-30', ['2025-02-28', '2025-05-30']),
    ('2024-02-29', ['2024-05-29', '2024-08-29', '2024-11-29', '2025-02-28']),
])
def test_quarterly_calendar_anchor(start, expected):
    row = domain.validate(item(cycle='quarterly', next_date=start))
    anchor = row['anchor_day']
    for target in expected:
        row['next_date'] = domain.advance(row)
        assert row['next_date'] == target
        assert row['anchor_day'] == anchor


def test_quarterly_budget_and_window_edges():
    row = domain.validate(item(cycle='quarterly', amount='10.00', next_date='2024-04-30'))
    for today, count, seven in [('2024-03-31', 0, 0), ('2024-04-01', 1, 0),
                                 ('2024-04-23', 1, 0), ('2024-04-24', 1, 1), ('2024-04-30', 1, 1)]:
        result = domain.summary([row], date.fromisoformat(today))
        assert result['monthly_budget'] == '3.33'
        assert len(result['upcoming_30']) == count
        assert len(result['upcoming_7']) == seven
    assert domain.summary([row, row, row], date(2024, 4, 30))['monthly_budget'] == '10.00'


@pytest.mark.parametrize('start,today,expected', [
    ('1900-01-31', '2024-04-01', '2024-04-30'),
    ('1900-02-28', '2024-04-30', '2024-05-28'),
    ('1900-11-30', '2024-02-01', '2024-02-29'),
    ('1900-11-30', '2025-02-01', '2025-02-28'),
    ('2024-01-31', '2024-05-01', None),
    ('2024-01-31', '2024-07-31', '2024-07-31'),
])
def test_quarterly_fast_forward(monkeypatch, start, today, expected):
    row = domain.validate(item(cycle='quarterly', next_date=start))
    original = domain.advance
    calls = 0
    def bounded(r):
        nonlocal calls
        calls += 1
        assert calls <= 4
        return original(r)
    monkeypatch.setattr(domain, 'advance', bounded)
    result = domain.summary([row], date.fromisoformat(today))
    assert [r['next_date'] for r in result['upcoming_30']] == ([expected] if expected else [])
    assert row['next_date'] == start


def test_quarterly_custom_confirmation_and_restore(client):
    created = post(client, '/api/items', item(cycle='quarterly'))
    assert created.status_code == 201
    ident = created.json['id']
    assert client.get('/api/items').json[0]['suggested_next'] == '2024-04-30'
    assert post(client, f'/api/items/{ident}/renew', {
        'actual_date': '2024-01-31', 'next_date': '2024-05-15', 'confirm': True}).status_code == 200
    row = client.get('/api/items').json[0]
    assert row['anchor_day'] == 31
    assert row['suggested_next'] == '2024-08-31'
    assert domain.summary([row], date(2025, 8, 5))['upcoming_30'][0]['next_date'] == '2025-08-31'
    post(client, '/api/items', item(cycle='monthly'))
    original = client.get('/api/export').json
    assert original['version'] == 1
    assert post(client, '/api/restore', {'confirm': True, 'backup': original}).status_code == 200
    assert client.get('/api/export').json == original
    restored = next(r for r in client.get('/api/items').json if r['id'] == ident)
    assert restored['suggested_next'] == '2024-08-31'
    invalid = {**original, 'items': [{**original['items'][0], 'cycle': 'quarter'}]}
    assert post(client, '/api/restore', {'confirm': True, 'backup': invalid}).status_code == 400
    assert client.get('/api/export').json == original


def test_updated_page_and_favicon(client):
    page = client.get('/').text
    assert '私人 · 人民币 ONLY' not in page
    assert 'value="quarterly"' in page
    assert '<details' in page
    assert 'rel="icon"' in page and '/static/favicon.svg' in page
    response = client.get('/static/favicon.svg')
    assert response.status_code == 200
    assert 'image/svg+xml' in response.content_type
    assert '<svg' in response.text
