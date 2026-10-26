"""Exact .68 continuation: authenticate immutable original artifacts before reuse."""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import zipfile

SOURCE = 'be6292cd24dfe799ce9fcabed5a125c324ae5d06'
RUN = '40291055865'
VERSION = '0.1.4-nightly.20261026.68'
WORKFLOW = '.github/workflows/morrowbyte-release.yml'
WORKFLOW_REF = 'morrowbyte/t3code/' + WORKFLOW + '@refs/heads/main'
ROUTE = 'fa1b95cb16c59c5a6bf92647b1bb3f3ab872c4cb06ef7a0e5e723775fb5c3dcc'
LOCK = 'db45b4aacebe846fca988d07543edcf1751fdd17aeeb22d8a23d77c83662f66f'
PINS = {
    '12636263593': ('morrowbyte-observatory-preflight-' + SOURCE + '-1', '281aeed6c02740ebf32739e58275a09341d367e5904bb2c382dfdefc4ba82db5', 'preflight'),
    '12635969252': ('morrowbyte-observatory-build-' + SOURCE + '-1', '8a752190aed0f13e79ce0ff127d58656a084eefbf73fc775246d1d9e21e8f275', 'build'),
    '12636662871': ('morrowbyte-js-bundle', '36c2b37422e38c6be5899137d5e9a9d81f0f3bc6be9eca9467886af19ae20a44', 'js'),
}
ANDROID_RUN = '40293470700'
ANDROID_CONTROL = '4e5b01b01bbdc4bc3c0ebc27ba41c3065655db7a'
ANDROID_ARTIFACT = '12637941853'
ANDROID_ARCHIVE_SHA = 'af5d96340484a630cdc7ed92bc0fb010c51d24837c6a0a9ae5daf38fb7ddb369'
APK_SHA = 'cf6588e9deef851b65373fe581f5b79d8d33208a227e6786b267f0512e4d4e99'
APK_RECEIPT_SHA = '6a86c0a7f529d20867b16bdefdc837b3e6125e499d26bb44d8b6570c457c3b1e'
PACKAGING_SHA = '3c92242cca359b2b6a1823413dca676b63972acca13cba3f439d211b0ba66c06'
ORIGIN_ARTIFACT_IDS = {*PINS, '12636602591', '12636297381'}
ALLOWED_CONTROL_PATHS = {
    WORKFLOW, 'scripts/build-desktop-artifact.ts', 'scripts/build-desktop-artifact.test.ts',
    'scripts/morrowbyte/release68-continuation.py',
    'scripts/morrowbyte/release68-continuation.test.py',
    'scripts/morrowbyte/nightly-after-ci.test.cjs', 'scripts/morrowbyte/check.sh',
}


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def api(suffix):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/morrowbyte/t3code/' + suffix]))


def validate_origin(run, jobs, artifacts, now):
    assert run['id'] == int(RUN) and run['run_number'] == 5 and run['run_attempt'] == 1
    assert run['repository']['full_name'] == run['head_repository']['full_name'] == 'morrowbyte/t3code'
    assert run['head_sha'] == SOURCE and run['head_branch'] == 'main'
    assert run['path'] == WORKFLOW and run['event'] == 'workflow_dispatch'
    assert run['status'] == 'completed' and run['conclusion'] == 'cancelled'
    expected = {'preflight': 'success', 'build_bundle': 'success', 'Build Morrowbyte Android APK': 'skipped',
                'build_linux': 'cancelled', 'build_nixos': 'cancelled', 'build_windows': 'cancelled',
                'publish': 'cancelled', 'publish_android': 'skipped', 'publish_windows': 'cancelled'}
    assert jobs['total_count'] == len(jobs['jobs']) == len(expected)
    assert {job['name']: job['conclusion'] for job in jobs['jobs']} == expected
    assert all(job['head_sha'] == SOURCE and job['status'] == 'completed' for job in jobs['jobs'])
    assert artifacts['total_count'] == len(artifacts['artifacts']) == len(ORIGIN_ARTIFACT_IDS)
    assert {str(a['id']) for a in artifacts['artifacts']} == ORIGIN_ARTIFACT_IDS
    for artifact in artifacts['artifacts']:
        if str(artifact['id']) not in PINS:
            continue
        name, sha, _ = PINS[str(artifact['id'])]
        assert artifact['name'] == name and artifact['digest'] == 'sha256:' + sha and not artifact['expired']
        assert datetime.datetime.fromisoformat(artifact['expires_at'].replace('Z', '+00:00')) > now
        provenance = artifact['workflow_run']
        assert provenance['id'] == int(RUN) and provenance['head_sha'] == SOURCE
        assert provenance['repository_id'] == provenance['head_repository_id'] == run['repository']['id']


