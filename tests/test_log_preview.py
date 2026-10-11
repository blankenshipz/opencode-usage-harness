import sys
import unittest


sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "src"))
from log_preview import compact_lines


class LogPreviewTest(unittest.TestCase):
    def test_distinct_error_numbers_and_paths_are_preserved(self):
        lines = [
            "ERROR code=17 path=/tmp/a\n",
            "ERROR code=18 path=/tmp/b\n",
            "ERROR code=19 path=/tmp/c\n",
        ]
        result = compact_lines(lines)
        self.assertEqual(result["text"], "".join(lines))
        self.assertFalse(result["compacted"])
        self.assertEqual(result["duplicate_lines_collapsed"], 0)

    def test_nonconsecutive_repeats_are_not_collapsed(self):
        lines = ["same\n", "other\n", "same\n", "other\n"]
        result = compact_lines(lines)
        self.assertEqual(result["text"], "".join(lines))
        self.assertFalse(result["compacted"])

    def test_short_input_has_no_marker_overhead(self):
        lines = ["same\n", "same\n"]
        result = compact_lines(lines)
        self.assertEqual(result, {
            "text": "same\nsame\n",
            "input_chars": 10,
            "output_chars": 10,
            "duplicate_lines_collapsed": 0,
            "compacted": False,
        })

    def test_long_duplicate_run_has_exact_count_and_line_references(self):
        lines = ["header\n"] + ["repeat\n"] * 20 + ["footer\n"]
        result = compact_lines(lines, start_line=40)
        self.assertTrue(result["compacted"])
        self.assertEqual(result["duplicate_lines_collapsed"], 19)
        self.assertIn("source lines 41-60 repeat line 41 exactly; 19 repetitions omitted", result["text"])
        self.assertEqual(result["input_chars"], len("".join(lines)))
        self.assertEqual(result["output_chars"], len(result["text"]))
        self.assertLess(result["output_chars"], result["input_chars"])
        self.assertTrue(result["text"].startswith("header\nrepeat\n"))
        self.assertTrue(result["text"].endswith("footer\n"))

    def test_whitespace_and_newline_differences_are_not_normalized(self):
        line = "x" * 100 + "\n"
        lines = [line, "x" * 100 + "\r\n", line, line, line]
        result = compact_lines(lines)
        self.assertTrue(result["compacted"])
        self.assertIn("x\r\n", result["text"])
        self.assertIn("source lines 3-5", result["text"])

    def test_range_validation(self):
        with self.assertRaises(ValueError):
            compact_lines(["x\n"] * 351)
        with self.assertRaises(ValueError):
            compact_lines([], 0)
        with self.assertRaises(ValueError):
            compact_lines([], -1)
        with self.assertRaises(ValueError):
            compact_lines([], True)


if __name__ == "__main__":
    unittest.main()
