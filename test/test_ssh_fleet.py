"""Fleet tests: no network, real credentials, cloud enrollment, or GPU work."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import ssh_fleet_lib as lib


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.script=self.root/'inventory.sh'
        self.script.write_text('HOST="${HOST:-root@10.0.0.1}"\nPORTS="${PORTS:-2201 2202}"\n')
        release=self.root/'runtime'
        (release/'bin').mkdir(parents=True); (release/'app/dist').mkdir(parents=True)
        (release/'bin/node').write_text('test-only'); (release/'app/dist/index.js').write_text('test-only')
        self.config={'schemaVersion':1,'inventoryScript':str(self.script),'inventorySha256':lib.digest_file(self.script),
         'sshKey':str(self.root/'private-key'),'knownHosts':str(self.root/'known_hosts'),
         'bridgeRelease':str(release),'bundleArchive':str(self.root/'runtime.tar.gz'),
         'bundleSha256':'0'*64,'releaseId':'fixture-release','stateDirectory':str(self.root/'state'),
         'cloudAnchorProfile':'cci-2202','intervalSeconds':120}
        self.configfile=self.root/'fleet.json'; self.configfile.write_text(json.dumps(self.config))
        self.fleet=lib.Fleet(self.configfile); self.fleet.home=self.root/'home'
        self.identity={'hostname':'node1','user':'root','platform':'Linux','arch':'x86_64','home':'/root'}
        self.row={'port':2201,'ssh':'REACHABLE','identity':self.identity.copy()}
        self.name=f'cci-2201 (via {lib.socket.gethostname()})'

    def tearDown(self):
        self.tmp.cleanup()

    def local_profile(self, credentials=False, lock=False):
        directory,state=self.fleet.paths(2201)
        directory.mkdir(parents=True); state.mkdir(parents=True)
        (directory/'profile.json').write_text(json.dumps({'profile':'cci-2201',
          'verification':{'expectedHostname':'node1','expectedUser':'root'}}))
        if credentials:
            (state/'device.json').write_text(json.dumps({'deviceId':'device-one','session':{'access_token':'test-only'}}))
        if lock: (state/'instance.lock').mkdir()
        self.fleet.save(2201,{'doctorVerifiedAt':'fixture'})
        return directory,state

    def sync(self, cloud, row=None, **kwargs):
        with patch.object(self.fleet,'scan',return_value=[(row or self.row).copy()]),patch.object(lib,'cloud_devices',return_value=cloud):
            return self.fleet.sync(**kwargs)['nodes'][0]

    def test_literal_inventory(self):
        self.assertEqual(lib.inventory(self.script,lib.digest_file(self.script)),{'host':'root@10.0.0.1','ports':[2201,2202]})

    def test_inventory_change_is_not_auto_accepted(self):
        self.script.write_text(self.script.read_text()+'# change\n')
        with self.assertRaises(lib.FleetError): self.fleet.scan()

    def test_inventory_is_not_executed(self):
        marker=self.root/'must-not-exist'
        self.script.write_text(self.script.read_text()+f'touch {marker}\n')
        lib.inventory(self.script,lib.digest_file(self.script))
        self.assertFalse(marker.exists())

    def test_nonliteral_targets_rejected(self):
        for source in ['HOST="${HOST:-root@$(touch /tmp/no)}"\nPORTS="${PORTS:-22}"\n',
                       'HOST="${HOST:-root@server}"\nPORTS="${PORTS:-22 22}"\n',
                       'HOST="${HOST:-root@server}"\nPORTS="${PORTS:-65536}"\n']:
            self.script.write_text(source)
            with self.assertRaises(lib.FleetError): lib.inventory(self.script,lib.digest_file(self.script))

    def test_unapproved_ports_rejected(self):
        with self.assertRaises(lib.FleetError): self.fleet.profile(9999)

    def test_unknown_config_fields_rejected(self):
        self.config['automaticTrust']=True; self.configfile.write_text(json.dumps(self.config))
        with self.assertRaises(lib.FleetError): lib.Fleet(self.configfile)

    def test_ssh_never_weakens_host_checks(self):
        args=lib.ssh_options(self.fleet.config,2201)
        self.assertIn('StrictHostKeyChecking=yes',args)
        self.assertIn('UpdateHostKeys=no',args)
        self.assertIn('ForwardAgent=no',args)
        self.assertNotIn('StrictHostKeyChecking=no',args)

    def test_unknown_keys_and_auth_errors_are_distinct_from_offline(self):
        self.assertEqual(lib.classify_ssh('Host key verification failed'),'HOST_KEY_REVIEW_REQUIRED')
        self.assertEqual(lib.classify_ssh('Permission denied (publickey)'),'SSH_AUTH_REVIEW_REQUIRED')
        self.assertEqual(lib.classify_ssh('Connection timed out'),'SSH_OFFLINE')

    def test_repeated_config_does_not_overwrite_changed_content(self):
        f=self.root/'private'
        lib.write_new(f,'original'); lib.write_new(f,'original')
        with self.assertRaises(lib.FleetError): lib.write_new(f,'changed')
        self.assertEqual(f.read_text(),'original')

    def test_symlink_config_is_rejected(self):
        target=self.root/'target'; target.write_text('{}')
        link=self.root/'link'; link.symlink_to(target)
        with self.assertRaises(lib.FleetError): lib.read_json(link)
        with self.assertRaises(lib.FleetError): lib.write_new(link,'{}')

    def test_flock_blocks_duplicate_manager(self):
        with lib.exclusive(self.root/'guard'):
            with self.assertRaises(lib.FleetError):
                with lib.exclusive(self.root/'guard'): pass

    def test_same_pid_with_wrong_birth_is_not_alive(self):
        stamp=lib.process_stamp(os.getpid())
        self.assertTrue(lib.alive({'process':stamp}))
        self.assertFalse(lib.alive({'process':{**stamp,'startTicks':'wrong'}}))

    def test_cloud_existing_unmanaged_device_skips_registration(self):
        with patch.object(self.fleet,'prepare') as prepare, patch.object(self.fleet,'start') as start:
            row=self.sync([{'id':'foreign-local','device_name':self.name,'status':'online'}],prepare=True,enroll=True)
            self.assertEqual(row['status'],'ALREADY_IN_DEVICES_UNMANAGED')
            prepare.assert_not_called(); start.assert_not_called()

    def test_cloud_error_never_registers_new_devices(self):
        with patch.object(self.fleet,'scan',return_value=[self.row.copy()]),patch.object(lib,'cloud_devices',side_effect=OSError('offline')),patch.object(self.fleet,'start') as start:
            report=self.fleet.sync(prepare=True,enroll=True)
            self.assertFalse(report['cloudVerified']); start.assert_not_called()

    def test_revoked_saved_device_not_automatically_reenrolled(self):
        self.local_profile(credentials=True)
        with patch.object(self.fleet,'start') as start:
            row=self.sync([],prepare=True,enroll=True)
            self.assertEqual(row['status'],'REVOKED_OR_MISSING_DEVICE'); start.assert_not_called()

    def test_existing_active_device_not_restarted(self):
        self.local_profile(credentials=True,lock=True)
        with patch.object(self.fleet,'start') as start:
            row=self.sync([{'id':'device-one','device_name':self.name,'status':'online'}],prepare=True,enroll=True)
            self.assertEqual(row['status'],'REGISTERED_ACTIVE'); start.assert_not_called()

    def test_identity_change_needs_review(self):
        directory,state=self.local_profile()
        row={**self.row,'identity':{**self.identity,'hostname':'different-pod'}}
        with patch.object(self.fleet,'start') as start:
            answer=self.sync([],row=row,prepare=True,enroll=True)
            self.assertEqual(answer['status'],'IDENTITY_CHANGED_REVIEW_REQUIRED'); start.assert_not_called()

    def test_offline_target_not_deployed(self):
        row={'port':2201,'ssh':'SSH_OFFLINE'}
        with patch.object(self.fleet,'prepare') as prepare:
            self.assertEqual(self.sync([],row=row,prepare=True,enroll=True)['status'],'SSH_OFFLINE')
            prepare.assert_not_called()

    def test_prepared_node_enrolls_only_when_requested(self):
        self.local_profile()
        with patch.object(self.fleet,'start',return_value='AUTHORIZATION_PENDING') as start:
            self.assertEqual(self.sync([],prepare=True,enroll=False)['status'],'READY_FOR_AUTHORIZATION')
            start.assert_not_called()
            self.assertEqual(self.sync([],prepare=True,enroll=True)['status'],'AUTHORIZATION_PENDING')
            start.assert_called_once_with(2201,enroll=True,force_auth=False)

    def test_expired_auth_attempt_not_repeated_without_operator(self):
        self.local_profile(); self.fleet.save(2201,{'authorizationAttempted':True})
        with patch.object(lib.subprocess,'Popen') as popen:
            self.assertEqual(self.fleet.start(2201,enroll=True),'AUTHORIZATION_REQUIRED')
            popen.assert_not_called()

    def test_stopped_worker_not_restarted(self):
        self.local_profile(); self.fleet.save(2201,{'operatorStopped':True})
        with patch.object(lib.subprocess,'Popen') as popen:
            self.assertEqual(self.fleet.start(2201),'OPERATOR_STOPPED'); popen.assert_not_called()

    def test_dashboard_escapes_data_and_never_links_untrusted_urls(self):
        report={'nodes':[{'port':2201,'status':'<script>alert(1)</script>'}],'checkedAt':'now'}
        html=self.fleet.dashboard(report).read_text()
        self.assertNotIn('<script>',html); self.assertIn('&lt;script&gt;',html)


if __name__=='__main__': unittest.main()