def validate_android_origin(run, jobs, artifacts, now):
    assert run['id'] == int(ANDROID_RUN) and run['run_number'] == 6 and run['run_attempt'] == 1
    assert run['repository']['full_name'] == run['head_repository']['full_name'] == 'morrowbyte/t3code'
    assert run['head_sha'] == ANDROID_CONTROL and run['head_branch'] == 'main'
    assert run['path'] == WORKFLOW and run['event'] == 'workflow_dispatch'
    assert run['status'] == 'completed' and run['conclusion'] == 'failure'
    expected = {'preflight': 'success', 'build_bundle': 'skipped', 'Build Morrowbyte Android APK': 'success',
                'build_linux': 'failure', 'build_nixos': 'skipped', 'build_windows': 'skipped',
                'publish': 'skipped', 'publish_android': 'skipped', 'publish_windows': 'skipped'}
    assert jobs['total_count'] == len(jobs['jobs']) == len(expected)
    assert {job['name']: job['conclusion'] for job in jobs['jobs']} == expected
    assert all(job['head_sha'] == ANDROID_CONTROL and job['status'] == 'completed' for job in jobs['jobs'])
    linux = next(job for job in jobs['jobs'] if job['name'] == 'build_linux')
    assert [step['name'] for step in linux['steps'] if step['conclusion'] == 'failure'] == ['Build Linux AppImage and updater metadata']
    assert artifacts['total_count'] == len(artifacts['artifacts']) == 6
    assert {str(a['id']) for a in artifacts['artifacts']} == {'12637941853', '12637920360', '12637875258', '12637800388', '12637690993', '12636988434'}
    artifact = next(a for a in artifacts['artifacts'] if str(a['id']) == ANDROID_ARTIFACT)
    assert artifact['name'] == 'morrowbyte-release-android' and artifact['size_in_bytes'] == 56400077
    assert artifact['digest'] == 'sha256:' + ANDROID_ARCHIVE_SHA and not artifact['expired']
    assert datetime.datetime.fromisoformat(artifact['expires_at'].replace('Z', '+00:00')) > now
    origin = artifact['workflow_run']
    assert origin['id'] == int(ANDROID_RUN) and origin['head_sha'] == ANDROID_CONTROL
    assert origin['repository_id'] == origin['head_repository_id'] == run['repository']['id']


def verify_android_payload(directory):
    name = f'Morrowbyte-{VERSION}-android-arm64.apk'
    assert sorted(p.name for p in directory.iterdir()) == sorted([name, name + '.json', name + '.sha256'])
    assert digest(directory / name) == APK_SHA
    receipt_path = directory / (name + '.json')
    assert digest(receipt_path) == APK_RECEIPT_SHA
    assert (directory / (name + '.sha256')).read_text() == f'{APK_SHA}  {name}\n'
    receipt = json.loads(receipt_path.read_bytes())
    expected = {'schemaVersion': 1, 'source': SOURCE, 'desktopSource': SOURCE, 'version': VERSION,
                'versionCode': 68, 'lockSha256': LOCK, 'run': ANDROID_RUN, 'attempt': '1',
                'trustedContextSha': ANDROID_CONTROL, 'trustedWorkflowSha': ANDROID_CONTROL,
                'trustedWorkflowRef': WORKFLOW_REF, 'apk': name, 'apkSha256': APK_SHA,
                'package': 'com.morrowbyte.t3code', 'name': 'Morrowbyte',
                'certificateSha256': '34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2',
                'abis': ['arm64-v8a'], 'signatureVerified': True, 'zip16KB': True, 'elf16KB': True,
                'deviceAcceptance': 'not-run'}
    assert all(receipt.get(key) == value for key, value in expected.items())


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


