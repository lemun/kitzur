"""Run one experiment: mock server <- gobstopper proxy <- simulated agent.

usage: run.py NAME [--mock ARGS...] [--proxy ARGS...] [--client ARGS...] [--env K=V ...] [--direct]
"""
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
S = os.path.dirname(HERE)
PY = sys.executable
GOB = os.environ.get("KITZUR_GOBSTOPPER_BIN", os.path.join(S, "gobstopper", "target", "release", "gobstopper"))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def split_args(argv):
    groups = {"mock": [], "proxy": [], "client": [], "env": []}
    cur = None
    direct = False
    for a in argv:
        if a in ("--mock", "--proxy", "--client", "--env"):
            cur = a[2:]
        elif a == "--direct":
            direct = True
        else:
            groups[cur].append(a)
    return groups, direct


def wait_http(url, secs=30):
    t = time.time()
    while time.time() - t < secs:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except urllib.error.HTTPError:
            return
        except Exception:
            time.sleep(0.2)
    raise SystemExit(f"timeout waiting for {url}")


def main():
    name = sys.argv[1]
    g, direct = split_args(sys.argv[2:])
    out = os.path.join(S, "runs", name)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    env = dict(os.environ)
    for kv in g["env"]:
        k, v = kv.split("=", 1)
        env[k] = v
    mp, pp = free_port(), free_port()
    mock = subprocess.Popen([PY, os.path.join(HERE, "mock_server.py"), str(mp), out] + g["mock"],
                            env=env, stdout=open(os.path.join(out, "mock.out"), "w"), stderr=subprocess.STDOUT)
    wait_http(f"http://127.0.0.1:{mp}/")
    proxy = None
    base = f"http://127.0.0.1:{mp}"
    if not direct:
        penv = dict(env, GOBSTOPPER_STATS_FILE=os.path.join(out, "ledger.jsonl"),
                    HOME=os.path.join(out, "home"))
        with open(os.path.join(out, "proxy.args"), "w") as f:
            f.write(" ".join(g["proxy"]))
        proxy = subprocess.Popen([GOB, "proxy", "serve", "--port", str(pp),
                                  "--openai-upstream", f"http://127.0.0.1:{mp}"] + g["proxy"],
                                 env=penv, stdout=open(os.path.join(out, "proxy.log"), "w"),
                                 stderr=subprocess.STDOUT)
        wait_http(f"http://127.0.0.1:{pp}/gobstopper/status")
        base = f"http://127.0.0.1:{pp}"
    t = time.time()
    rc = subprocess.call([PY, os.path.join(HERE, "agent_client.py"), base, out] + g["client"], env=env)
    print(f"[{name}] client rc={rc} in {time.time() - t:.0f}s", flush=True)
    if proxy:
        try:
            st = urllib.request.urlopen(f"http://127.0.0.1:{pp}/gobstopper/status", timeout=5).read()
            open(os.path.join(out, "proxy_status.json"), "wb").write(st)
        except Exception as e:  # noqa: BLE001
            print("status failed", e)
        proxy.terminate()
    mock.terminate()


main()
