import sys
import json
import multiprocessing
import time
import fcntl
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from codex_quota import normalize, sanitize, admission_denied, _rpc


def _quota_worker(cache_path, command, refresh, result_queue):
    import codex_quota as quota
    try:
        result, cached = quota.read_quota(command, refresh=refresh, cache_path=Path(cache_path), timeout=5)
        result_queue.put(("ok", cached, result["pressure_percent"]))
    except Exception as exc:
        result_queue.put(("error", type(exc).__name__, str(exc)))


def _fake_rpc_command(counter_path, delay="0.2", fail=False):
    script = "import pathlib, sys, time; p=pathlib.Path(sys.argv[1]); p.open('a').write('call\\n'); time.sleep(float(sys.argv[2])); sys.stdin.readline(); sys.exit(7) if sys.argv[3]=='fail' else print('{\"id\":1,\"result\":{}}\\n{\"id\":2,\"result\":{\"rateLimits\":{\"limitId\":\"codex\",\"primary\":{\"usedPercent\":25,\"windowDurationMins\":10080,\"resetsAt\":4102444800}}}}', flush=True)"
    return [sys.executable, "-c", script, str(counter_path), delay, "fail" if fail else "ok"]


def _run_workers(cache_path, command, refresh, count=4):
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()
    workers = [ctx.Process(target=_quota_worker, args=(str(cache_path), command, refresh, queue)) for _ in range(count)]
    for worker in workers:
        worker.start()
    results = [queue.get(timeout=10) for _ in workers]
    for worker in workers:
        worker.join(timeout=10)
        assert worker.exitcode == 0
    return results


def _temp_path_test(function):
    def wrapper():
        with tempfile.TemporaryDirectory() as directory:
            return function(Path(directory))
    wrapper.__name__ = function.__name__
    return wrapper


def test_normalizes_windows_and_clamps_pressure():
    data = normalize({"rateLimits": {"limitId": "default",
        "primary": {"windowDurationMins": 60, "usedPercent": 120, "resetsAt": 2000},
        "secondary": {"windowDurationMins": 10080, "remainingPercent": 25, "resetsAt": 2000}}}, now=1000)
    assert data["buckets"][0]["windows"][0]["used_percent"] == 100
    assert data["buckets"][0]["windows"][0]["kind"] == "short"
    assert data["buckets"][0]["windows"][1]["kind"] == "weekly"
    assert data["pressure_percent"] == 100


def test_missing_window_and_stale_reset_are_unknown():
    data = normalize({"rateLimits": {"limitId": "x",
        "primary": {"windowDurationMins": 5, "usedPercent": 90, "resetsAt": 999},
        "secondary": {"windowDurationMins": 5}}}, now=1000)
    assert data["buckets"][0]["windows"][0]["reset"] == "unknown"
    assert data["buckets"][0]["windows"][0]["used_percent"] == 90
    assert data["buckets"][0]["windows"][1]["reset"] == "unknown"


def test_target_pace_formula():
    # 53% used and 63% of a 100-minute window elapsed => -10 pace delta.
    data = normalize({"rateLimits": {"primary": {"windowDurationMins": 100, "usedPercent": 53, "resetsAt": 12220}}}, now=10000)
    window = data["buckets"][0]["windows"][0]
    assert round(window["elapsed_fraction"], 2) == 0.63
    assert round(window["target_used_percent"]) == 63
    assert round(window["pace_delta"]) == -10


def test_credits_preserved_and_identity_removed():
    raw = {"credits": {"balance": 2, "rateLimitResetCredits": 1}, "account": {"email": "x"}, "token": "secret"}
    data = normalize(raw)
    assert data["credit_risk"] == "positive"
    assert "account" not in data["raw"]
    assert "token" not in data["raw"]
    assert data["raw"]["credits"]["rateLimitResetCredits"] == 1


def test_empty_response_is_graceful():
    assert normalize({})["buckets"] == []