def verify_payload(root, check_sha):
    pre_path, built_path = root / 'preflight/receipt.json', root / 'build/receipt.json'
    pre, built = json.loads(pre_path.read_bytes()), json.loads(built_path.read_bytes())
    for receipt in [pre, built]:
        assert receipt['source'] == SOURCE and receipt['run'] == RUN and receipt['attempt'] == '1'
        assert receipt['lockSha256'] == LOCK
        assert receipt['trustedContextSha'] == receipt['trustedWorkflowSha'] == SOURCE
        assert receipt['trustedWorkflowRef'] == WORKFLOW_REF
    assert pre['effectiveSourceSha'] == SOURCE and pre['status'] == 'generated-unreviewed'
    assert pre['generatorVersion'] == '1.167.12' and pre['config'] == {'autoCodeSplitting': True}
    assert pre['checkScriptSha256'] == check_sha
    assert pre['beforeSha256'] == pre['afterSha256'] == built['generatedRouteSha256'] == ROUTE
    assert digest(root / 'preflight/routeTree.gen.ts') == digest(root / 'build/routeTree.gen.ts') == ROUTE
    assert (root / 'preflight/routeTree.diff').is_file()
    assert built['preflightReceiptSha256'] == digest(pre_path)
    assert (root / 'js/server/dist').is_dir() and (root / 'js/desktop/dist-electron').is_dir()


