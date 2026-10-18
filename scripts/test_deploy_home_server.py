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
if os.environ.get("CHECK_DOCKER_CONFIG"):
    from pathlib import Path
    assert os.environ["HOME"] == os.environ["PAPERCLIP_HOST_HOME"]
    config = Path(os.environ.get("DOCKER_CONFIG", os.environ["HOME"] + "/.docker"))
    assert config.is_dir(), "Script must create Docker config before invoking Docker"
    (config / "buildx-write-probe").write_text("ok")
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
    elif a[0] == "exec" and os.environ.get("BROWSER_POST_FAIL"):
        sys.exit(10)
elif a[0] == "run" and os.environ.get("BROWSER_PRE_FAIL"):
    sys.exit(9)
elif a[0] == "inspect":
    if "--format" not in a:
        mounts = [{"Type": "bind", "Source": os.environ["PAPERCLIP_RUNNER_WORK"], "Destination": os.environ["PAPERCLIP_RUNNER_WORK"]},
                  {"Type": "bind", "Source": os.environ["PAPERCLIP_COMPOSE_DIR"], "Destination": os.environ["PAPERCLIP_COMPOSE_DIR"]}]
        if os.environ.get("BAD_MOUNT"):
            mounts[0]["Source"] = "/different-host-path"
        print(json.dumps([{"Mounts": mounts}]))
    elif "working_dir" in a[2]:
        print("/wrong" if os.environ.get("BAD_PROJECT_DIR") else os.environ["PAPERCLIP_COMPOSE_DIR"])
    elif "compose.project" in a[2]:
        print("home-automation")
    elif "compose.service" in a[2]:
        print("paperclip")
    else:
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
                        PAPERCLIP_HOST_HOME=str(self.root), PAPERCLIP_RUNNER_WORK=str(self.root),
                        HOSTNAME="test-runner",
                        PAPERCLIP_COMPOSE_DIR=str(self.compose),
                        PAPERCLIP_DEPLOY_STATE_DIR=str(self.state), DOCKER_LOG=str(self.log),
                        COMPOSE_PROJECT_NAME="")
        self.env.pop("BASH_ENV", None)
        for key in ("BAD_CONTEXT", "NO_HEALTH", "NO_CONTAINER", "BUILD_FAIL", "HEALTH_FAIL", "BAD_MOUNT", "BAD_PROJECT_DIR", "DOCKER_HOST", "DOCKER_CONTEXT", "CHECK_DOCKER_CONFIG", "DOCKER_CONFIG", "RUNNER_TEMP", "BROWSER_PRE_FAIL", "BROWSER_POST_FAIL"):
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

    def test_docker_state_uses_runner_home_while_compose_uses_host_home(self):
        runner_home = self.root / "runner-home"
        runner_home.mkdir()
        (self.root / ".docker").write_text("host home cannot hold Docker state")
        self.env.pop("DOCKER_CONFIG", None)
        result = self.deploy(HOME=str(runner_home), CHECK_DOCKER_CONFIG="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((runner_home / ".docker/buildx-write-probe").exists())

    def test_explicit_docker_config_is_preserved(self):
        config = self.root / "custom-docker"
        result = self.deploy(DOCKER_CONFIG=str(config), RUNNER_TEMP=str(self.root / "unused-temp"), CHECK_DOCKER_CONFIG="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((config / "buildx-write-probe").exists())

    def test_docker_state_prefers_runner_temp(self):
        runner_temp = self.root / "runner-temp"
        (self.root / ".docker").write_text("host home cannot hold Docker state")
        result = self.deploy(RUNNER_TEMP=str(runner_temp), CHECK_DOCKER_CONFIG="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((runner_temp / ".docker/buildx-write-probe").exists())

    def test_unusable_docker_config_stops_before_docker(self):
        config = self.root / "not-a-directory"
        config.write_text("blocked")
        result = self.deploy(DOCKER_CONFIG=str(config))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot create the runner Docker configuration directory", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_relative_docker_config_stops_before_docker(self):
        result = self.deploy(DOCKER_CONFIG="relative-config")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("absolute runner path", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_browser_preflight_failure_never_recreates_container(self):
        self.assertNotEqual(self.deploy(BROWSER_PRE_FAIL="1").returncode, 0)
        self.assertFalse(any("up" in a for a in self.calls()))
        self.assertFalse((self.state / "last-deployed").exists())

    def test_browser_postflight_failure_preserves_success_marker(self):
        self.state.mkdir()
        marker = self.state / "last-deployed"
        marker.write_text("previous-success")
        self.assertNotEqual(self.deploy(BROWSER_POST_FAIL="1").returncode, 0)
        self.assertEqual(marker.read_text(), "previous-success")

    def test_browser_checks_surround_recreation(self):
        self.assertEqual(self.deploy().returncode, 0)
        calls = self.calls()
        pre = next(i for i, a in enumerate(calls) if a[0] == "run")
        up = next(i for i, a in enumerate(calls) if "up" in a)
        post = next(i for i, a in enumerate(calls) if "exec" in a)
        self.assertLess(pre, up)
        self.assertLess(up, post)
        self.assertIn("node", calls[pre])
        self.assertEqual(calls[post][-4:], ["gosu", "node", "node", "/opt/paperclip-browser/smoke.cjs"])

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

    def test_mismatched_host_mount_stops_before_build(self):
        self.assertNotEqual(self.deploy(BAD_MOUNT="1").returncode, 0)
        self.assertFalse(any("build" in a or "up" in a for a in self.calls()))

    def test_wrong_project_directory_stops_before_build(self):
        self.assertNotEqual(self.deploy(BAD_PROJECT_DIR="1").returncode, 0)
        self.assertFalse(any("build" in a or "up" in a for a in self.calls()))

    def test_project_name_is_pinned_to_running_service(self):
        self.assertEqual(self.deploy().returncode, 0)
        for call in self.calls():
            if call[0] == "compose":
                self.assertEqual(call[call.index("-p") + 1], "home-automation")

    def test_wrong_project_name_stops_before_build(self):
        self.assertNotEqual(self.deploy(COMPOSE_PROJECT_NAME="other").returncode, 0)
        self.assertFalse(any("build" in a or "up" in a for a in self.calls()))

    def test_container_only_checkout_stops_before_docker(self):
        self.assertNotEqual(self.deploy(PAPERCLIP_RUNNER_WORK=str(self.compose)).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_remote_docker_is_rejected(self):
        self.assertNotEqual(self.deploy(DOCKER_HOST="tcp://other:2375").returncode, 0)
        self.assertEqual(self.calls(), [])

if __name__ == "__main__":
    unittest.main()
