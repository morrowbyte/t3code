"""Exact .68 continuation: authenticate immutable original APK before reuse."""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

SOURCE = 'b560b5bc8bd4dad4a838033c1e98cc5a81354d14'
RUN = '40281335664'
VERSION = '0.1.4-nightly.20261026.68'
WORKFLOW = '.github/workflows/morrowbyte-release.yml'
WORKFLOW_REF = 'morrowbyte/t3code/' + WORKFLOW + '@refs/heads/main'
ROUTE = 'fa1b95cb16c59c5a6bf92647b1bb3f3ab872c4cb06ef7a0e5e723775fb5c3dcc'
LOCK = 'db45b4aacebe846fca988d07543edcf1751fdd17aeeb22d8a23d77c83662f66f'
PINS = {
    '12632675625': ('morrowbyte-observatory-preflight-' + SOURCE + '-1', 'a3c2b6eddc3e4aecb350747a6f17b17c0fc7e9cc4f1982a1f7cfa7949c76727c', 'preflight'),
    '12632401428': ('morrowbyte-observatory-build-' + SOURCE + '-1', 'b3b60210578f1ba8789c3f883b93da5d8d65cdc4d4774930ff97d23d1c0bd2fc', 'build'),
    '12632401457': ('morrowbyte-js-bundle', '20e79610cd89db54e892486a0e4e5e3cb609f723679567d0a6e7efcf8404cab7', 'js'),
    '12632423295': ('morrowbyte-release-android', '4c0a43d9e73c040d5b5b95698a0ec0e2355b592ed9cb5fa9a7cfea0c61eef24d', 'android'),
    '12632308831': ('morrowbyte-android-build-evidence-' + SOURCE + '-1', '6aca15f91aa6ab1e6851fe81b95287a8e7040259fd773851baf09c8332b3cc3f', 'android-evidence'),
}
ALLOWED_CONTROL_PATHS = {
    WORKFLOW, 'scripts/morrowbyte/release68-continuation.py',
    'scripts/morrowbyte/release68-continuation.test.py',
    'scripts/morrowbyte/nightly-after-ci.test.cjs', 'scripts/morrowbyte/check.sh',
    'apps/server/src/cua/cuaRelease.ts', 'apps/server/src/cua/CuaInstallation.ts',
}


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def api(suffix):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/morrowbyte/t3code/' + suffix]))


def validate_origin(run, jobs, artifacts, now):
    assert run['id'] == int(RUN) and run['run_number'] == 3 and run['run_attempt'] == 1
    assert run['repository']['full_name'] == run['head_repository']['full_name'] == 'morrowbyte/t3code'
    assert run['head_sha'] == SOURCE and run['head_branch'] == 'main'
    assert run['path'] == WORKFLOW and run['event'] == 'workflow_dispatch'
    assert run['status'] == 'completed' and run['conclusion'] == 'failure'
    expected = {'preflight': 'success', 'build_bundle': 'success', 'Build Morrowbyte Android APK': 'success',
                'build_linux': 'failure', 'build_nixos': 'skipped', 'build_windows': 'skipped',
                'publish': 'skipped', 'publish_android': 'skipped', 'publish_windows': 'skipped'}
    assert jobs['total_count'] == len(jobs['jobs']) == len(expected)
    assert {job['name']: job['conclusion'] for job in jobs['jobs']} == expected
    assert all(job['head_sha'] == SOURCE and job['status'] == 'completed' for job in jobs['jobs'])
    linux = next(job for job in jobs['jobs'] if job['name'] == 'build_linux')
    assert [step['name'] for step in linux['steps'] if step['conclusion'] == 'failure'] == ['Build Linux CLI executable']
    assert artifacts['total_count'] == len(artifacts['artifacts']) == len(PINS)
    assert {str(a['id']) for a in artifacts['artifacts']} == set(PINS)
    for artifact in artifacts['artifacts']:
        name, sha, _ = PINS[str(artifact['id'])]
        assert artifact['name'] == name and artifact['digest'] == 'sha256:' + sha and not artifact['expired']
        assert datetime.datetime.fromisoformat(artifact['expires_at'].replace('Z', '+00:00')) > now
        provenance = artifact['workflow_run']
        assert provenance['id'] == int(RUN) and provenance['head_sha'] == SOURCE
        assert provenance['repository_id'] == provenance['head_repository_id'] == run['repository']['id']


