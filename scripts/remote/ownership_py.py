import json, os
port = int(os.environ["NPZVIEW_PORT"])
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
    except FileNotFoundError:
        continue
print(json.dumps({"uids": uids, "me": os.getuid()}))
