import json, os, signal
port = int(os.environ["NPZVIEW_PORT"])
inodes = []
uids = []
for table in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        with open(table) as fh:
            next(fh)
            for line in fh:
                parts = line.split()
                if len(parts) < 10 or parts[3] != "0A":
                    continue
                _ip, p = parts[1].rsplit(":", 1)
                if int(p, 16) != port:
                    continue
                uids.append(int(parts[7]))
                inodes.append(parts[9])
    except FileNotFoundError:
        continue
me = os.getuid()
if any(uid != me for uid in uids):
    print(json.dumps({"killed": [], "skipped_other_user": True}))
    raise SystemExit(0)
want = set(inodes)
found = []
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    try:
        if os.stat("/proc/" + name).st_uid != me:
            continue
        for fd in os.listdir("/proc/" + name + "/fd"):
            try:
                target = os.readlink("/proc/" + name + "/fd/" + fd)
            except OSError:
                continue
            if target.startswith("socket:[") and target.endswith("]") and target[8:-1] in want:
                found.append(pid)
                break
    except OSError:
        continue
for pid in found:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
print(json.dumps({"killed": found}))
