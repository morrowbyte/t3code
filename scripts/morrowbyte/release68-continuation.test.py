"""Offline provenance and extraction regressions; no product builds or network."""
import datetime
import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('continuation', Path(__file__).with_name('release68-continuation.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime.datetime(2026, 10, 26, tzinfo=datetime.timezone.utc)


def fixture():
    run = {'id': int(m.RUN), 'run_number': 5, 'run_attempt': 1,
           'repository': {'id': 123, 'full_name': 'morrowbyte/t3code'},
           'head_repository': {'full_name': 'morrowbyte/t3code'}, 'head_sha': m.SOURCE,
           'head_branch': 'main', 'path': m.WORKFLOW, 'event': 'workflow_dispatch',
           'status': 'completed', 'conclusion': 'cancelled'}
    conclusions = {'preflight': 'success', 'build_bundle': 'success', 'Build Morrowbyte Android APK': 'skipped',
                   'build_linux': 'cancelled', 'build_nixos': 'cancelled', 'build_windows': 'cancelled',
                   'publish': 'cancelled', 'publish_android': 'skipped', 'publish_windows': 'cancelled'}
    jobs = {'total_count': len(conclusions), 'jobs': [
        {'name': name, 'conclusion': result, 'head_sha': m.SOURCE, 'status': 'completed',
         'steps': [{'name': 'Build Linux CLI executable', 'conclusion': 'cancelled'}] if name == 'build_linux' else []}
        for name, result in conclusions.items()]}
    artifacts = {'total_count': len(m.PINS), 'artifacts': [
        {'id': int(key), 'name': name, 'digest': 'sha256:' + sha, 'expired': False,
         'expires_at': '2026-10-27T06:47:41Z', 'workflow_run': {
             'id': int(m.RUN), 'head_sha': m.SOURCE, 'repository_id': 123, 'head_repository_id': 123}}
        for key, (name, sha, _) in m.PINS.items()]}
    artifacts['artifacts'].extend({'id': int(key)} for key in m.ORIGIN_ARTIFACT_IDS - set(m.PINS))
    artifacts['total_count'] = len(artifacts['artifacts'])
    return run, jobs, artifacts


class OriginTests(unittest.TestCase):
    def test_original_complete_failure_is_eligible(self):
        m.validate_origin(*fixture(), NOW)

    def test_wrong_source_attempt_repository_and_nonterminal_rejected(self):
        for key, value in [('head_sha', '0' * 40), ('run_attempt', 2), ('status', 'in_progress'),
                           ('path', '.github/workflows/other.yml'), ('run_number', 4)]:
            with self.subTest(key=key):
                run, jobs, artifacts = fixture()
                run[key] = value
                with self.assertRaises(AssertionError):
                    m.validate_origin(run, jobs, artifacts, NOW)

    def test_failed_android_and_other_failure_step_rejected(self):
        for case in ['android', 'linux_step', 'omitted_job']:
            run, jobs, artifacts = fixture()
            if case == 'android':
                next(j for j in jobs['jobs'] if j['name'] == 'Build Morrowbyte Android APK')['conclusion'] = 'failure'
            elif case == 'linux_step':
                next(j for j in jobs['jobs'] if j['name'] == 'build_linux')['conclusion'] = 'failure'
            else:
                jobs['jobs'].pop()
            with self.subTest(case=case), self.assertRaises(AssertionError):
                m.validate_origin(run, jobs, artifacts, NOW)

    def test_mismatched_digest_source_expiry_and_missing_artifact_rejected(self):
        for case in ['digest', 'source', 'expired', 'elapsed', 'missing']:
            run, jobs, artifacts = fixture()
            a = artifacts['artifacts'][0]
            if case == 'digest':
                a['digest'] = 'sha256:' + '0' * 64
            elif case == 'source':
                a['workflow_run']['head_sha'] = '0' * 40
            elif case == 'expired':
                a['expired'] = True
            elif case == 'elapsed':
                a['expires_at'] = '2026-10-25T00:00:00Z'
            else:
                artifacts['artifacts'].pop()
            with self.subTest(case=case), self.assertRaises(AssertionError):
                m.validate_origin(run, jobs, artifacts, NOW)


class ExtractionTests(unittest.TestCase):
    def extract(self, data, expected=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'input.zip'
            archive.write_bytes(data)
            m.extract_verified(archive, expected or hashlib.sha256(data).hexdigest(), root / 'out')
            return {str(p.relative_to(root / 'out')): p.read_bytes() for p in (root / 'out').rglob('*') if p.is_file()}

    def zip(self, name, mode=stat.S_IFREG | 0o644):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as z:
            info = zipfile.ZipInfo(name)
            info.external_attr = mode << 16
            z.writestr(info, b'original signed package bytes')
        return output.getvalue()

    def test_regular_bytes_preserved(self):
        self.assertEqual(self.extract(self.zip('server/dist/file')), {'server/dist/file': b'original signed package bytes'})

    def test_changed_archive_rejected_before_extracting(self):
        with self.assertRaises(AssertionError):
            self.extract(self.zip('safe'), '0' * 64)

    def test_path_escape_special_file_and_symlink_rejected(self):
        for name in ['../escape', '/absolute', 'windows\\escape', 'C:/absolute']:
            with self.subTest(name=name), self.assertRaises(AssertionError):
                self.extract(self.zip(name))
        for mode in [stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600]:
            with self.subTest(mode=mode), self.assertRaises(AssertionError):
                self.extract(self.zip('special', mode))


if __name__ == '__main__':
    unittest.main()
