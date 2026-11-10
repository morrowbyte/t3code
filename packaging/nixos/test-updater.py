#!/usr/bin/env python3
"""Offline updater behavior with fixture releases; never downloads or builds a package."""
import hashlib
import copy
import json
import os
import signal
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install.sh').resolve()
VERSION = '0.0.47-nightly.20261014.1'

class UpdaterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.real_store = shutil.which('nix-store') is not None
        cls.package = '/nix/store/' + '0' * 32 + '-updater-fixture'
        cls.legacy_package = None
        cls.retention_packages = []
        if cls.real_store:
            # Register a tiny local fixture, without evaluation, network or compilation.
            with tempfile.TemporaryDirectory() as directory:
                app = Path(directory) / 'updater-test-app'
                (app / 'bin').mkdir(parents=True)
                launcher = app / 'bin/t3code-morrowbyte'
                launcher.write_text('#!/bin/sh\nexit 0\n')
                launcher.chmod(0o755)
                cls.package = subprocess.check_output(['nix-store', '--add', str(app)], text=True).strip()
                launcher.rename(launcher.with_name('previous-desktop'))
                cls.legacy_package = subprocess.check_output(['nix-store', '--add', str(app)], text=True).strip()
                launcher.with_name('previous-desktop').rename(launcher)
                for index in range(3):
                    launcher.write_text('#!/bin/sh\nexit ' + str(index + 1) + '\n')
                    cls.retention_packages.append(subprocess.check_output(
                        ['nix-store', '--add', str(app)], text=True).strip())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'; self.bin.mkdir()
        self.home = self.root / 'home'; self.home.mkdir()
        self.launchers = self.home / 'bin'
        self.data = self.root / 'app'
        self.asset = self.root / 'closure'; self.asset.write_bytes(b'namespace-export-fixture')
        self.manifest = self.root / 'manifest.json'
        self.releases = self.root / 'releases.json'
        self.log = self.root / 'nix.log'
        self.download_log = self.root / 'downloads.log'
        self.closures = self.root / 'closures.json'
        self.closures.write_text('{}')
        self.write_release()
        self.stub('curl', '''#!/usr/bin/env python3
import os,sys,shutil
args=sys.argv[1:]
url=next(a for a in args if a.startswith('https://'))
if os.environ.get('TEST_NETWORK_FAIL'): sys.exit(90)
with open(os.environ['TEST_DOWNLOAD_LOG'], 'a') as log: log.write(url + '\\n')
if 'api.github.com' in url: print(open(os.environ['TEST_RELEASES']).read())
elif '--output' in args:
 source=os.environ['TEST_MANIFEST'] if url.endswith('.json') else os.environ['TEST_ASSET']
 shutil.copyfile(source,args[args.index('--output')+1])
else:
 source=os.environ['TEST_MANIFEST'] if url.endswith('.json') else os.environ['TEST_ASSET']
 with open(source, 'rb') as stream: shutil.copyfileobj(stream, sys.stdout.buffer)
''')
        self.stub('nix', '''#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
if 'path-info' in args:
 root=args[-1]
 members=json.load(open(os.environ['TEST_CLOSURES'])).get(root,
  [dict(path=root,narHash='sha256-'+'A'*43+'=',narSize=8)])
 if os.environ.get('TEST_INFO_FORMAT') == 'map' and isinstance(members,list):
  members={member['path']:{key:value for key,value in member.items() if key != 'path'} for member in members}
 print(json.dumps(members))
elif 'hash' in args and 'to-sri' in args:
 for value in args[args.index('sha256')+1:]:
  if value == 'sha256:'+'0'*52: value='sha256-'+'A'*43+'='
  if not value.startswith('sha256-'): sys.exit(97)
  print(value)
else:
 print('LOCAL BUILD FORBIDDEN',file=sys.stderr); sys.exit(99)
''')
        self.stub('zstd', '#!/bin/sh\nfor file do :; done\ncat "$file"\n[ -z "${TEST_ZSTD_FAIL:-}" ]\n')
        self.stub('find', '''#!/usr/bin/env python3
import os,sys
if os.environ.get('TEST_ALLOCATION_CHANGED'): print('f 1')
else: print('f 0')
''')
        self.stub('stat', '''#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if os.environ.get('TEST_STAT_FAIL') and args[:1] == ['-f']: sys.exit(12)
if args[:2] == ['-c','%d']:
 print(2 if os.environ.get('TEST_SPLIT_FILESYSTEMS') and args[-1].startswith('/nix/') else 1)
elif args[:3] == ['-f','-c','%a %S']:
 key='TEST_STORE_FREE_BYTES' if args[-1].startswith('/nix/') else 'TEST_WORK_FREE_BYTES'
 print(str(int(os.environ.get(key, str(4*1024**4)))//4096)+' 4096')
elif args[:3] == ['-f','-c','%T']: print('ext2/ext3')
else: os.execv(os.environ['TEST_REAL_STAT'], ['stat', *args])
''')
        self.stub('nix-store', '''#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
with open(os.environ['TEST_NIX_LOG'],'a') as f: f.write(' '.join(args)+'\\n')
if '--import' in args:
 sys.stdin.buffer.read()
 if os.environ.get('TEST_IMPORT_FAIL'): sys.exit(7)
 for member in json.load(open(os.environ['TEST_MANIFEST']))['closure']: print(member['path'])
 if os.environ.get('TEST_EXTRA_IMPORTED_PATH'): print(os.environ['TEST_EXTRA_IMPORTED_PATH'])
elif '--requisites' in args: print(args[args.index('--requisites')+1])
elif '--add-root' in args:
 root=args[args.index('--add-root')+1]
 if os.environ.get('TEST_ROOT_FAIL'): sys.exit(9)
 if not os.path.lexists(root): os.symlink(args[args.index('--realise')+1],root)
elif '--verify-path' in args:
 if os.environ.get('TEST_VERIFY_FAIL'): sys.exit(8)
else: sys.exit(88)
''')
        self.env = {**os.environ, 'PATH': str(self.bin)+':'+os.environ['PATH'],
                    'HOME': str(self.home), 'XDG_BIN_HOME': str(self.launchers),
                    'XDG_DATA_HOME': str(self.home/'data'),
                    'T3_MORROWBYTE_DATA_DIR': str(self.data), 'T3_MORROWBYTE_MANAGED': '1',
                    'T3_MORROWBYTE_REPOSITORY': 'morrowbyte/t3code', 'T3_MORROWBYTE_CHANNEL': 'nightly',
                    'TEST_RELEASES': str(self.releases), 'TEST_ASSET': str(self.asset),
                    'TEST_MANIFEST': str(self.manifest), 'TEST_PACKAGE': self.package,
                    'TEST_NIX_LOG': str(self.log), 'TEST_DOWNLOAD_LOG': str(self.download_log),
                    'TEST_CLOSURES': str(self.closures), 'TEST_REAL_STAT': shutil.which('stat')}
        for key in ['T3CODE_HOME', 'NIX_REMOTE', 'NIX_STORE_DIR', 'NIX_STATE_DIR']:
            self.env.pop(key, None)

    def write_release(self, manifest_version=VERSION):
        prefix = 'T3-Code-' + VERSION + '-x86_64-linux-nix-closure'
        digest = hashlib.sha256(self.asset.read_bytes()).hexdigest()
        self.manifest.write_text(json.dumps(dict(schemaVersion=1, version=manifest_version,
            system='x86_64-linux', storePath=self.package, asset=prefix+'.nar.zst',
            sha256=digest, compression='zstd', sourceSha='b'*40,
            archiveBytes=self.asset.stat().st_size, exportBytes=self.asset.stat().st_size,
            closure=[dict(path=self.package, narHash='sha256-'+'A'*43+'=', narSize=8)],
            allocationEntries=[dict(path=self.package, fileCount=1, directoryCount=0,
                symlinkCount=0, payloadBytes=0)]))+'\n')
        assets = []
        for name, file in [(prefix+'.nar.zst', self.asset), (prefix+'.json', self.manifest)]:
            assets.append(dict(name=name,
                browser_download_url='https://github.com/morrowbyte/t3code/releases/download/v'+VERSION+'/'+name,
                digest='sha256:'+hashlib.sha256(file.read_bytes()).hexdigest(), size=file.stat().st_size))
        self.releases.write_text(json.dumps([
            dict(draft=False, prerelease=True, tag_name='v'+VERSION,
                 name='Morrowbyte Nightly '+VERSION, published_at='2026-10-14T00:00:00Z', assets=assets),
            dict(draft=True, prerelease=True, tag_name='v'+VERSION,
                 name='Morrowbyte Nightly draft', published_at='2099-01-01T00:00:00Z', assets=[])]))

    def publish_manifest(self, manifest):
        self.manifest.write_text(json.dumps(manifest)+'\n')
        releases = json.loads(self.releases.read_text())
        for asset in releases[0]['assets']:
            if asset['name'].endswith('.json'):
                asset['digest'] = 'sha256:'+hashlib.sha256(self.manifest.read_bytes()).hexdigest()
                asset['size'] = self.manifest.stat().st_size
        self.releases.write_text(json.dumps(releases))

    def limits(self, max_versions=2, max_bytes=2147483648):
        self.bind_home(self.data)
        directory = self.data/'runtime/desktop-restore'; directory.mkdir(parents=True, exist_ok=True)
        identity = dict(kind='nix', baseDir=str(self.data.resolve()), nixDataDir=str(self.data.resolve()))
        installation_id = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()
        (directory/'registry.json').write_text(json.dumps(dict(format=1, identity=identity,
            installationId=installation_id, updateHold=False, maxVersions=max_versions,
            maxBytes=max_bytes, artifacts=[])))

    def assert_no_archive_or_import(self):
        if self.download_log.exists():
            self.assertFalse(any(line.endswith('.nar.zst') for line in self.download_log.read_text().splitlines()))
        if self.log.exists():
            self.assertNotIn('--import', self.log.read_text())

    def stub(self, name, content):
        p=self.bin/name; p.write_text(content); p.chmod(0o755)

    def run_update(self, *args):
        return subprocess.run(['bash',str(SCRIPT),*args],env=self.env,capture_output=True,text=True)

    def bind_home(self, home):
        self.data.mkdir(parents=True, exist_ok=True)
        home.mkdir(parents=True, exist_ok=True)
        (self.data/'restore-home.json').write_text(json.dumps(dict(
            format=1, baseDir=str(home.resolve()))))

    def retained_version(self, version, store, root=False):
        (self.data/'versions').mkdir(parents=True, exist_ok=True)
        link = self.data/'versions'/version
        link.symlink_to(store)
        prepared = self.data/'prepared'
        prepared.mkdir(exist_ok=True)
        (prepared/(version+'.json')).write_text(json.dumps(dict(
            schemaVersion=1, version=version, repository='morrowbyte/t3code',
            channel='nightly', system='x86_64-linux', storePath=store,
            sha256='a'*64, compression='zstd')))
        if root:
            roots = self.data/'.gcroots'; roots.mkdir(exist_ok=True)
            path = roots/Path(store).name
            if not path.is_symlink(): path.symlink_to(store)
        return link

    def previous(self):
        old = self.retained_version('0.0.47-nightly.20261013.3', self.package)
        (self.data/'current').symlink_to(old)
        self.bind_home(self.data)
        return os.readlink(self.data/'current')

    def test_check_is_read_only_and_excludes_draft(self):
        r=self.run_update('--check'); self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout)['available'],VERSION)
        self.assertFalse(self.data.exists()); self.assertFalse(self.log.exists())

    def test_bad_closure_digest_preserves_previous_version(self):
        old=self.previous(); self.asset.write_bytes(b'corrupt-export')
        r=self.run_update('--prepare', VERSION); self.assertNotEqual(r.returncode,0)
        self.assertIn('SHA-256',r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertFalse(self.log.exists())

    def test_corrupt_manifest_is_rejected_before_import(self):
        self.manifest.write_text('{}')
        r=self.run_update('--prepare',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertIn('SHA-256',r.stderr); self.assertFalse(self.log.exists())

    def test_wrong_manifest_version_is_rejected(self):
        self.write_release(manifest_version='9.9.9')
        r=self.run_update('--check'); self.assertNotEqual(r.returncode,0)
        self.assertIn('invalid closure manifest',r.stderr)

    def test_unbounded_or_inconsistent_release_metadata_fails_before_archive(self):
        original = json.loads(self.manifest.read_text())
        patches = [(field, None) for field in ['sourceSha', 'archiveBytes', 'exportBytes', 'closure', 'allocationEntries']]
        patches += [('archiveBytes', 0), ('archiveBytes', 1.5), ('archiveBytes', self.asset.stat().st_size+1),
                    ('exportBytes', 0), ('exportBytes', 7), ('sourceSha', 'main'),
                    ('closure', []), ('closure', original['closure']*2),
                    ('closure', [{**original['closure'][0], 'path': '/tmp/not-a-store-path'}]),
                    ('closure', [{**original['closure'][0], 'path': '/nix/store/'+'1'*32+'-wrong-root'}]),
                    ('closure', [{**original['closure'][0], 'narHash': 'unbound'}]),
                    ('closure', [{**original['closure'][0], 'narSize': -1}]),
                    ('allocationEntries', []), ('allocationEntries', original['allocationEntries']*2)]
        for field, value in [('fileCount', -1), ('directoryCount', 0.5), ('symlinkCount', 9007199254740992),
                             ('payloadBytes', 9), ('fileCount', 0), ('path', '/tmp/unbound')]:
            patches.append(('allocationEntries', [{**original['allocationEntries'][0], field: value}]))
        for field, value in patches:
            with self.subTest(field=field, value=value):
                manifest = {**original, field: value}
                if value is None: del manifest[field]
                self.publish_manifest(manifest)
                result = self.run_update('--prepare', VERSION)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('invalid closure manifest', result.stderr)
                self.assert_no_archive_or_import()
        self.publish_manifest(original)
        releases = json.loads(self.releases.read_text())
        for index, value in [(0, None), (1, None), (0, 0), (1, 4194305)]:
            with self.subTest(asset=index, size=value):
                changed = copy.deepcopy(releases)
                if value is None: del changed[0]['assets'][index]['size']
                else: changed[0]['assets'][index]['size'] = value
                self.releases.write_text(json.dumps(changed))
                result = self.run_update('--prepare', VERSION)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('size metadata', result.stderr)
                self.assert_no_archive_or_import()

    def test_two_retained_versions_allow_one_journaled_candidate_and_offline_restore(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        first, second, third = self.retention_packages
        versions = [VERSION.rsplit('.', 1)[0]+'.'+str(index) for index in range(1, 4)]
        for package, version in zip([first, second, third], versions):
            self.package = package
            self.write_release()
            manifest = json.loads(self.manifest.read_text())
            manifest['version'] = version
            manifest['asset'] = manifest['asset'].replace(VERSION, version)
            self.manifest.write_text(json.dumps(manifest)+'\n')
            releases = json.loads(self.releases.read_text())
            release = releases[0]
            release['tag_name'] = 'v' + version
            for asset in release['assets']:
                asset['name'] = asset['name'].replace(VERSION, version)
                asset['browser_download_url'] = asset['browser_download_url'].replace(VERSION, version)
                if asset['name'].endswith('.json'):
                    asset['digest'] = 'sha256:' + hashlib.sha256(self.manifest.read_bytes()).hexdigest()
                    asset['size'] = self.manifest.stat().st_size
            self.releases.write_text(json.dumps(releases))
            if package == third:
                self.limits(max_versions=2)
                result = self.run_update('--prepare', version)
                self.assertEqual(result.returncode, 0, result.stderr)
                inventory = json.loads((self.data/'installer-roots.json').read_text())
                self.assertEqual(set(inventory['ownedRoots']), {first, second, third})
                self.assertEqual(inventory['candidate'], dict(version=version, storePath=third))
                self.assertEqual((self.data/'current').resolve(), Path(second))
                self.assertEqual((self.data/'previous').resolve(), Path(first))
                self.assertEqual(json.loads((self.data/'runtime/desktop-restore/registry.json').read_text())['maxVersions'], 2)
            result = self.run_update('--update')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((self.data/'current').resolve(), Path(package))
            inventory = json.loads((self.data/'installer-roots.json').read_text())
            self.assertIsNone(inventory['candidate'])
            self.assertLessEqual(len(inventory['ownedRoots']), 2)
        self.assertEqual((self.data/'previous').resolve(), Path(second))
        self.assertFalse((self.data/'.gcroots'/Path(first).name).is_symlink())
        self.env['TEST_NETWORK_FAIL'] = '1'
        result = self.run_update('--rollback', versions[1])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.data/'current').resolve(), Path(second))
        self.assertEqual((self.data/'previous').resolve(), Path(third))

    def test_second_candidate_is_blocked_while_current_and_previous_stay_protected(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        first, second, candidate = self.retention_packages
        current = self.retained_version('current', first, root=True)
        previous = self.retained_version('previous', second, root=True)
        self.retained_version('candidate', candidate, root=True)
        (self.data/'current').symlink_to(current)
        (self.data/'previous').symlink_to(previous)
        self.limits(max_versions=2)
        (self.data/'installer-roots.json').write_text(json.dumps(dict(format=1,
            candidate=dict(version='candidate', storePath=candidate),
            ownedRoots=[first, second, candidate], pendingEvictions=[])))
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('another journaled candidate', result.stderr)
        self.assert_no_archive_or_import()
        self.assertEqual(os.readlink(self.data/'current'), str(current))
        self.assertEqual(os.readlink(self.data/'previous'), str(previous))
        self.assertEqual(json.loads((self.data/'installer-roots.json').read_text())['candidate'],
                         dict(version='candidate', storePath=candidate))
        for package in [first, second, candidate]:
            self.assertTrue((self.data/'.gcroots'/Path(package).name).is_symlink())

    def test_archive_and_import_peak_is_admitted_before_download(self):
        # The same Store root is current, previous and candidate: count and NAR bytes deduplicate.
        old = self.previous()
        (self.data/'previous').symlink_to(old)
        stream_bytes = self.asset.stat().st_size
        peak = 8 + stream_bytes * 3
        for cap in [7, 8, peak-1]:
            with self.subTest(cap=cap):
                self.limits(max_bytes=cap)
                result = self.run_update('--prepare', VERSION)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('byte cap before download/import', result.stderr)
                self.assert_no_archive_or_import()
        if not self.real_store: return
        self.limits(max_bytes=peak)
        for shape in ['array', 'map']:
            with self.subTest(shape=shape):
                self.env['TEST_INFO_FORMAT'] = shape
                result = self.run_update('--prepare', VERSION)
                self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(self.data/'current'), old)

    def test_free_space_and_shared_mutation_lock_are_checked_before_download(self):
        self.bind_home(self.data)
        for split, key in [('0', 'TEST_WORK_FREE_BYTES'), ('1', 'TEST_STORE_FREE_BYTES')]:
            with self.subTest(filesystem=key):
                if split == '1': self.env['TEST_SPLIT_FILESYSTEMS'] = '1'
                self.env[key] = '1'
                result = self.run_update('--prepare', VERSION)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('insufficient free space', result.stderr)
                self.assert_no_archive_or_import()
                del self.env[key]
        self.env['TEST_STAT_FAIL'] = '1'
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot prove free space', result.stderr)
        self.assert_no_archive_or_import()
        del self.env['TEST_STAT_FAIL']
        lock = self.data/'runtime/desktop-restore/mutation.lock'
        lock.write_text('unavailable')
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('another desktop restore operation', result.stderr)
        self.assertEqual(lock.read_text(), 'unavailable')
        self.assert_no_archive_or_import()

    def test_export_stream_exact_size_and_decompressor_status_precede_import(self):
        original = json.loads(self.manifest.read_text())
        for size, decompressor_failure in [(8, False), (self.asset.stat().st_size+1, False),
                                            (self.asset.stat().st_size, True)]:
            with self.subTest(size=size, decompressor_failure=decompressor_failure):
                self.publish_manifest({**original, 'exportBytes': size})
                if decompressor_failure: self.env['TEST_ZSTD_FAIL'] = '1'
                result = self.run_update('--prepare', VERSION)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('export', result.stderr)
                self.assertFalse(self.log.exists())
                self.assertFalse((self.data/'prepared'/f'{VERSION}.json').exists())

    def test_free_space_uses_bound_node_allocation_instead_of_export_size_multiplier(self):
        manifest = json.loads(self.manifest.read_text())
        manifest['exportBytes'] = 100 * 1024**2
        manifest['closure'][0]['narSize'] = manifest['exportBytes']
        self.publish_manifest(manifest)
        required = 64 * 1024**2 + 2 * manifest['exportBytes'] + manifest['archiveBytes'] + 6 * 4096
        admitted = (required + 4095) // 4096 * 4096
        self.assertLess(admitted, 300 * 1024**2)
        for free_bytes in [admitted-4096, admitted]:
            with self.subTest(free_bytes=free_bytes):
                self.env['TEST_WORK_FREE_BYTES'] = str(free_bytes)
                self.env['TEST_STORE_FREE_BYTES'] = str(free_bytes)
                result = self.run_update('--prepare', VERSION)
                self.assertNotEqual(result.returncode, 0)
                if free_bytes < admitted:
                    self.assertIn('insufficient free space', result.stderr)
                    self.assert_no_archive_or_import()
                else:
                    # The tiny fixture export intentionally ends after admission, before import.
                    self.assertIn('decompressed export size does not match manifest', result.stderr)
                    self.assertTrue(any(line.endswith('.nar.zst') for line in self.download_log.read_text().splitlines()))
                    self.assertFalse(self.log.exists())

    def test_distinct_roots_charge_shared_dependency_nar_bytes_once(self):
        current_store = '/nix/store/'+'2'*32+'-current'
        dependency = '/nix/store/'+'5'*32+'-shared-dependency'
        member = dict(path=dependency, narHash='sha256-'+'A'*43+'=', narSize=8)
        current = self.retained_version('current', current_store, root=True)
        (self.data/'current').symlink_to(current)
        manifest = json.loads(self.manifest.read_text())
        manifest['closure'] = sorted([*manifest['closure'], member], key=lambda item: item['path'])
        manifest['allocationEntries'] = [dict(path=item['path'], fileCount=1, directoryCount=0,
            symlinkCount=0, payloadBytes=0) for item in manifest['closure']]
        self.publish_manifest(manifest)
        self.closures.write_text(json.dumps({
            current_store: [dict(member, path=current_store), member],
            self.package: manifest['closure']}))
        peak = 24 + self.asset.stat().st_size * 3
        self.limits(max_bytes=peak-1)
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('byte cap before download/import', result.stderr)
        self.assert_no_archive_or_import()
        if not self.real_store: return
        self.limits(max_bytes=peak)
        result = self.run_update('--prepare', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(self.data/'current'), str(current))

    def test_imported_membership_hash_and_size_must_match_bound_manifest(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        original = json.loads(self.manifest.read_text())
        member = original['closure'][0]
        other = '/nix/store/'+'1'*32+'-unexpected-member'
        for members in [[member, {**member, 'path': other}],
                        [{**member, 'narHash': 'sha256-'+'B'*43+'='}],
                        [{**member, 'narSize': 9}]]:
            with self.subTest(members=members):
                self.closures.write_text(json.dumps({self.package: members}))
                result = self.run_update('--prepare', VERSION)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('differs from manifest', result.stderr)
                self.assertFalse((self.data/'prepared'/f'{VERSION}.json').exists())
                self.assertFalse((self.data/'current').is_symlink())

    def test_imported_allocation_must_match_bound_manifest_before_preparation(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        self.env['TEST_ALLOCATION_CHANGED'] = '1'
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('allocation differs from manifest', result.stderr)
        self.assertFalse((self.data/'prepared'/f'{VERSION}.json').exists())
        inventory = json.loads((self.data/'installer-roots.json').read_text())
        self.assertIsNotNone(inventory['pendingImport'])
        del self.env['TEST_ALLOCATION_CHANGED']
        result = self.run_update('--prepare', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_residual_newly_imported_paths_remain_in_the_physical_cap(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        self.bind_home(self.data)
        # Only newly created paths are journaled; unrelated global Store paths stay unowned.
        residue = self.retention_packages[0]
        entry = dict(storePath=residue, members=[dict(path=residue, narHash='sha256-'+'A'*43+'=', narSize=100)])
        (self.data/'installer-roots.json').write_text(json.dumps(dict(format=1, candidate=None,
            ownedRoots=[], pendingEvictions=[], imports=[entry])))
        self.limits(max_bytes=100)
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('byte cap before download/import', result.stderr)
        self.assert_no_archive_or_import()
        self.assertTrue(Path(residue).exists())

    def test_residual_dependency_bytes_without_app_root_do_not_occupy_a_version(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        first, second, dependency = self.retention_packages
        missing_root = '/nix/store/'+'6'*32+'-collected-app-root'
        self.assertFalse(Path(missing_root).exists())
        current = self.retained_version('current', first, root=True)
        previous = self.retained_version('previous', second, root=True)
        (self.data/'current').symlink_to(current)
        (self.data/'previous').symlink_to(previous)
        entry = dict(storePath=missing_root, members=[dict(path=dependency,
            narHash='sha256-'+'A'*43+'=', narSize=100)])
        (self.data/'installer-roots.json').write_text(json.dumps(dict(format=1, candidate=None,
            ownedRoots=[first, second], pendingEvictions=[], imports=[entry])))
        peak = 124 + self.asset.stat().st_size * 3
        for cap in [peak-1, peak]:
            with self.subTest(cap=cap):
                self.limits(max_versions=2, max_bytes=cap)
                result = self.run_update('--prepare', VERSION)
                if cap < peak:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('byte cap before download/import', result.stderr)
                    self.assert_no_archive_or_import()
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
        inventory = json.loads((self.data/'installer-roots.json').read_text())
        self.assertEqual(inventory['imports'], [entry])
        self.assertEqual(set(inventory['ownedRoots']), {first, second, self.package})
        self.assertFalse(Path(missing_root).exists())
        self.assertTrue(Path(dependency).exists())

    def test_dead_import_lock_resumes_identical_manifest_and_live_owner_blocks(self):
        self.bind_home(self.data)
        self.env['TEST_IMPORT_FAIL'] = '1'
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        inventory = json.loads((self.data/'installer-roots.json').read_text())
        pending = inventory['pendingImport']
        self.assertIsNotNone(pending)
        del self.env['TEST_IMPORT_FAIL']
        directory = self.data/'runtime/desktop-restore'
        lock = directory/'mutation.lock'
        owner_file = directory/'.killed-import-owner'
        owner = subprocess.Popen(['bash', '-c', 'read -r value'], stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            identity = str(owner.pid)+':'+Path(f'/proc/{owner.pid}/stat').read_text().rsplit(') ', 1)[1].split()[19]
            owner_file.write_text(identity); owner_file.chmod(0o600)
            os.link(owner_file, lock)
            before = lock.stat().st_ino
            self.log.unlink(); self.download_log.unlink()
            result = self.run_update('--prepare', VERSION)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('another desktop restore operation is active', result.stderr)
            self.assertEqual(lock.stat().st_ino, before)
            self.assertEqual(lock.read_text(), identity)
            self.assert_no_archive_or_import()
            recovery = directory/'mutation.lock.recovery'
            recovery.write_text('other-recovery')
            result = self.run_update('--prepare', VERSION)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(recovery.read_text(), 'other-recovery')
            self.assertEqual(lock.stat().st_ino, before)
            recovery.unlink()
            owner.send_signal(signal.SIGKILL)
            owner.wait()
            if self.real_store:
                result = self.run_update('--prepare', VERSION)
                self.assertEqual(result.returncode, 0, result.stderr)
                resumed = json.loads((self.data/'installer-roots.json').read_text())
                self.assertIsNone(resumed['pendingImport'])
                self.assertIsNotNone(resumed['candidate'])
                self.assertFalse(lock.exists())
                self.assertFalse(recovery.exists())
                self.assertEqual(owner_file.read_text(), identity)
                self.assertEqual(pending['manifestSha256'], hashlib.sha256(self.manifest.read_bytes()).hexdigest())
        finally:
            if owner.poll() is None:
                owner.kill()
                owner.wait()
            owner.stdin.close()

    def test_unexpected_exported_paths_hold_further_imports_to_the_same_manifest(self):
        self.bind_home(self.data)
        self.env['TEST_EXTRA_IMPORTED_PATH'] = '/nix/store/'+'4'*32+'-unexpected-export'
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('imported path set differs', result.stderr)
        inventory = json.loads((self.data/'installer-roots.json').read_text())
        self.assertIsNotNone(inventory['pendingImport'])
        self.assertFalse((self.data/'prepared'/f'{VERSION}.json').exists())
        original = json.loads(self.manifest.read_text())
        self.publish_manifest({**original, 'sourceSha': 'c'*40})
        self.download_log.unlink(); self.log.unlink()
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unverified import is pending', result.stderr)
        self.assert_no_archive_or_import()

    def test_missing_closure_never_falls_back_to_appimage_or_build(self):
        releases=json.loads(self.releases.read_text()); releases[0]['assets']=[]
        self.releases.write_text(json.dumps(releases))
        r=self.run_update('--prepare',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertFalse(self.log.exists()); self.assertFalse(self.data.exists())

    def test_failed_import_keeps_previous_pointer(self):
        old=self.previous(); self.env['TEST_IMPORT_FAIL']='1'
        r=self.run_update('--prepare',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertFalse((self.data/'prepared'/f'{VERSION}.json').exists())

    def test_prepare_is_separate_from_activation_and_roots_closure(self):
        if not self.real_store: self.skipTest('Namespace Nix fixture needed for Store path validation')
        old=self.previous(); r=self.run_update('--prepare',VERSION)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertTrue((self.data/'.gcroots'/Path(self.package).name).is_symlink())
        self.assertIn('--option max-jobs 0',self.log.read_text())
        self.assertIn('--option builders ',self.log.read_text())
        self.env['TEST_NETWORK_FAIL']='1'
        r=self.run_update('--activate',VERSION); self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'previous'),old)
        self.assertEqual((self.data/'current').resolve(),Path(self.package))
        r=self.run_update('--rollback','0.0.47-nightly.20261013.3')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)

    def test_unprepared_activation_is_rejected(self):
        r=self.run_update('--activate',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertFalse(self.data.exists())

    def test_configured_previous_launcher_retains_offline_rollback(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        old = self.previous()
        old_path = Path(old)
        old_path.unlink()
        old_path.symlink_to(self.legacy_package)
        receipt = self.data/'prepared'/(old_path.name+'.json')
        provenance = json.loads(receipt.read_text())
        provenance['storePath'] = self.legacy_package
        receipt.write_text(json.dumps(provenance))
        self.env['TEST_NETWORK_FAIL'] = '1'
        r = self.run_update('--rollback', old_path.name)
        self.assertNotEqual(r.returncode, 0)
        self.env['T3_MORROWBYTE_LEGACY_EXECUTABLE_NAME'] = 'previous-desktop'
        r = self.run_update('--rollback', old_path.name)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.data/'current').resolve(), Path(self.legacy_package))
        self.assertIn('--verify-path', self.log.read_text())

    def test_rollback_rejects_unproven_and_corrupt_closure_before_selection(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        old = self.previous()
        version = Path(old).name
        receipt = self.data/'prepared'/(version+'.json')
        provenance = receipt.read_text()
        receipt.unlink()
        result = self.run_update('--rollback', version)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('provenance', result.stderr)
        self.assertEqual(os.readlink(self.data/'current'), old)
        receipt.write_text(provenance)
        self.env['TEST_VERIFY_FAIL'] = '1'
        result = self.run_update('--rollback', version)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('integrity', result.stderr)
        self.assertEqual(os.readlink(self.data/'current'), old)

    def test_persisted_restore_hold_prevents_activation(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        old = self.previous()
        result = self.run_update('--prepare', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        hold = self.data/'runtime'/'desktop-restore'
        hold.mkdir(parents=True, exist_ok=True)
        (hold/'registry.json').write_text(json.dumps(dict(format=1, updateHold=True)))
        result = self.run_update('--activate', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('held', result.stderr)
        self.assertEqual(os.readlink(self.data/'current'), old)
        result = self.run_update('--rollback', Path(old).name)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_direct_update_reads_hold_and_recovery_from_bound_app_home(self):
        old = self.previous()
        app_home = self.root/'private profile'
        self.bind_home(app_home)
        restore = app_home/'runtime'/'desktop-restore'; restore.mkdir(parents=True)
        decoy = self.data/'runtime'/'desktop-restore'; decoy.mkdir(parents=True)
        (decoy/'registry.json').write_text(json.dumps(dict(format=1, updateHold=False)))
        for name, value in [('registry.json', dict(format=1, updateHold=True)),
                            ('registry.json', dict(format=1)),
                            ('registry.json', dict(format=2, updateHold=False)),
                            ('transaction.json', dict(format=1))]:
            with self.subTest(state=name, value=value):
                path = restore/name; path.write_text(json.dumps(value))
                result = self.run_update('--update')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('held', result.stderr)
                self.assertEqual(os.readlink(self.data/'current'), old)
                self.assertFalse(self.log.exists())
                path.unlink()

    def test_bound_home_cannot_be_overridden_to_bypass_hold(self):
        old = self.previous()
        app_home = self.root/'profile'; self.bind_home(app_home)
        restore = app_home/'runtime'/'desktop-restore'; restore.mkdir(parents=True)
        (restore/'registry.json').write_text(json.dumps(dict(format=1, updateHold=True)))
        self.env['T3CODE_HOME'] = str(self.data)
        result = self.run_update('--update')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disagrees', result.stderr)
        self.assertEqual(os.readlink(self.data/'current'), old)
        self.assertEqual(json.loads((self.data/'restore-home.json').read_text())['baseDir'], str(app_home.resolve()))
        self.assertFalse(self.log.exists())

    def test_invalid_or_changed_home_binding_fails_closed(self):
        old = self.previous()
        binding = self.data/'restore-home.json'
        for value in [dict(format=2, baseDir=str(self.data)), dict(format=1, baseDir='relative'),
                      dict(format=1, baseDir=str(self.root/'missing'))]:
            with self.subTest(binding=value):
                binding.write_text(json.dumps(value))
                result = self.run_update('--update')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('home', result.stderr.lower())
                self.assertEqual(os.readlink(self.data/'current'), old)
                self.assertFalse(self.log.exists())

    def test_existing_installation_requires_explicit_home_binding_then_reuses_it(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        old = self.previous(); (self.data/'restore-home.json').unlink()
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('AppHome is unknown', result.stderr)
        self.assertFalse(self.log.exists())
        app_home = self.root/'private profile'; app_home.mkdir()
        alias = self.root/'profile-alias'; alias.symlink_to(app_home)
        self.env['T3CODE_HOME'] = str(alias)
        result = self.run_update('--prepare', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.data/'restore-home.json').read_text()),
                         dict(format=1, baseDir=str(app_home.resolve())))
        del self.env['T3CODE_HOME']
        restore = app_home/'runtime'/'desktop-restore'; restore.mkdir(parents=True, exist_ok=True)
        (restore/'registry.json').write_text(json.dumps(dict(format=1, updateHold=True)))
        for args in [('--update',), ('--activate', VERSION)]:
            with self.subTest(operation=args):
                result = self.run_update(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('held', result.stderr)
                self.assertEqual(os.readlink(self.data/'current'), old)
        result = self.run_update('--rollback', Path(old).name)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_new_installation_binds_bootstrap_home_and_launcher(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        self.env['T3_MORROWBYTE_MANAGED'] = '0'
        result = self.run_update('--update')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.data/'restore-home.json').read_text()),
                         dict(format=1, baseDir=str(self.data.resolve())))
        launcher = (self.launchers/'t3code-morrowbyte').read_text().splitlines()
        self.assertIn('T3CODE_HOME='+str(self.data.resolve()), shlex.split(launcher[2]))
        self.assertEqual((self.data/'current').resolve(), Path(self.package))

    def test_existing_launcher_requires_explicit_home_and_is_preserved(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        self.launchers.mkdir()
        launcher = self.launchers/'t3code-morrowbyte'
        app_home = self.root/'private profile'
        content = '#!/bin/sh\nexport T3CODE_HOME=' + shlex.quote(str(app_home)) + '\n'
        launcher.write_text(content)
        self.env['T3_MORROWBYTE_MANAGED'] = '0'
        result = self.run_update('--update')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('AppHome is unknown', result.stderr)
        self.assertFalse(self.data.exists())
        self.env['T3CODE_HOME'] = str(app_home)
        result = self.run_update('--update')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(launcher.read_text(), content)
        self.assertEqual(json.loads((self.data/'restore-home.json').read_text())['baseDir'], str(app_home.resolve()))

    def test_legacy_roots_are_bounded_to_current_previous_and_candidate(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        current_store = self.package
        old = self.previous()
        roots = self.data/'.gcroots'; roots.mkdir()
        (roots/Path(current_store).name).symlink_to(current_store)
        previous_store, candidate_store, stale_store = self.retention_packages
        previous = self.retained_version('0.0.47-nightly.20261012.1', previous_store, root=True)
        (self.data/'previous').symlink_to(previous)
        self.retained_version(VERSION, candidate_store, root=True)
        stale = self.retained_version('0.0.47-nightly.20261011.1', stale_store, root=True)
        foreign_store = '/nix/store/' + '7'*32 + '-foreign-root'
        foreign = roots/Path(foreign_store).name; foreign.symlink_to(foreign_store)
        unproven_store = '/nix/store/' + '8'*32 + '-unproven-root'
        self.retained_version('0.0.47-nightly.20261010.1', unproven_store, root=True)
        unproven_receipt = self.data/'prepared/0.0.47-nightly.20261010.1.json'
        receipt = json.loads(unproven_receipt.read_text()); receipt['repository'] = 'other/repository'
        unproven_receipt.write_text(json.dumps(receipt))
        self.limits(max_versions=3)
        self.package = candidate_store
        self.env['TEST_PACKAGE'] = candidate_store
        self.write_release()
        result = self.run_update('--prepare', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        inventory = json.loads((self.data/'installer-roots.json').read_text())
        self.assertEqual(set(inventory['ownedRoots']), {current_store, previous_store, candidate_store})
        self.assertEqual(inventory['candidate'], dict(version=VERSION, storePath=candidate_store))
        self.assertEqual(inventory['pendingEvictions'], [])
        self.assertFalse((roots/Path(stale_store).name).is_symlink())
        self.assertTrue(stale.is_symlink())
        self.assertTrue(foreign.is_symlink())
        self.assertTrue((roots/Path(unproven_store).name).is_symlink())
        self.assertEqual(os.readlink(self.data/'current'), old)
        self.env['TEST_NETWORK_FAIL'] = '1'
        result = self.run_update('--activate', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        inventory = json.loads((self.data/'installer-roots.json').read_text())
        self.assertEqual(set(inventory['ownedRoots']), {current_store, candidate_store})
        self.assertIsNone(inventory['candidate'])
        self.assertFalse((roots/Path(previous_store).name).is_symlink())
        self.assertEqual(os.readlink(self.data/'previous'), old)
        self.assertTrue(foreign.is_symlink())

    def test_pending_eviction_reconciles_before_a_failed_import(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        old = self.previous()
        stale_store = self.retention_packages[0]
        self.retained_version('0.0.47-nightly.20261012.1', stale_store, root=True)
        roots = self.data/'.gcroots'
        current_root = roots/Path(self.package).name; current_root.symlink_to(self.package)
        inventory_file = self.data/'installer-roots.json'
        inventory_file.write_text(json.dumps(dict(format=1, candidate=None,
            ownedRoots=[self.package, stale_store], pendingEvictions=[self.package, stale_store])))
        self.env['TEST_IMPORT_FAIL'] = '1'
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--import', self.log.read_text())
        self.assertFalse((roots/Path(stale_store).name).is_symlink())
        self.assertTrue(current_root.is_symlink())
        self.assertEqual(os.readlink(self.data/'current'), old)
        inventory = json.loads(inventory_file.read_text())
        self.assertEqual(inventory['pendingEvictions'], [])
        self.assertEqual(inventory['ownedRoots'], [self.package])

    def test_failed_root_registration_is_owned_and_can_be_resumed(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        self.env['TEST_ROOT_FAIL'] = '1'
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.data/'current').is_symlink())
        inventory = json.loads((self.data/'installer-roots.json').read_text())
        self.assertEqual(inventory['candidate'], dict(version=VERSION, storePath=self.package))
        self.assertEqual(inventory['ownedRoots'], [self.package])
        self.assertFalse((self.data/'.gcroots'/Path(self.package).name).is_symlink())
        del self.env['TEST_ROOT_FAIL']
        result = self.run_update('--prepare', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.data/'.gcroots'/Path(self.package).name).is_symlink())
        self.assertFalse((self.data/'current').is_symlink())

    def test_changed_owned_root_is_preserved_and_stops_import(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        old = self.previous()
        stale_store, foreign_store, _ = self.retention_packages
        root = self.data/'.gcroots'/Path(stale_store).name
        root.parent.mkdir(); root.symlink_to(foreign_store)
        (self.data/'installer-roots.json').write_text(json.dumps(dict(format=1, candidate=None,
            ownedRoots=[stale_store], pendingEvictions=[stale_store])))
        result = self.run_update('--prepare', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('GC root changed', result.stderr)
        self.assertEqual(os.readlink(root), foreign_store)
        self.assertEqual(os.readlink(self.data/'current'), old)
        self.assertFalse(self.log.exists())

    def test_legacy_launcher_cannot_escape_package_bin(self):
        self.env['T3_MORROWBYTE_LEGACY_EXECUTABLE_NAME'] = '../other'
        r = self.run_update('--status')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('simple file name', r.stderr)
        self.assertFalse(self.data.exists())

    def test_release_brand_can_be_configured_without_relaxing_provenance(self):
        releases = json.loads(self.releases.read_text())
        releases[0]['name'] = 'Previous Product Nightly ' + VERSION
        self.releases.write_text(json.dumps(releases))
        r = self.run_update('--check')
        self.assertNotEqual(r.returncode, 0)
        self.env['T3_MORROWBYTE_RELEASE_NAME_PREFIX'] = 'Previous Product'
        r = self.run_update('--check')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['available'], VERSION)
        self.manifest.write_text('{}')
        r = self.run_update('--check')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('SHA-256', r.stderr)
        self.assertFalse(self.data.exists())

    def test_previous_release_brand_preserves_checks_and_prefers_newest_release(self):
        releases = json.loads(self.releases.read_text())
        previous = copy.deepcopy(releases[0])
        previous['name'] = 'Previous Product Nightly ' + VERSION
        previous['published_at'] = '2026-10-13T00:00:00Z'
        previous['assets'] = []
        self.releases.write_text(json.dumps([previous, *releases]))
        self.env['T3_MORROWBYTE_PREVIOUS_RELEASE_NAME_PREFIX'] = 'Previous Product'
        r = self.run_update('--check')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['available'], VERSION)
        previous['assets'] = releases[0]['assets']
        self.releases.write_text(json.dumps([previous, releases[1]]))
        r = self.run_update('--check')
        self.assertEqual(r.returncode, 0, r.stderr)
        del self.env['T3_MORROWBYTE_PREVIOUS_RELEASE_NAME_PREFIX']
        r = self.run_update('--check')
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.data.exists())

    def test_prepare_never_replaces_an_existing_version_identity(self):
        old = self.previous()
        version_link = self.data/'versions'/VERSION
        version_link.symlink_to('/nix/store/' + '1'*32 + '-original-version')
        (self.data/'current').unlink()
        (self.data/'current').symlink_to(version_link)
        (self.data/'previous').symlink_to(old)
        before = {name: os.readlink(self.data/name) for name in ['current', 'previous']}
        r = self.run_update('--prepare', VERSION)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('version identity changed', r.stderr)
        self.assertEqual(os.readlink(version_link), '/nix/store/' + '1'*32 + '-original-version')
        self.assertEqual({name: os.readlink(self.data/name) for name in before}, before)
        self.assertFalse(self.log.exists())

    def test_activation_rechecks_prepared_provenance_under_lock(self):
        if not self.real_store: self.skipTest('Namespace Nix fixture needed for Store path validation')
        old = self.previous()
        r = self.run_update('--prepare', VERSION)
        self.assertEqual(r.returncode, 0, r.stderr)
        receipt = self.data/'prepared'/f'{VERSION}.json'
        original = json.loads(receipt.read_text())
        self.assertEqual(original['repository'], 'morrowbyte/t3code')
        self.assertEqual(original['channel'], 'nightly')
        for field, value in [('version','9.9.9'), ('repository','pingdotgg/t3code'), ('channel','stable'), ('storePath','/nix/store/wrong')]:
            with self.subTest(field=field):
                receipt.write_text(json.dumps({**original, field:value}))
                r = self.run_update('--activate', VERSION)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('provenance changed', r.stderr)
                self.assertEqual(os.readlink(self.data/'current'), old)
        receipt.write_text(json.dumps(original))
        self.env['T3_MORROWBYTE_CHANNEL'] = 'stable'
        r = self.run_update('--activate', VERSION)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(os.readlink(self.data/'current'), old)

    def test_new_receipt_rechecks_canonical_closure_commitment_offline(self):
        if not self.real_store: self.skipTest('Nix fixture needed for Store path validation')
        old = self.previous()
        result = self.run_update('--prepare', VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.data/'prepared'/f'{VERSION}.json').read_text())
        self.assertNotIn('closure', receipt)
        self.assertIn('closureSha256', receipt)
        self.env['TEST_NETWORK_FAIL'] = '1'
        self.closures.write_text(json.dumps({self.package: [dict(path=self.package,
            narHash='sha256-'+'A'*43+'=', narSize=9)]}))
        result = self.run_update('--activate', VERSION)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('prepared closure membership', result.stderr)
        self.assertEqual(os.readlink(self.data/'current'), old)

    def test_wrong_repository_is_rejected_without_network_or_install(self):
        self.env['T3_MORROWBYTE_REPOSITORY'] = 'pingdotgg/t3code'
        r = self.run_update('--prepare', VERSION)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('approved fork', r.stderr)
        self.assertFalse(self.data.exists())
        self.assertFalse(self.log.exists())

    def test_stable_does_not_fall_back_to_nightly(self):
        self.env['T3_MORROWBYTE_CHANNEL']='stable'
        r=self.run_update('--check'); self.assertNotEqual(r.returncode,0)
        self.assertIn('no fork-owned stable release',r.stderr)
        self.assertFalse(self.data.exists())

if __name__ == '__main__': unittest.main()
