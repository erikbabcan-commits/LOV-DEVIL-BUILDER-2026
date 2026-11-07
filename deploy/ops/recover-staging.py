#!/usr/bin/env python3
"""Start the pinned staging containers in dependency order."""
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path

DOCKER = "/usr/bin/docker"
SYSTEM_SOCKET = "/var/run/docker.sock"
STAGING_PORTS = {
    "8787/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8788"}],
    "8791/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8791"}],
}
CONTAINER = """{
    "id": {{json .Id}}, "image": {{json .Image}}, "labels": {{json .Config.Labels}},
    "ports": {{json .HostConfig.PortBindings}},
    "restart": {{json .HostConfig.RestartPolicy.Name}},
    "mounts": {{json .Mounts}}, "state": {{json .State}}
}"""


def docker(*args, socket_path=SYSTEM_SOCKET):
    return subprocess.run(
        [DOCKER, "--host", "unix://" + socket_path, *args],
        check=True, capture_output=True, text=True, timeout=5,
    ).stdout


def inspect(name):
    return json.loads(docker("inspect", "--type", "container", "--format", CONTAINER, name))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify_container(name, image, role, socket_path):
    require(re.fullmatch(r"lov-(devil-api|sandbox-runner)-013-[0-9a-f]{12}", name),
            "unexpected staging container name")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", image), "invalid staging image ID")
    current = inspect(name)
    labels = current["labels"] or {}
    require(current["image"] == image and labels.get("lov-devil.owner") == "runtime-013"
            and labels.get("lov-devil.role") == role, "staging identity mismatch")
    require(current["restart"] == "no", "staging container has a competing restart policy")
    if role == "api":
        require(current["ports"] == STAGING_PORTS, "staging API ports do not match")
    else:
        require(not current["ports"], "staging runner has published ports")
        require(any(mount["Type"] == "bind" and mount["Source"] == socket_path
                    and mount["Destination"] == SYSTEM_SOCKET for mount in current["mounts"]),
                "staging runner socket bind does not match")
    return current


def verify_rootless_socket(uid, socket_path):
    metadata = Path(socket_path).lstat()
    require(stat.S_ISSOCK(metadata.st_mode) and metadata.st_uid == uid,
            "rootless socket does not match the configured owner")
    options = json.loads(docker("info", "--format", "{{json .SecurityOptions}}",
                                socket_path=socket_path))
    require("name=rootless" in options, "worker daemon is not rootless")


def ensure_healthy(name, image, role, socket_path, container):
    container_id = container["id"]
    state = container["state"]
    require(not state["Paused"] and not state["Restarting"], "staging container is paused or restarting")
    if not state["Running"]:
        docker("start", container_id)
        print(f"Started staging {role}", flush=True)
        current = verify_container(name, image, role, socket_path)
        require(current["id"] == container_id, "staging container was replaced")
        state = current["state"]
    deadline = time.monotonic() + 35
    while state["Running"] and not state["Paused"] and not state["Restarting"]:
        if (state.get("Health") or {}).get("Status") == "healthy":
            return
        if time.monotonic() >= deadline:
            break
        time.sleep(1)
        current = verify_container(name, image, role, socket_path)
        require(current["id"] == container_id, "staging container was replaced")
        state = current["state"]
    raise RuntimeError(f"staging {role} did not become healthy")


def recover(env):
    uid = int(env["LOV_STAGING_ROOTLESS_UID"])
    require(uid > 0, "rootless worker UID must be unprivileged")
    socket_path = f"/run/user/{uid}/docker.sock"
    runner = (env["LOV_STAGING_RUNNER"], env["LOV_STAGING_RUNNER_IMAGE"], "runner", socket_path)
    api = (env["LOV_STAGING_API"], env["LOV_STAGING_API_IMAGE"], "api", socket_path)

    runner_container = verify_container(*runner)
    verify_container(*api)
    verify_rootless_socket(uid, socket_path)
    ensure_healthy(*runner, runner_container)
    # Read API state again after waiting for the runner.
    ensure_healthy(*api, verify_container(*api))


if __name__ == "__main__":
    try:
        recover(os.environ)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"LOV-DEVIL staging recovery: {message}", file=sys.stderr)
        sys.exit(1)