def test_official_nested_credits_and_spend_stop():
    snapshot = {'limitId':'codex', 'credits': {'balance':'0', 'hasCredits':False, 'unlimited':False},
                'primary': {'usedPercent':63, 'windowDurationMins':100, 'resetsAt':12820},
                'secondary':None, 'spendControlReached':False}
    data = normalize({'rateLimits':snapshot, 'rateLimitsByLimitId':{'codex':snapshot}}, now=10000)
    assert data['credit_risk'] == 'none'
    assert round(data['buckets'][0]['windows'][0]['pace_delta']) == 10
    assert not admission_denied(data)
    snapshot['spendControlReached'] = True
    assert admission_denied(normalize({'rateLimits':snapshot}, now=10000))
    snapshot['spendControlReached'] = False
    snapshot['credits']['balance'] = '1'
    assert admission_denied(normalize({'rateLimits':snapshot}, now=10000))


def test_no_windows_unknown_numbers_and_earned_resets():
    raw = {'rateLimits': {'credits':{'hasCredits':False,'balance':'0'}, 'primary':None},
           'rateLimitResetCredits': {'availableCount':3}}
    assert admission_denied(normalize(raw))
    raw['rateLimits']['primary'] = {'usedPercent':float('nan'),'windowDurationMins':300,'resetsAt':20000}
    data = normalize(raw, now=10000)
    assert data['credit_risk'] == 'none'  # Earned reset credits aren't purchased credits.
    assert admission_denied(data)


def test_secondary_credit_and_null_bucket_fail_closed():
    snapshot = {'credits': {'balance':'0','hasCredits':False},
                'primary':{'usedPercent':1,'windowDurationMins':300,'resetsAt':20000}}
    raw = {'rateLimits':snapshot, 'rateLimitsByLimitId':{'codex':snapshot, 'secondary':None}}
    assert admission_denied(normalize(raw, now=10000))
    raw['rateLimitsByLimitId']['secondary'] = {**snapshot, 'credits':{'available':1}}
    assert admission_denied(normalize(raw, now=10000))
    raw['rateLimitsByLimitId']['secondary']['credits'] = {'remaining':1}
    assert admission_denied(normalize(raw, now=10000))


def test_rpc_partial_line_times_out_and_batches_do_not_stall():
    import time
    start = time.monotonic()
    try:
        _rpc([sys.executable, '-c', 'import sys,time;sys.stdout.write("{");sys.stdout.flush();time.sleep(10)'], timeout=.15)
        assert False, 'Expected timeout'
    except TimeoutError:
        assert time.monotonic() - start < 2
    stub = 'import sys;sys.stdin.readline();print(\'{"id":1,"result":{}}\\n{"id":2,"result":{"rateLimits":null}}\',flush=True);sys.stdin.read()'
    assert _rpc([sys.executable, '-c', stub], timeout=1) == {'rateLimits':None}


def test_rpc_failure_classification_is_secret_safe():
    import codex_quota as quota
    cases = [
        ('import sys;sys.stdin.readline()', 'unexpected_eof'),
        ('import sys;sys.stdin.readline();print(\'{"id":1,"error":{"message":"private-sentinel"}}\',flush=True);sys.stdin.read()', 'initialization_failed'),
        ('import sys;sys.stdin.readline();print(\'{"id":1,"result":{}}\\n{"id":2,"error":{"message":"private-sentinel"}}\',flush=True);sys.stdin.read()', 'quota_rpc_failed'),
        ('import sys;sys.stdin.readline();print(\'{"id":1,"result":{}}\\n{"id":2,"result":null}\',flush=True);sys.stdin.read()', 'invalid_response'),
    ]
    for stub, reason in cases:
        try:
            _rpc([sys.executable, '-c', stub], timeout=1)
            assert False, 'Expected failure'
        except quota.QuotaRPCError as exc:
            assert quota.failure_reason(exc) == reason
            assert 'private-sentinel' not in str(exc)