def main():
    env = os.environ
    assert env['GITHUB_REPOSITORY'] == 'morrowbyte/t3code'
    assert env['SOURCE_SHA'] == SOURCE and env['CONTINUATION_RUN_ID'] == RUN
    assert env['GITHUB_REF'] == 'refs/heads/main' and env['GITHUB_RUN_ATTEMPT'] == '1'
    assert env['GITHUB_WORKFLOW_REF'] == WORKFLOW_REF
    assert env['GITHUB_WORKFLOW_SHA'] == env['GITHUB_SHA'] and env['GITHUB_SHA'] != SOURCE
    assert git('rev-parse', 'HEAD') == SOURCE and not git('status', '--porcelain')
    assert digest(Path('pnpm-lock.yaml')) == LOCK
    subprocess.run(['git', 'fetch', '--no-tags', 'origin', 'main'], check=True)
    control = git('rev-parse', 'FETCH_HEAD')
    assert control == env['GITHUB_SHA'], 'Control source must still be current main.'
    subprocess.run(['git', 'merge-base', '--is-ancestor', SOURCE, control], check=True)
    changed = set(git('diff', '--name-only', SOURCE, control).splitlines())
    assert changed <= ALLOWED_CONTROL_PATHS and WORKFLOW in changed, 'Application source must stay byte-identical.'
    packaging = subprocess.check_output(['git', 'show', control + ':scripts/build-desktop-artifact.ts'])
    assert hashlib.sha256(packaging).hexdigest() == PACKAGING_SHA
    # Only the release-stage installer changes; runtime source, bundle and lock stay pinned.
    origin = api('actions/runs/' + RUN)
    jobs = api('actions/runs/' + RUN + '/attempts/1/jobs?per_page=100')
    metadata = api('actions/runs/' + RUN + '/artifacts?per_page=100')
    validate_origin(origin, jobs, metadata, datetime.datetime.now(datetime.timezone.utc))
    validate_android_origin(api('actions/runs/' + ANDROID_RUN),
                            api('actions/runs/' + ANDROID_RUN + '/attempts/1/jobs?per_page=100'),
                            api('actions/runs/' + ANDROID_RUN + '/artifacts?per_page=100'),
                            datetime.datetime.now(datetime.timezone.utc))
    releases = api('releases?per_page=100')
    assert not any(r['tag_name'] == 'v' + VERSION for r in releases), 'This version already has a release.'
    previous = api('actions/workflows/morrowbyte-release.yml/runs?event=workflow_dispatch&per_page=100')
    later = [r for r in previous['workflow_runs'] if r['id'] > int(RUN)]
    assert len(later) == 2 and {r['id'] for r in later} == {int(ANDROID_RUN), int(env['GITHUB_RUN_ID'])}, 'Another product continuation exists.'
    root = Path(env['RUNNER_TEMP']) / 'release68'
    root.mkdir(mode=0o700)
    for artifact_id, (_, sha, directory) in PINS.items():
        archive = root / (artifact_id + '.zip')
        with archive.open('wb') as output:
            subprocess.run(['gh', 'api', f'repos/morrowbyte/t3code/actions/artifacts/{artifact_id}/zip'], stdout=output, check=True)
        extract_verified(archive, sha, root / directory)
    android_archive = root / (ANDROID_ARTIFACT + '.zip')
    with android_archive.open('wb') as output:
        subprocess.run(['gh', 'api', f'repos/morrowbyte/t3code/actions/artifacts/{ANDROID_ARTIFACT}/zip'], stdout=output, check=True)
    extract_verified(android_archive, ANDROID_ARCHIVE_SHA, root / 'android')
    verify_android_payload(root / 'android')
    verify_payload(root, digest(Path('scripts/morrowbyte/check.sh')))
    for directory, target in [('preflight', 'observatory-route-generation'), ('build', 'observatory-release-build')]:
        shutil.copytree(root / directory, Path(env['RUNNER_TEMP']) / target)
    workflow_bytes = subprocess.check_output(['git', 'show', control + ':' + WORKFLOW])
    receipt = {'source': SOURCE, 'version': VERSION, 'originRun': RUN, 'originAttempt': '1',
               'controlSource': control, 'continuationRun': env['GITHUB_RUN_ID'],
               'workflowSha256': hashlib.sha256(workflow_bytes).hexdigest(),
               'androidOriginRun': ANDROID_RUN, 'androidArchiveSha256': ANDROID_ARCHIVE_SHA,
               'packagingScriptSha256': PACKAGING_SHA,
               'reusedArtifacts': [{'id': artifact_id, 'name': name, 'archiveSha256': sha} for artifact_id, (name, sha, _) in PINS.items()],
               'files': [{'path': str(p.relative_to(root)), 'sha256': digest(p)}
                         for directory in ['js'] for p in sorted((root / directory).rglob('*')) if p.is_file()]}
    (root / 'CONTINUATION68.json').write_text(json.dumps(receipt, indent=2) + '\n')
    values = {'source_sha': SOURCE, 'version': VERSION, 'android_version_code': '68', 'tag': 'v' + VERSION,
              'observatory_route_sha256': ROUTE, 'desktop_run_id': RUN, 'desktop_run_attempt': '1',
              'desktop_context_sha': SOURCE, 'desktop_workflow_sha': SOURCE, 'desktop_workflow_ref': WORKFLOW_REF,
              'recovery_artifact_attempt': '1', 'recovery_workflow_sha256': receipt['workflowSha256'],
              'android_source_sha': SOURCE, 'android_lock_sha256': LOCK,
              'apk_sha256': APK_SHA, 'apk_receipt_sha256': APK_RECEIPT_SHA,
              'android_run_id': ANDROID_RUN, 'android_run_attempt': '1',
              'android_context_sha': ANDROID_CONTROL, 'android_workflow_sha': ANDROID_CONTROL,
              'android_workflow_ref': WORKFLOW_REF, 'packaging_sha256': PACKAGING_SHA}
    with open(env['GITHUB_OUTPUT'], 'a') as output:
        output.writelines(f'{key}={value}\n' for key, value in values.items())
    print(json.dumps({'status': 'verified', 'source': SOURCE, 'version': VERSION, 'originRun': RUN,
                      'retainedArtifacts': len(PINS)}))


if __name__ == '__main__':
    main()
