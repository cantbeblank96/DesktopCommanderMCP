#!/usr/bin/env python3
"""Standard-library-only fleet management for explicitly approved SSH nodes.

This module never executes the inventory shell script, disables host-key checks,
shares device credentials, approves OAuth requests, or starts GPU workloads.
"""
from __future__ import annotations

import concurrent.futures
import contextlib
import datetime as dt
import fcntl
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

CLOUD = "https://mcp.desktopcommander.app"
PROFILE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HOST_RE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9.-]*)$")
AUTH_RE = re.compile(r"https://mcp\.desktopcommander\.app/device/verify\?user_code=([A-Z0-9]{4}-[A-Z0-9]{4})")


class FleetError(RuntimeError):
    pass


def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def digest_file(filename: Path) -> str:
    h = hashlib.sha256()
    with filename.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(filename: Path, limit: int = 2 * 1024 * 1024) -> Any:
    if filename.is_symlink() or not filename.is_file() or filename.stat().st_size > limit:
        raise FleetError(f"Unsafe or oversized JSON file: {filename.name}")
    return json.loads(filename.read_text(encoding="utf-8"))


def private_dir(directory: Path) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != os.getuid():
        raise FleetError(f"Unsafe private directory: {directory}")
    directory.chmod(0o700)


def atomic_json(filename: Path, data: Any) -> None:
    private_dir(filename.parent)
    fd, name = tempfile.mkstemp(prefix=".write-", dir=filename.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n"); f.flush(); os.fsync(f.fileno())
        os.replace(name, filename)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_new(filename: Path, content: str, mode: int = 0o600) -> None:
    """Do not overwrite an operator's existing profile or known-hosts file."""
    if filename.exists() or filename.is_symlink():
        if filename.is_symlink() or filename.read_text(encoding="utf-8") != content:
            raise FleetError(f"Existing configuration differs; review manually: {filename}")
        return
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content); f.flush(); os.fsync(f.fileno())


