import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("deploy-home-server.sh").resolve()

DOCKER = """#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
with open(os.environ["DOCKER_LOG"], "a") as f:
    f.write(json.dumps(a) + "\\n")
if a[0] == "compose":
    a = a[a.index("-f") + 2:]
    if a[0] == "config":
        service = {"build": {"context": os.environ["PAPERCLIP_SOURCE_DIR"], "target": "production"},
                   "image": "tbro/paperclip:local", "healthcheck": {"test": ["CMD", "true"]}}
        if os.environ.get("BAD_CONTEXT"):
            service["build"]["context"] = "/wrong"
        if os.environ.get("NO_HEALTH"):
            service.pop("healthcheck")
        print(json.dumps({"services": {"paperclip": service}}))
    elif a[0] == "ps":
        if not os.environ.get("NO_CONTAINER"):
            print("container-id")
    elif a[0] == "build" and os.environ.get("BUILD_FAIL"):
        sys.exit(7)
    elif a[0] == "up" and os.environ.get("HEALTH_FAIL"):
        sys.exit(8)
elif a[0] == "inspect":
    print("sha256:old-image")
"""

class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.compose = self.root / "compose"
        self.compose.mkdir()
        self.state = self.root / "state"
        self.log = self.root / "docker.log"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        docker = self.bin / "docker"
        docker.write_text(DOCKER)
        docker.chmod(0o755)
        (self.bin / "git").symlink_to("/usr/bin/git")
        self.git("init", "-b", "master")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.source / "README").write_text("source")
        self.git("add", "README")
        self.git("commit", "-m", "initial")
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        PAPERCLIP_SOURCE_DIR=str(self.source),
                        PAPERCLIP_COMPOSE_DIR=str(self.compose),
                        PAPERCLIP_DEPLOY_STATE_DIR=str(self.state), DOCKER_LOG=str(self.log),
                        COMPOSE_PROJECT_NAME="")
        self.env.pop("BASH_ENV", None)
        for key in ("BAD_CONTEXT", "NO_HEALTH", "NO_CONTAINER", "BUILD_FAIL", "HEALTH_FAIL"):
            self.env.pop(key, None)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.source), *args], stderr=subprocess.DEVNULL, text=True).strip()

    def deploy(self, **env):
        return subprocess.run(["bash", str(SCRIPT)], env=dict(self.env, **env),
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_success_builds_then_recreates_only_paperclip_and_records_revision(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        build = next(i for i, a in enumerate(calls) if "build" in a)
        up = next(i for i, a in enumerate(calls) if "up" in a)
        self.assertLess(build, up)
        self.assertEqual(calls[build][-3:], ["build", "--pull", "paperclip"])
        self.assertEqual(calls[up][-1], "paperclip")
        for option in ("--no-build", "--no-deps", "--force-recreate", "--wait", "--wait-timeout"):
            self.assertIn(option, calls[up])
        self.assertIn(["image", "tag", "sha256:old-image", "tbro/paperclip:previous"], calls)
        self.assertEqual((self.state / "last-deployed").read_text().strip(), self.git("rev-parse", "HEAD"))

    def test_build_failure_never_recreates_container(self):
        self.assertNotEqual(self.deploy(BUILD_FAIL="1").returncode, 0)
        self.assertFalse(any("up" in a for a in self.calls()))
        self.assertFalse((self.state / "last-deployed").exists())

    def test_health_failure_preserves_success_marker_and_retry_works(self):
        self.state.mkdir()
        marker = self.state / "last-deployed"
        marker.write_text("previous-success")
        self.assertNotEqual(self.deploy(HEALTH_FAIL="1").returncode, 0)
        self.assertEqual(marker.read_text(), "previous-success")
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(marker.read_text().strip(), self.git("rev-parse", "HEAD"))

    def test_wrong_build_context_stops_before_build(self):
        self.assertNotEqual(self.deploy(BAD_CONTEXT="1").returncode, 0)
        self.assertFalse(any("build" in a or "up" in a for a in self.calls()))

    def test_missing_health_check_stops_before_build(self):
        self.assertNotEqual(self.deploy(NO_HEALTH="1").returncode, 0)
        self.assertFalse(any("build" in a or "up" in a for a in self.calls()))

    def test_missing_running_container_stops_before_build(self):
        self.assertNotEqual(self.deploy(NO_CONTAINER="1").returncode, 0)
        self.assertFalse(any("build" in a or "up" in a for a in self.calls()))

    def test_dirty_checkout_stops_before_docker(self):
        (self.source / "README").write_text("edited")
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_wrong_branch_stops_before_docker(self):
        self.git("checkout", "-b", "feature")
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_same_revision_can_be_redeployed(self):
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(self.deploy().returncode, 0)
        self.assertEqual(sum("up" in a for a in self.calls()), 2)

if __name__ == "__main__":
    unittest.main()