def test_cli_unavailable_stays_closed_and_redacts_errors():
    import contextlib
    import io
    from unittest.mock import patch
    import codex_quota as quota
    for exc, reason in [(TimeoutError('private-sentinel'), 'timeout'),
                        (FileNotFoundError('private-sentinel'), 'executable_missing'),
                        (PermissionError('private-sentinel'), 'permission_denied'),
                        (RuntimeError('private-sentinel'), 'unknown_failure')]:
        for args in [['--check'], ['--json']]:
            out, err = io.StringIO(), io.StringIO()
            with patch.object(quota, 'read_quota', side_effect=exc) as read, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                assert quota.main(args) == 2
                assert read.call_count == 1
            assert err.getvalue() == f'quota unavailable: {reason}\n'
            assert 'private-sentinel' not in out.getvalue() + err.getvalue()


@_temp_path_test
def test_concurrent_cold_reads_singleflight(tmp_path):
    counter = tmp_path / "calls"
    results = _run_workers(tmp_path / "cache.json", _fake_rpc_command(counter), refresh=False)
    assert all(result[0] == "ok" for result in results)
    assert sum(result[1] is False for result in results) == 1
    assert len(counter.read_text().splitlines()) == 1


@_temp_path_test
def test_lock_timeout_is_bounded(tmp_path):
    import codex_quota as quota
    cache = tmp_path / "cache.json"
    with cache.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        started = time.monotonic()
        try:
            quota.read_quota(_fake_rpc_command(tmp_path / "calls"), cache_path=cache, timeout=0.2)
            assert False, "Expected lock timeout"
        except TimeoutError:
            assert time.monotonic() - started < 1.0
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


@_temp_path_test
def test_stale_cache_and_rpc_failure_never_admits_stale(tmp_path):
    import codex_quota as quota
    cache = tmp_path / "cache.json"
    stale = {"timestamp": time.time() - quota.CACHE_SECONDS - 1, "data": {"raw": {"rateLimits": {}}, "checked_at": "stale"}}
    cache.write_text(json.dumps(stale))
    try:
        quota.read_quota(_fake_rpc_command(tmp_path / "calls", fail=True), cache_path=cache, timeout=2)
        assert False, "Expected RPC failure"
    except AssertionError:
        raise
    except Exception:
        pass
    assert json.loads(cache.read_text())["data"]["checked_at"] == "stale"


@_temp_path_test
def test_forced_refresh_coalesces_overlapping_reads(tmp_path):
    counter = tmp_path / "calls"
    cache = tmp_path / "cache.json"
    cache.write_text(json.dumps({"timestamp": time.time(), "data": {"raw": {"rateLimits": {}}, "checked_at": "old"}}))
    results = _run_workers(cache, _fake_rpc_command(counter), refresh=True)
    assert all(result[0] == "ok" for result in results)
    assert sum(result[1] is False for result in results) == 1
    assert len(counter.read_text().splitlines()) == 1


@_temp_path_test
def test_lock_released_after_rpc_failure(tmp_path):
    import codex_quota as quota
    counter = tmp_path / "calls"
    cache = tmp_path / "cache.json"
    try:
        quota.read_quota(_fake_rpc_command(counter, fail=True), cache_path=cache, timeout=2)
        assert False, "Expected RPC failure"
    except AssertionError:
        raise
    except Exception:
        pass
    result, cached = quota.read_quota(_fake_rpc_command(counter), cache_path=cache, timeout=2)
    assert result["pressure_percent"] == 25
    assert cached is False
    assert len(counter.read_text().splitlines()) == 2


def load_tests(loader, tests, pattern):
    """Expose the function-style cases to standard unittest discovery."""
    return unittest.TestSuite(
        unittest.FunctionTestCase(fn)
        for name, fn in globals().items()
        if name.startswith('test_') and callable(fn)
    )


if __name__ == '__main__':
    import unittest
    suite = unittest.TestSuite(unittest.FunctionTestCase(fn) for name,fn in list(globals().items())
                               if name.startswith('test_') and callable(fn))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
