#!/usr/bin/env python3
"""Permanent minimal tests for branch_protection_active in multiagent-gates.py.

Promotion is PR-only and gated on main branch protection; these tests pin
that contract: requires a truthy required_pull_request_reviews object,
enforce_admins.enabled true, allow_force_pushes.enabled false.
"""
import importlib.util
import json
import sys
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "multiagent_gates", f"{__import__('os').path.dirname(__file__)}/multiagent-gates.py")
gates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gates)


def run_case(prot, returncode=0, stdout=None):
    m = mock.MagicMock()
    m.returncode = returncode
    m.stdout = stdout if stdout is not None else json.dumps(prot)
    m.stderr = ""
    with mock.patch.object(gates, "out", return_value="org/repo"), \
         mock.patch.object(gates, "sh", return_value=m):
        return gates.branch_protection_active()


class BranchProtectionActive(unittest.TestCase):
    def test_accepts_pr_admins_no_force(self):
        prot = {"required_pull_request_reviews": {"required_approving_review_count": 1},
                "enforce_admins": {"enabled": True},
                "allow_force_pushes": {"enabled": False}}
        run_case(prot)  # no SystemExit

    def test_rejects_null_reviews(self):
        prot = {"required_pull_request_reviews": None,
                "enforce_admins": {"enabled": True},
                "allow_force_pushes": {"enabled": False}}
        with self.assertRaises(SystemExit) as cm:
            run_case(prot)
        self.assertEqual(cm.exception.code, 1)

    def test_rejects_admins_false(self):
        prot = {"required_pull_request_reviews": {"required_approving_review_count": 1},
                "enforce_admins": {"enabled": False},
                "allow_force_pushes": {"enabled": False}}
        with self.assertRaises(SystemExit) as cm:
            run_case(prot)
        self.assertEqual(cm.exception.code, 1)

    def test_rejects_force_push(self):
        prot = {"required_pull_request_reviews": {"required_approving_review_count": 1},
                "enforce_admins": {"enabled": True},
                "allow_force_pushes": {"enabled": True}}
        with self.assertRaises(SystemExit) as cm:
            run_case(prot)
        self.assertEqual(cm.exception.code, 1)

    def test_gh_api_failure_blocks(self):
        prot = {"message": "Not Found"}
        with self.assertRaises(SystemExit) as cm:
            run_case(prot, returncode=1, stdout=json.dumps(prot))
        self.assertEqual(cm.exception.code, 1)


if __name__ == "__main__":
    sys.exit(unittest.main())
