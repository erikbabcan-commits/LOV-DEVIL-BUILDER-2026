"""Focused tests for the staging dependency and ownership guards."""
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "recover_staging", Path(__file__).with_name("recover-staging.py")
)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)

RUNNER = "lov-sandbox-runner-013-d9b279b56f37"
API = "lov-devil-api-013-2b556f916f92"
SOCKET = "/run/user/987/docker.sock"
RUNNER_IMAGE = "sha256:" + "1" * 64
API_IMAGE = "sha256:" + "2" * 64
ENV = {
    "LOV_STAGING_ROOTLESS_UID": "987",
    "LOV_STAGING_RUNNER": RUNNER,
    "LOV_STAGING_RUNNER_IMAGE": RUNNER_IMAGE,
    "LOV_STAGING_API": API,
    "LOV_STAGING_API_IMAGE": API_IMAGE,
}


def container(role, running, health="healthy"):
    return {
        "id": role + "-id",
        "image": RUNNER_IMAGE if role == "runner" else API_IMAGE,
        "labels": {"lov-devil.owner": "runtime-013", "lov-devil.role": role},
        "restart": "no",
        "ports": {} if role == "runner" else recovery.STAGING_PORTS,
        "mounts": [{"Type": "bind", "Source": SOCKET, "Destination": recovery.SYSTEM_SOCKET}],
        "state": {"Running": running, "Paused": False, "Restarting": False,
                  "Health": {"Status": health}},
    }


class RecoveryTests(unittest.TestCase):
    def test_starts_only_the_pinned_ids_after_rootless_and_runner_are_ready(self):
        current = {RUNNER: container("runner", False), API: container("api", False)}
        events = []

        def start(command, container_id):
            self.assertEqual(command, "start")
            events.append(container_id)
            name = RUNNER if container_id == "runner-id" else API
            current[name]["state"]["Running"] = True

        with patch.object(recovery, "inspect", side_effect=current.__getitem__), \
             patch.object(recovery, "verify_rootless_socket", side_effect=lambda *_: events.append("rootless")), \
             patch.object(recovery, "docker", side_effect=start):
            recovery.recover(ENV)
        self.assertEqual(events, ["rootless", "runner-id", "api-id"])

    def test_unhealthy_runner_never_starts_api(self):
        current = {RUNNER: container("runner", True, "unhealthy"), API: container("api", False)}
        with patch.object(recovery, "inspect", side_effect=current.__getitem__), \
             patch.object(recovery, "verify_rootless_socket"), \
             patch.object(recovery.time, "monotonic", side_effect=[0, 36]), \
             patch.object(recovery, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "runner did not become healthy"):
                recovery.recover(ENV)
        docker.assert_not_called()

    def test_wrong_api_identity_prevents_starting_even_the_runner(self):
        current = {RUNNER: container("runner", False), API: container("api", False)}
        current[API]["image"] = RUNNER_IMAGE
        with patch.object(recovery, "inspect", side_effect=current.__getitem__), \
             patch.object(recovery, "verify_rootless_socket") as rootless, \
             patch.object(recovery, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                recovery.recover(ENV)
        rootless.assert_not_called()
        docker.assert_not_called()

    def test_missing_rootless_socket_does_not_start_containers(self):
        current = {RUNNER: container("runner", False), API: container("api", False)}
        with patch.object(recovery, "inspect", side_effect=current.__getitem__), \
             patch.object(recovery, "verify_rootless_socket", side_effect=FileNotFoundError), \
             patch.object(recovery, "docker") as docker:
            with self.assertRaises(FileNotFoundError):
                recovery.recover(ENV)
        docker.assert_not_called()

    def test_healthy_containers_need_no_start(self):
        current = {RUNNER: container("runner", True), API: container("api", True)}
        with patch.object(recovery, "inspect", side_effect=current.__getitem__), \
             patch.object(recovery, "verify_rootless_socket"), \
             patch.object(recovery, "docker") as docker:
            recovery.recover(ENV)
        docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
