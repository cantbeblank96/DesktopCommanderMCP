#!/usr/bin/env python3
"""Linux A fleet runner; no root permission or additional Python packages needed."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from ssh_fleet_lib import Fleet, FleetError, alive, atomic_json, exclusive, process_stamp, read_json, utc


def print_report(report):
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


def watch(fleet: Fleet):
    with exclusive(fleet.root/'watch.lock'):
        atomic_json(fleet.root/'watch-process.json',
                    {'process':process_stamp(os.getpid()),'startedAt':utc(),'config':str(fleet.filename)})
        def stop(signum, frame):
            fleet.stopping=True
        signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
        previous=None
        try:
            while not fleet.stopping:
                try:
                    with exclusive(fleet.root/'operation.lock'):
                        report=fleet.sync(prepare=True,enroll=True)
                    brief=[{k:r.get(k) for k in ('port','status','cloudStatus','diagnostic')} for r in report['nodes']]
                    if brief!=previous:
                        print_report({'at':utc(),'nodes':brief}); previous=brief
                except Exception as e:
                    print(f'{utc()} {type(e).__name__}: {e}',flush=True)
                deadline=time.monotonic()+fleet.config['intervalSeconds']
                while time.monotonic()<deadline and not fleet.stopping:
                    fleet.reap()
                    fleet.dashboard()
                    time.sleep(min(5,max(0,deadline-time.monotonic())))
        finally:
            fleet.reap()
            # Stopping discovery leaves independent bridges running; stop-workers
            # is an explicit and separately scoped action.
            print('Fleet watcher stopped; device bridges were not stopped.',flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True,help='Private fleet JSON (do not commit it)')
    parser.add_argument('action',choices=['scan','sync','authorize','status','dashboard','watch','start-watch','stop-watch','stop-workers','resume'])
    parser.add_argument('--ports',nargs='+',type=int,help='Subset of already-approved inventory ports')
    args=parser.parse_args()
    fleet=Fleet(args.config)
    if args.ports:
        for port in args.ports: fleet.profile(port)
    if args.action=='scan':
        print_report({'nodes':fleet.scan(args.ports)}); return
    if args.action=='status':
        file=fleet.root/'status.json'
        report=read_json(file) if file.exists() else {'nodes':[],'checkedAt':None}
        report['watchRunning']=alive(read_json(fleet.root/'watch-process.json')) if (fleet.root/'watch-process.json').exists() else False
        # Historical SSH/cloud states are labelled with checkedAt, never reported
        # as a new active check. Process liveness and credential existence are fresh.
        for row in report['nodes']:
            rec=fleet.record(row['port']); _,state=fleet.paths(row['port'])
            row['processRunning']=alive(rec); row['credentialsPresent']=(state/'device.json').is_file()
        print_report(report); return
    if args.action=='dashboard':
        target=fleet.dashboard()
        print(target)
        subprocess.Popen(['xdg-open',str(target)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return
    if args.action=='watch':
        if args.ports: raise FleetError('watch uses the complete approved inventory, not --ports')
        watch(fleet); return
    if args.action=='start-watch':
        with exclusive(fleet.root/'start.lock'):
            marker=fleet.root/'watch-process.json'
            if marker.exists() and alive(read_json(marker)):
                print('WATCH_ALREADY_RUNNING'); return
            if args.ports: raise FleetError('watch uses the complete approved inventory')
            log=fleet.root/'watch.log'
            fd=os.open(log,os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'ab') as out:
                p=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--config',str(fleet.filename),'watch'],
                                   stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
            for _ in range(50):
                if p.poll() is not None: raise FleetError(f'Watcher exited ({p.returncode}); inspect {log}')
                if marker.exists() and read_json(marker).get('process')==process_stamp(p.pid):
                    print_report({'status':'WATCH_STARTED','pid':p.pid,'log':str(log),'dashboard':str(fleet.root/'authorizations.html')}); return
                time.sleep(.1)
            raise FleetError('Watcher startup unconfirmed; inspect watch.log before retrying')
    if args.action=='stop-watch':
        marker=fleet.root/'watch-process.json'
        record=read_json(marker) if marker.exists() else None
        if not alive(record): print('WATCH_NOT_RUNNING'); return
        os.kill(record['process']['pid'],signal.SIGTERM)
        print('WATCH_STOP_REQUESTED; existing devices remain running'); return
    with exclusive(fleet.root/'operation.lock'):
        if args.action=='stop-workers':
            if not args.ports: raise FleetError('stop-workers requires an explicit --ports list')
            for port in args.ports: print(port,fleet.stop_worker(port))
            return
        if args.action=='resume':
            if not args.ports: raise FleetError('resume requires explicit --ports')
            for port in args.ports:
                rec=fleet.record(port)
                rec.pop('operatorStopped',None); rec.pop('exitCode',None)
                fleet.save(port,rec)
        if args.action=='authorize' and not args.ports:
            raise FleetError('authorize requires --ports; it explicitly renews one-time pairing requests')
        report=fleet.sync(prepare=True,enroll=args.action=='authorize',ports=args.ports,force_auth=args.action=='authorize')
        print_report(report)


if __name__=='__main__':
    try:
        main()
    except (FleetError,OSError,ValueError,subprocess.TimeoutExpired) as e:
        print(f'{type(e).__name__}: {e}',file=sys.stderr)
        sys.exit(1)
