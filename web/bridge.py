#!/usr/bin/env python3
"""Bridge launcher: runs server.js with millisecond timestamps on every log line."""
import os, subprocess, sys, time

p = subprocess.Popen(
    ['node', 'server.js'],
    cwd=os.path.dirname(os.path.abspath(__file__)),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
for line in (p.stdout or []):
    ts = time.strftime('%H:%M:%S.') + time.strftime('%f')[:3]
    sys.stdout.write(ts + ' ' + line.decode('utf-8', 'replace'))
    sys.stdout.flush()
p.wait()