def extract_verified(archive, expected_digest, destination):
    assert digest(archive) == expected_digest, 'Original artifact archive digest differs.'
    with zipfile.ZipFile(archive) as zipped:
        infos = zipped.infolist()
        assert len(infos) == len({info.filename for info in infos})
        assert sum(info.file_size for info in infos) < 3_000_000_000
        for info in infos:
            path = PurePosixPath(info.filename)
            mode = info.external_attr >> 16
            assert path.parts and not path.is_absolute() and '..' not in path.parts and '\\' not in info.filename
            assert ':' not in info.filename and not stat.S_ISLNK(mode)
            assert stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)
        destination.mkdir(mode=0o700)
        zipped.extractall(destination)


def verify_payload(root):
    apk_name = 'Morrowbyte-' + VERSION + '-android-arm64.apk'
    android = root / 'android'
    assert {p.name for p in android.iterdir()} == {apk_name, apk_name + '.json', apk_name + '.sha256'}
    apk, receipt_path = android / apk_name, android / (apk_name + '.json')
    receipt = json.loads(receipt_path.read_bytes())
    expected = {'schemaVersion': 1, 'source': SOURCE, 'desktopSource': SOURCE, 'lockSha256': LOCK,
                'version': VERSION, 'versionCode': 68, 'run': RUN, 'attempt': '1',
                'trustedContextSha': SOURCE, 'trustedWorkflowSha': SOURCE, 'trustedWorkflowRef': WORKFLOW_REF,
                'apk': apk_name, 'apkSha256': digest(apk), 'package': 'com.morrowbyte.t3code', 'name': 'Morrowbyte',
                'certificateSha256': '34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2',
                'abis': ['arm64-v8a'], 'signatureVerified': True, 'zip16KB': True, 'elf16KB': True,
                'embeddedBundle': 'assets/index.android.bundle', 'deviceAcceptance': 'not-run'}
    assert all(receipt.get(key) == value for key, value in expected.items()), 'Original APK receipt binding differs.'
    assert (android / (apk_name + '.sha256')).read_text() == f'{digest(apk)}  {apk_name}\n'
    with zipfile.ZipFile(apk) as archive:
        assert hashlib.sha256(archive.read(receipt['embeddedBundle'])).hexdigest() == receipt['embeddedBundleSha256']
    assert receipt['dependencyReportSha256'] == digest(root / 'android-evidence/morrowbyte-android-dependencies.txt')
    return digest(apk), digest(receipt_path)


