import json, os, urllib.error, urllib.request
port = int(os.environ["NPZVIEW_PORT"])
url = "http://127.0.0.1:%d/api/health" % port
try:
    with urllib.request.urlopen(url, timeout=2.5) as resp:
        body = resp.read().decode("utf-8", "replace")
        print(json.dumps({"kind": "http", "status": int(resp.status), "body": body[:4000]}))
except urllib.error.HTTPError as err:
    body = err.read().decode("utf-8", "replace")
    print(json.dumps({"kind": "http", "status": int(err.code), "body": body[:4000]}))
except Exception as err:
    msg = str(err)
    refused = isinstance(err, ConnectionRefusedError) or "111" in msg or "10061" in msg or "refused" in msg.lower()
    print(json.dumps({"kind": "refused" if refused else "blocked", "detail": msg}))