@contextlib.contextmanager
def exclusive(filename: Path):
    private_dir(filename.parent)
    if filename.is_symlink():
        raise FleetError("Lock path must not be a symlink")
    fd = os.open(filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise FleetError("Another fleet operation is already running") from e
        yield
    finally:
        os.close(fd)


def inventory(filename: Path, expected_sha: str) -> dict[str, Any]:
    """Read literal HOST/PORTS defaults; never source/eval arbitrary shell."""
    if digest_file(filename) != expected_sha:
        raise FleetError("Inventory changed. Review and explicitly update inventorySha256 before discovery.")
    text = filename.read_text(encoding="utf-8")
    def default(name: str) -> str:
        matches = re.findall(r'^' + name + r'="\$\{' + name + r':-([^}\n]+)\}"\s*$', text, re.M)
        if len(matches) != 1:
            raise FleetError(f"Inventory needs exactly one literal {name} default")
        return matches[0]
    host = default("HOST")
    if not HOST_RE.fullmatch(host):
        raise FleetError("Unsupported inventory HOST; expected user@hostname")
    words = default("PORTS").split()
    if not words or len(words) > 64 or any(not w.isdigit() for w in words):
        raise FleetError("Inventory PORTS must be 1..64 literal integers")
    ports = [int(w) for w in words]
    if len(set(ports)) != len(ports) or any(not 1 <= p <= 65535 for p in ports):
        raise FleetError("Duplicate or out-of-range inventory port")
    return {"host": host, "ports": ports}


def process_stamp(pid: int) -> dict[str, Any] | None:
    """PID + Linux boot ID + start ticks protect against PID reuse on stop."""
    try:
        p = Path(f"/proc/{pid}")
        if p.stat().st_uid != os.getuid():
            return None
        fields = (p / "stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return {"pid": pid, "startTicks": fields[19],
                "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    except (OSError, IndexError):
        return None


def alive(record: dict[str, Any] | None) -> bool:
    stamp = (record or {}).get("process")
    return bool(stamp and process_stamp(stamp.get("pid", -1)) == stamp)


def run(args: list[str], *, timeout: int = 20, input_data: str | None = None,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, input=input_data, text=True, capture_output=True,
                          timeout=timeout, env=env, check=False)


def ssh_options(config: dict[str, Any], port: int, known_hosts: Path | None = None) -> list[str]:
    return ["/usr/bin/ssh", "-F", "/dev/null", "-T", "-i", config["sshKey"],
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
            "-o", f"UserKnownHostsFile={known_hosts or config['knownHosts']}",
            "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ForwardAgent=no",
            "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=8",
            "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3", "-p", str(port), config["host"]]


def classify_ssh(stderr: str) -> str:
    if re.search(r"HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .*host key is known", stderr, re.I):
        return "HOST_KEY_REVIEW_REQUIRED"
    if re.search(r"Permission denied|no such identity|Bad configuration", stderr, re.I):
        return "SSH_AUTH_REVIEW_REQUIRED"
    return "SSH_OFFLINE"


def probe(config: dict[str, Any], port: int) -> dict[str, Any]:
    # Only a read-only host identity check. No nvidia-smi or training is run.
    command = "printf '__RDC_FLEET__\\n'; hostname; id -un; uname -s; uname -m; printf '%s\\n' \"$HOME\"; printf '__END__\\n'"
    row: dict[str, Any] = {"port": port, "checkedAt": utc()}
    try:
        r = run(ssh_options(config, port) + [command], timeout=15)
        if r.returncode:
            row["ssh"] = classify_ssh(r.stderr)
            row["diagnostic"] = r.stderr.strip()[-500:]
            return row
        lines = r.stdout.replace("\r", "").splitlines()
        begin, end = lines.index("__RDC_FLEET__"), lines.index("__END__")
        if end != begin + 6:
            raise ValueError("Unexpected identity framing")
        identity = dict(zip(("hostname", "user", "platform", "arch", "home"), lines[begin+1:end]))
        if any(not s or re.search(r"[\x00-\x1f]", s) for s in identity.values()):
            raise ValueError("Invalid identity")
        if not identity["home"].startswith("/") or ".." in Path(identity["home"]).parts:
            raise ValueError("Invalid target HOME")
        row.update(ssh="REACHABLE", identity=identity)
    except subprocess.TimeoutExpired:
        row["ssh"] = "SSH_OFFLINE"; row["diagnostic"] = "Connection timed out"
    except (ValueError, OSError) as e:
        row["ssh"] = "PROBE_FAILED"; row["diagnostic"] = str(e)
    return row


def api_get(url: str, headers: dict[str, str] | None = None) -> Any:
    # Prevent a redirect from forwarding a device bearer token elsewhere.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(url, headers=headers or {})
    with opener.open(request, timeout=12) as response:
        content = response.read(2 * 1024 * 1024 + 1)
    if len(content) > 2 * 1024 * 1024:
        raise FleetError("Cloud response too large")
    return json.loads(content)


def cloud_devices(home: Path, anchor_profile: str) -> list[dict[str, Any]]:
    """Read-only cloud snapshot. Never refresh/duplicate the live anchor session."""
    if not PROFILE_RE.fullmatch(anchor_profile):
        raise FleetError("Invalid cloud anchor profile")
    credentials = read_json(home / ".desktop-commander-device/profiles" / anchor_profile / "device.json")
    token = credentials.get("session", {}).get("access_token")
    if not isinstance(token, str) or not token:
        raise FleetError("No live read-only cloud anchor credential")
    info = api_get(CLOUD + "/api/mcp-info")
    base = info.get("supabaseUrl", "")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "https" or not re.fullmatch(r"[a-z0-9-]+\.supabase\.co", parsed.hostname or "") or parsed.port not in (None, 443):
        raise FleetError("Cloud data endpoint must be an HTTPS Supabase host")
    rows = api_get(base.rstrip("/") + "/rest/v1/mcp_devices?select=id,device_name,status&limit=1000",
                   {"apikey": info["supabasePublishableKey"], "Authorization": "Bearer " + token})
    if not isinstance(rows, list) or len(rows) >= 1000:
        raise FleetError("Cloud device inventory incomplete")
    # RLS authenticates the bearer. Its secret never enters reports or command args.
    if not any(r.get("id") == credentials.get("deviceId") for r in rows):
        raise FleetError("Cloud anchor device absent or revoked; no new enrollments started")
    return rows


# Executed only on the explicitly selected SSH node. Trusted, digest-checked
# runtime archive is unpacked into a new dedicated release, never /usr or /etc.
REMOTE_INSTALL = r'''
import sys, os, json, hashlib, tarfile, posixpath, shutil, uuid
from pathlib import Path, PurePosixPath
root=Path(sys.argv[1]); release=sys.argv[2]; expected=sys.argv[3]; size=int(sys.argv[4]); profile=sys.argv[5]
if not root.is_absolute() or '..' in root.parts: raise RuntimeError('unsafe root')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
if root.is_symlink(): raise RuntimeError('root is a symlink')
marker=root/'fleet-owner.json'
owner={'schemaVersion':1,'profile':profile,'purpose':'desktop-commander-ssh-fleet'}
if marker.exists():
    if marker.is_symlink() or json.loads(marker.read_text()) != owner: raise RuntimeError('foreign deployment')
else:
    if any(root.iterdir()): raise RuntimeError('unowned nonempty deployment')
    marker.write_text(json.dumps(owner)); marker.chmod(0o600)
for name in ['releases','incoming','state-home','workspace']:
    d=root/name; d.mkdir(exist_ok=True,mode=0o700)
    if d.is_symlink(): raise RuntimeError('unsafe deployment directory')
final=root/'releases'/release
if final.exists():
    manifest=final/'FLEET-BUNDLE.json'
    if final.is_symlink() or not manifest.is_file() or json.loads(manifest.read_text()).get('sha256') != expected:
        raise RuntimeError('release conflict')

    for _ in iter(lambda:sys.stdin.buffer.read(1024*1024),b''): pass
    print('ALREADY_INSTALLED'); sys.exit(0)
archive=root/'incoming'/(release+'.'+uuid.uuid4().hex+'.part')
h=hashlib.sha256(); count=0
try:
    with archive.open('xb') as out:
        for block in iter(lambda:sys.stdin.buffer.read(1024*1024),b''):
            count+=len(block)
            if count>size: raise RuntimeError('oversized upload')
            h.update(block); out.write(block)
    if count!=size or h.hexdigest()!=expected: raise RuntimeError('upload digest mismatch')
    staging=root/'releases'/('.staging-'+release+'-'+uuid.uuid4().hex); staging.mkdir(mode=0o700)
    try:
        with tarfile.open(archive,'r:gz') as tf:
            members=tf.getmembers()
            if len(members)>100000 or sum(m.size for m in members)>2*1024**3: raise RuntimeError('archive limits')
            for m in members:
                p=PurePosixPath(m.name)
                if p.is_absolute() or '..' in p.parts or not (m.isdir() or m.isfile() or m.issym() or m.islnk()): raise RuntimeError('unsafe archive member')
                if m.issym() or m.islnk():
                    dest=posixpath.normpath(posixpath.join(posixpath.dirname(m.name) if m.issym() else '',m.linkname))
                    if dest.startswith('/') or dest=='..' or dest.startswith('../'): raise RuntimeError('unsafe archive link')
            for m in members:
                resolved=(staging/m.name).parent.resolve()
                if not str(resolved).startswith(str(staging.resolve())+os.sep) and resolved!=staging.resolve(): raise RuntimeError('unsafe archive parent')
                tf.extract(m,staging)
        (staging/'FLEET-BUNDLE.json').write_text(json.dumps({'sha256':expected,'release':release}))
        os.rename(staging,final)
    except BaseException:
        shutil.rmtree(staging); raise
finally:
    archive.unlink(missing_ok=True)
print('INSTALLED '+release)
'''

REMOTE_LAUNCHER = r'''
import sys, os, json, shlex, subprocess
from pathlib import Path
root=Path(sys.argv[1]); release=root/'releases'/sys.argv[2]; q=shlex.quote
node=release/'bin/node'
r=subprocess.run([str(node),'--version'],capture_output=True,text=True,check=True)
subprocess.run([str(release/'bin/rg'),'--version'],capture_output=True,text=True,check=True)
body='\n'.join(['#!/bin/sh','set -eu','umask 077',
 'export HOME='+q(str(root/'state-home')),
 'export PATH='+q(str(release/'bin')+':/usr/local/bin:/usr/bin:/bin'),
 'export DESKTOP_COMMANDER_DISABLE_TELEMETRY=1',
 'export DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT=1',
 'export DESKTOP_COMMANDER_EXIT_ON_STDIN_CLOSE=1','export DC_REMOTE_DEVICE=true',
 'cd '+q(str(root/'workspace')),
 'printf "%s\\n" "$$" > '+q(str(root/'last-backend.pid')),
 'exec '+q(str(node))+' '+q(str(release/'app/dist/index.js'))+' --no-onboarding',''])
p=root/'rdc-stdio.sh'
if p.exists() and (p.is_symlink() or p.read_text()!=body): raise RuntimeError('launcher differs; explicit upgrade required')
if not p.exists():
    with p.open('x') as f:f.write(body)
    p.chmod(0o700)
print(json.dumps({'release':str(release),'node':r.stdout.strip(),'launcher':str(p)}))
'''


class Fleet:
    def __init__(self, filename: Path):
        self.filename = filename.resolve()
        self.config = read_json(self.filename, 65536)
        required = {'schemaVersion','inventoryScript','inventorySha256','sshKey','knownHosts',
                    'bridgeRelease','bundleArchive','bundleSha256','releaseId','stateDirectory',
                    'cloudAnchorProfile','intervalSeconds'}
        if set(self.config) != required or self.config['schemaVersion'] != 1:
            raise FleetError("Unknown/missing fleet configuration fields")
        self.home = Path.home()
        for key in ['inventoryScript','sshKey','knownHosts','bridgeRelease','bundleArchive','stateDirectory']:
            if not Path(self.config[key]).is_absolute():
                raise FleetError(key + ' must be an absolute path')
        for key in ['inventorySha256','bundleSha256']:
            if not re.fullmatch(r'[a-f0-9]{64}',self.config[key]): raise FleetError('Invalid '+key)
        if not PROFILE_RE.fullmatch(self.config['releaseId']) or not PROFILE_RE.fullmatch(self.config['cloudAnchorProfile']):
            raise FleetError('Invalid release/anchor identifier')
        if not isinstance(self.config['intervalSeconds'],int) or not 30<=self.config['intervalSeconds']<=86400:
            raise FleetError('intervalSeconds must be 30..86400')
        self.config.update(inventory(Path(self.config['inventoryScript']),self.config['inventorySha256']))
        self.root = Path(self.config['stateDirectory'])
        private_dir(self.root)
        self.release = Path(self.config['bridgeRelease'])
        self.node = self.release/'bin/node'
        self.entry = self.release/'app/dist/index.js'
        if not self.node.is_file() or not self.entry.is_file(): raise FleetError('Pinned bridge runtime missing')
        self.children: dict[int, subprocess.Popen] = {}
        self.stopping = False

    def profile(self, port: int) -> str:
        if port not in self.config['ports']: raise FleetError('Port is not in the approved inventory')
        return f'cci-{port}'

    def paths(self, port: int) -> tuple[Path,Path]:
        name=self.profile(port)
        return self.home/'.config/rdc-ssh'/name, self.home/'.desktop-commander-device/profiles'/name

    def record(self, port: int) -> dict[str,Any]:
        p=self.root/f'{port}.json'
        return read_json(p) if p.exists() else {}

    def save(self, port: int, value: dict[str,Any]) -> None:
        atomic_json(self.root/f'{port}.json', value)

    def scan(self, ports: list[int] | None = None) -> list[dict[str,Any]]:
        approved=inventory(Path(self.config['inventoryScript']), self.config['inventorySha256'])
        if approved != {'host':self.config['host'],'ports':self.config['ports']}:
            raise FleetError('Inventory changed after configuration was loaded')
        ports=ports or self.config['ports']
        for p in ports: self.profile(p)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            return list(pool.map(lambda p:probe(self.config,p),ports))

    def child_env(self) -> dict[str,str]:
        env=dict(os.environ)
        env.update(PATH=str(self.release/'bin')+':'+env.get('PATH','/usr/bin:/bin'),
                   DESKTOP_COMMANDER_DISABLE_TELEMETRY='1', DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT='1',
                   MCP_SERVER_URL=CLOUD)
        return env

    def prepare(self, row: dict[str,Any]) -> None:
        port=row['port']; name=self.profile(port); identity=row['identity']
        if identity['platform']!='Linux' or identity['arch']!='x86_64':
            raise FleetError('This pinned runtime is validated for Linux x86_64 only')
        directory,_=self.paths(port)
        private_dir(directory)
        target='['+self.config['host'].split('@',1)[1]+']:'+str(port)
        keys=run(['/usr/bin/ssh-keygen','-F',target,'-f',self.config['knownHosts']])
        lines='\n'.join(l for l in keys.stdout.splitlines() if l and not l.startswith('#'))+'\n'
        if keys.returncode or not lines.strip(): raise FleetError('No previously trusted host key; manual verification required')
        known=directory/'known_hosts'; write_new(known,lines)
        hostuser,host=HOST_RE.fullmatch(self.config['host']).groups()
        def qc(p): return '"'+str(p).replace('\\','\\\\').replace('"','\\"')+'"'
        sshconfig='\n'.join([f'Host {name}',f'    HostName {host}',f'    Port {port}',f'    User {hostuser}',
             '    IdentityFile '+qc(self.config['sshKey']),'    UserKnownHostsFile '+qc(known),
             '    GlobalKnownHostsFile /dev/null','    StrictHostKeyChecking yes','    UpdateHostKeys no',
             '    BatchMode yes','    IdentitiesOnly yes','    ForwardAgent no','    RequestTTY no',''])
        write_new(directory/'ssh_config',sshconfig)
        remote_root=identity['home'].rstrip('/')+'/.local/share/rdc-ssh/'+name
        bundle=Path(self.config['bundleArchive'])
        if digest_file(bundle)!=self.config['bundleSha256']: raise FleetError('Local runtime bundle digest mismatch')
        command='python3 -c '+shlex.quote(REMOTE_INSTALL)+' '+ ' '.join(map(shlex.quote,[remote_root,self.config['releaseId'],self.config['bundleSha256'],str(bundle.stat().st_size),name]))
        with bundle.open('rb') as f:
            r=subprocess.run(ssh_options(self.config,port,known)+[command],stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=240)
        if r.returncode: raise FleetError('Deployment failed: '+r.stderr.decode(errors='replace')[-1000:])
        command='python3 -c '+shlex.quote(REMOTE_LAUNCHER)+' '+shlex.quote(remote_root)+' '+shlex.quote(self.config['releaseId'])
        r=run(ssh_options(self.config,port,known)+[command],timeout=30)
        if r.returncode: raise FleetError('Runtime/launcher check failed: '+r.stderr[-1000:])
        config={'schemaVersion':1,'profile':name,'deviceName':f'{name} (via {socket.gethostname()})',
                'backend':{'type':'ssh','sshExecutable':'/usr/bin/ssh','sshConfigFile':str(directory/'ssh_config'),
                           'hostAlias':name,'remoteLauncher':remote_root+'/rdc-stdio.sh'},
                'verification':{'expectedHostname':identity['hostname'],'expectedUser':identity['user']},
                'lifecycle':{'initializeTimeoutMs':45000,'healthIntervalMs':30000,'healthTimeoutMs':5000,
                             'healthFailureThreshold':3,'reconnectMaxDelayMs':30000,'shutdownGraceMs':15000}}
        write_new(directory/'profile.json',json.dumps(config,ensure_ascii=False,indent=2)+'\n')
        cmd=shlex.join([str(self.node),str(self.entry),'remote','--profile',name,'--config',str(directory/'profile.json')])
        manager='\n'.join(['#!/bin/sh','set -eu','umask 077',
             'export PATH='+shlex.quote(str(self.release/'bin'))+':"$PATH"',
             'export DESKTOP_COMMANDER_DISABLE_TELEMETRY=1','export DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT=1',
             'export MCP_SERVER_URL='+CLOUD,'case "${1:-serve}" in',
             '  doctor) exec '+cmd+' --doctor ;;',
             '  enroll) exec '+cmd+' --enroll ;;',
             '  serve) exec '+cmd+' --non-interactive ;;',
             '  authorize-and-start) '+cmd+' --enroll; exec '+cmd+' --non-interactive ;;',
             '  *) echo "Usage: manage.sh doctor|enroll|serve|authorize-and-start" >&2; exit 64 ;;','esac',''])
        write_new(directory/'manage.sh',manager,0o700)
        self.doctor(port)

    def doctor(self, port: int) -> None:
        directory,_=self.paths(port)
        r=run([str(directory/'manage.sh'),'doctor'],timeout=70,env=self.child_env())
        log=self.root/f'{port}-doctor.log'
        log.write_text(r.stdout+r.stderr); log.chmod(0o600)
        if r.returncode or '"status": "BACKEND_VERIFIED"' not in r.stdout:
            raise FleetError(f'Backend verification failed; see {log}')
        rec=self.record(port); rec.update(doctorVerifiedAt=utc()); self.save(port,rec)

    def reap(self) -> None:
        for port,p in list(self.children.items()):
            code=p.poll()
            if code is not None:
                rec=self.record(port); rec.update(exitCode=code, exitedAt=utc())
                self.save(port,rec); del self.children[port]

    def start(self, port: int, *, enroll: bool=False, force_auth: bool=False) -> str:
        directory,state=self.paths(port); rec=self.record(port)
        if alive(rec): return 'MANAGED_PROCESS_RUNNING'
        if rec.get('operatorStopped') and not force_auth: return 'OPERATOR_STOPPED'
        if force_auth: rec.pop('operatorStopped',None)
        if (state/'instance.lock').exists(): return 'EXISTING_PROFILE_LOCKED'
        if enroll and rec.get('authorizationAttempted') and not force_auth: return 'AUTHORIZATION_REQUIRED'
        if rec.get('exitCode') in (64,65,77,78) and not (enroll and force_auth): return 'MANUAL_REVIEW_REQUIRED'
        mode='authorize-and-start' if enroll else 'serve'
        log=self.root/f'{port}-bridge.log'
        if log.is_symlink(): raise FleetError('Unsafe bridge log path')
        # Deliberately separate/rotate only our own previous log, never credentials.
        if enroll and log.exists(): os.replace(log,self.root/f'{port}-bridge.previous.log')
        fd=os.open(log,os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'ab') as output:
            p=subprocess.Popen([str(directory/'manage.sh'),mode],stdin=subprocess.DEVNULL,
                               stdout=output,stderr=subprocess.STDOUT,start_new_session=True,env=self.child_env())
        stamp=process_stamp(p.pid)
        if not stamp:
            raise FleetError('Worker exited before its identity could be recorded; inspect bridge log')
        rec.update(process=stamp,mode=mode,startedAt=utc(),startedUnix=time.time(),log=str(log))
        rec.pop('exitCode',None); rec.pop('exitedAt',None)
        if enroll: rec['authorizationAttempted']=True
        self.save(port,rec); self.children[port]=p
        return 'AUTHORIZATION_PENDING' if enroll else 'BRIDGE_STARTED'

    def sync(self, *, prepare: bool=False, enroll: bool=False, ports: list[int] | None=None,
             force_auth: bool=False) -> dict[str,Any]:
        self.reap()
        rows=self.scan(ports)
        cloud_error=None
        try: cloud=cloud_devices(self.home,self.config['cloudAnchorProfile'])
        except Exception as e:
            cloud=[]; cloud_error=f'{type(e).__name__}: cloud inventory unavailable (no new device registration attempted)'
        by_id={r['id']:r for r in cloud}; by_name={r['device_name']:r for r in cloud}
        for row in rows:
            port=row['port']; name=self.profile(port); directory,state=self.paths(port)
            expected=f'{name} (via {socket.gethostname()})'
            rec=self.record(port)
            row.update(profile=name,deviceName=expected,processRunning=alive(rec))
            try:
                credfile=state/'device.json'; cred=read_json(credfile) if credfile.exists() else None
                device=by_id.get(cred.get('deviceId')) if cred else by_name.get(expected)
                if device: row.update(deviceId=device['id'],cloudStatus=device['status'])
                if cloud_error:
                    row['status']='CLOUD_UNVERIFIED'; continue
                if cred and device is None:
                    row['status']='REVOKED_OR_MISSING_DEVICE'; continue
                if device and not cred:
                    row['status']='ALREADY_IN_DEVICES_UNMANAGED'; continue
                if row['ssh']!='REACHABLE':
                    row['status']=row['ssh']; continue
                configfile=directory/'profile.json'
                if configfile.exists():
                    cfg=read_json(configfile)
                    if cfg.get('profile')!=name or cfg.get('verification')!={'expectedHostname':row['identity']['hostname'],'expectedUser':row['identity']['user']}:
                        row['status']='IDENTITY_CHANGED_REVIEW_REQUIRED'; continue
                elif not prepare:
                    row['status']='NEEDS_PREPARATION'; continue
                if cred:
                    if (state/'instance.lock').exists() or alive(rec):
                        row['status']='REGISTERED_ACTIVE' if device['status']=='online' else 'REGISTERED_RECONNECTING'
                    elif prepare:
                        row['status']=self.start(port)
                    else: row['status']='REGISTERED_STOPPED'
                    continue
                if not configfile.exists():
                    self.prepare(row)
                    rec=self.record(port)
                if not rec.get('doctorVerifiedAt'):
                    if not prepare: row['status']='NEEDS_BACKEND_CHECK'; continue
                    self.doctor(port)
                if enroll:
                    row['status']=self.start(port,enroll=True,force_auth=force_auth)
                else: row['status']='READY_FOR_AUTHORIZATION'
            except Exception as e:
                row['status']='PREPARATION_FAILED'
                row['diagnostic']=str(e)[-1000:]
        report={'schemaVersion':1,'checkedAt':utc(),'cloudVerified':cloud_error is None,
                'cloudError':cloud_error,'inventoryScript':self.config['inventoryScript'],
                'inventorySha256':self.config['inventorySha256'],'nodes':rows}
        atomic_json(self.root/'status.json',report)
        self.dashboard(report)
        return report

    def dashboard(self, report: dict[str,Any] | None=None) -> Path:
        if report is None:
            p=self.root/'status.json'; report=read_json(p) if p.exists() else {'nodes':[]}
        cells=[]
        for row in report['nodes']:
            port=row['port']; rec=self.record(port); _,state=self.paths(port)
            auth=''
            log=self.root/f'{port}-bridge.log'
            if not (state/'device.json').exists() and log.exists() and not log.is_symlink():
                with log.open('rb') as f:
                    f.seek(max(0,log.stat().st_size-16000)); text=f.read().decode(errors='replace')
                matches=AUTH_RE.findall(text)
                if matches and alive(rec) and time.time()-rec.get('startedUnix',0)<900:
                    code=matches[-1]
                    auth='<a target="_blank" rel="noreferrer" href="'+CLOUD+'/device/verify?user_code='+code+'">确认此设备 '+code+'</a>'
            if (state/'device.json').exists(): auth='已保存独立设备授权'
            if not auth and rec.get('authorizationAttempted'): auth='需重新发起授权：authorize --ports '+str(port)
            cells.append('<tr><td>'+str(port)+'</td><td>'+html.escape(row.get('status',''))+'</td><td>'+auth+'</td></tr>')
        text='''<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<title>SSH 节点设备授权</title><style>body{font:17px sans-serif;max-width:1000px;margin:40px auto;line-height:1.6}td,th{padding:12px;border-bottom:1px solid #aaa;text-align:left}table{width:100%}</style>
<h1>SSH 节点设备</h1><p>仅添加巡检脚本已批准的节点。首次授权请逐个确认，完成后自动启动连接。不要把授权给不认识的设备；不用保存验证码。</p>
<p>暂时离线的节点会重试；主机密钥或身份变化不会被自动接受。页面每 15 秒刷新。</p><table><tr><th>端口</th><th>检查结果</th><th>授权</th></tr>'''+''.join(cells)+'</table><p>检查时间：'+html.escape(report.get('checkedAt',''))+'</p></html>'
        target=self.root/'authorizations.html'
        temp=self.root/'.authorizations.tmp'; temp.write_text(text,encoding='utf-8'); temp.chmod(0o600); os.replace(temp,target)
        return target

    def stop_worker(self, port: int) -> str:
        rec=self.record(port)
        if not alive(rec): return 'NOT_OWNED_OR_NOT_RUNNING'
        pid=rec['process']['pid']
        if os.getpgid(pid)!=pid: raise FleetError('Worker is not the recorded session leader')
        os.killpg(pid,signal.SIGTERM)
        rec['operatorStopped']=True; self.save(port,rec)
        return 'STOP_REQUESTED'