def main():
    env = os.environ
    assert env['GITHUB_REPOSITORY'] == 'morrowbyte/t3code'
    assert env['CONTINUATION_RUN_ID'] == RUN
    assert env['SOURCE_SHA'] == env['GITHUB_SHA']
    assert env['GITHUB_REF'] == 'refs/heads/main' and env['GITHUB_RUN_ATTEMPT'] == '1'
    assert env['GITHUB_WORKFLOW_REF'] == WORKFLOW_REF
    assert env['GITHUB_WORKFLOW_SHA'] == env['GITHUB_SHA'] and env['GITHUB_SHA'] != SOURCE
    assert git('rev-parse', 'HEAD') == env['SOURCE_SHA'] and not git('status', '--porcelain')
    assert digest(Path('pnpm-lock.yaml')) == LOCK
    subprocess.run(['git', 'fetch', '--no-tags', 'origin', 'main'], check=True)
    control = git('rev-parse', 'FETCH_HEAD')
    assert control == env['GITHUB_SHA'], 'Control source must still be current main.'
    subprocess.run(['git', 'merge-base', '--is-ancestor', SOURCE, control], check=True)
    changed = set(git('diff', '--name-only', SOURCE, control).splitlines())
    assert changed <= ALLOWED_CONTROL_PATHS and WORKFLOW in changed, 'Only the reviewed server loader and continuation tooling may change.'
    loader_pins = {
        'apps/server/src/cua/cuaRelease.ts': 'a99a9529aba05319490b76a5964ce98604dc4299c2984d55af66936904398efd',
        'apps/server/src/cua/CuaInstallation.ts': '8156247097ac2d5dc2bf5e0f09b2191b8a92536a84dca75371b0fdacd4fa283d',
    }
    for path, expected in loader_pins.items():
        assert digest(Path(path)) == expected, 'Server loader differs from reviewed fix.'
    # Mobile/shared/lock/native source remains byte-identical; only the desktop server loader changes.
    origin = api('actions/runs/' + RUN)
    jobs = api('actions/runs/' + RUN + '/attempts/1/jobs?per_page=100')
    metadata = api('actions/runs/' + RUN + '/artifacts?per_page=100')
    validate_origin(origin, jobs, metadata, datetime.datetime.now(datetime.timezone.utc))
    releases = api('releases?per_page=100')
    assert not any(r['tag_name'] == 'v' + VERSION for r in releases), 'This version already has a release.'
    previous = api('actions/workflows/morrowbyte-release.yml/runs?event=workflow_dispatch&per_page=100')
    later = [r for r in previous['workflow_runs'] if r['id'] > int(RUN)]
    assert {r['id'] for r in later} == {40286679208, int(env['GITHUB_RUN_ID'])}, 'Another product continuation exists.'
    prior = next(r for r in later if r['id'] == 40286679208)
    assert prior['status'] == 'completed' and prior['conclusion'] == 'failure'
    assert prior['head_sha'] == 'a336bfde4d2d1c3b197364ce763c3c13200ad3a6'
    root = Path(env['RUNNER_TEMP']) / 'release68'
    root.mkdir(mode=0o700)
    for artifact_id, (_, sha, directory) in PINS.items():
        if directory not in ('android', 'android-evidence'):
            continue
        archive = root / (artifact_id + '.zip')
        with archive.open('wb') as output:
            subprocess.run(['gh', 'api', f'repos/morrowbyte/t3code/actions/artifacts/{artifact_id}/zip'], stdout=output, check=True)
        extract_verified(archive, sha, root / directory)
    apk_sha, apk_receipt_sha = verify_payload(root)
    workflow_bytes = subprocess.check_output(['git', 'show', control + ':' + WORKFLOW])
    receipt = {'source': env['SOURCE_SHA'], 'androidSource': SOURCE, 'version': VERSION, 'originRun': RUN, 'originAttempt': '1',
               'controlSource': control, 'continuationRun': env['GITHUB_RUN_ID'],
               'workflowSha256': hashlib.sha256(workflow_bytes).hexdigest(),
               'reusedArtifacts': [{'id': artifact_id, 'name': name, 'archiveSha256': sha} for artifact_id, (name, sha, directory) in PINS.items() if directory in ('android', 'android-evidence')],
               'files': [{'path': str(p.relative_to(root)), 'sha256': digest(p)}
                         for directory in ['android'] for p in sorted((root / directory).rglob('*')) if p.is_file()]}
    (root / 'CONTINUATION68.json').write_text(json.dumps(receipt, indent=2) + '\n')
    values = {'version': VERSION, 'android_version_code': '68', 'tag': 'v' + VERSION,
              'recovery_workflow_sha256': receipt['workflowSha256'],
              'android_source_sha': SOURCE, 'android_desktop_source_sha': SOURCE, 'android_lock_sha256': LOCK,
              'apk_sha256': apk_sha, 'apk_receipt_sha256': apk_receipt_sha}
    with open(env['GITHUB_OUTPUT'], 'a') as output:
        output.writelines(f'{key}={value}\n' for key, value in values.items())
    print(json.dumps({'status': 'verified', 'source': env['SOURCE_SHA'], 'androidSource': SOURCE, 'version': VERSION, 'originRun': RUN,
                      'retainedArtifacts': 2, 'apkSha256': apk_sha}))


if __name__ == '__main__':
    main()
