import json
import unittest
from pathlib import Path


CONFIG = Path(__file__).parents[1] / "config" / "instructions.json"


class InstructionBudgetTest(unittest.TestCase):
    def load(self):
        return json.loads(CONFIG.read_text())

    def test_instruction_sections_are_substantially_smaller_than_previous_budget(self):
        data = self.load()
        self.assertLessEqual(sum(len(data[key]) for key in ("common", "routing", "leaf", "instructions")), 15000)
        self.assertLessEqual(len(data["common"]), 6500)
        self.assertLessEqual(len(data["routing"]), 6500)

    def test_key_safety_and_authority_invariants_remain_explicit(self):
        text = "\n".join(self.load().values()).lower()
        for phrase in (
            "oauth", "api key", "paid credits", "top-ups", "secrets", "native authorization",
            "task_intent", "intentrevision", "scope=checkpoint", "large_file", "never delegate",
            "coordinator", "no automatic spending", "workreview", "hypothesis", "evidencereference",
            "never clone", "refreshes full intent", "same child",
        ):
            self.assertIn(phrase, text)

    def test_dispatch_routing_and_compaction_contracts_are_explicit(self):
        data = self.load()
        self.assertNotIn("workReview", data)
        routing = data["routing"].lower()
        for phrase in (
            "complexity:'routine'|'standard'|'complex'", "risk:'normal'|'high'", "resetmodel:true",
            "legacy sessions adopt", "compact:true", "wait idle", "completed/idle", "one worker per bounded lane",
            "cumulative review", "permission loop", "completed boundary",
        ):
            self.assertIn(phrase, routing)

    def test_coordination_guidance_avoids_bookkeeping_churn(self):
        data = self.load()
        routing = data["routing"].lower()
        leaf = data["leaf"].lower()
        for phrase in (
            "stable integration owner", "end-to-end slice",
            "meaningful implementation and verification", "summary:true",
            "full status only to resolve a specific evidence gap", "real context pressure",
            "blanket git holds", "serialized commongit coordination scope",
            "native command permissions and approvals still apply",
        ):
            self.assertIn(phrase, routing)
        self.assertIn("rather than stopping for routine bookkeeping", leaf)

    def test_delivery_denial_and_writer_continuation_contracts_are_explicit(self):
        routing = self.load()["routing"].lower()
        for phrase in (
            "executable acceptance command", "input/output contract",
            "separate feature and publication gates", "revive parked delivery",
            "current intent and gate", "content-rights/review gates",
            "exact actor, action and resource", "never retry the denied action",
            "retain admitted writepaths", "nondeploy operation changes",
            "implicit same-key continuations", "publication:{revision:<full oid>,checkout:<path>}", "publish requires explicit paths", "readonly-to-writer",
            "reject empty[]", "exact overlapping paths",
        ):
            self.assertIn(phrase, routing)


if __name__ == "__main__":
    unittest.main()
