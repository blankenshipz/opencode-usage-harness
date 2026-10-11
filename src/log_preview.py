"""Small, deterministic formatting helpers for bounded command log previews."""

from __future__ import annotations

from typing import TypedDict


_MAX_LINES = 350


class LogPreview(TypedDict):
    text: str
    input_chars: int
    output_chars: int
    duplicate_lines_collapsed: int
    compacted: bool


def compact_lines(lines: list[str], start_line: int = 1) -> LogPreview:
    """Compact exact runs of three or more lines when that saves characters.

    The caller supplies lines with their original newline endings.  This
    function deliberately treats each string as opaque text: no whitespace,
    ANSI, path, or other normalization is performed.
    """
    if len(lines) > _MAX_LINES:
        raise ValueError(f"lines must contain at most {_MAX_LINES} entries")
    if isinstance(start_line, bool) or not isinstance(start_line, int) or start_line <= 0:
        raise ValueError("start_line must be a positive integer")

    original = "".join(lines)
    input_chars = len(original)
    compacted_parts: list[str] = []
    duplicate_lines_collapsed = 0
    index = 0

    while index < len(lines):
        run_end = index + 1
        while run_end < len(lines) and lines[run_end] == lines[index]:
            run_end += 1
        run_length = run_end - index
        if run_length >= 3:
            source_start = start_line + index
            source_end = start_line + run_end - 1
            omitted = run_length - 1
            compacted_parts.append(lines[index])
            compacted_parts.append(
                f"[preview: source lines {source_start}-{source_end} "
                f"repeat line {source_start} exactly; {omitted} repetitions omitted]\n"
            )
            duplicate_lines_collapsed += omitted
        else:
            compacted_parts.extend(lines[index:run_end])
        index = run_end

    compacted_text = "".join(compacted_parts)
    output_chars = len(compacted_text)
    if duplicate_lines_collapsed == 0 or output_chars >= input_chars:
        return {
            "text": original,
            "input_chars": input_chars,
            "output_chars": input_chars,
            "duplicate_lines_collapsed": 0,
            "compacted": False,
        }
    return {
        "text": compacted_text,
        "input_chars": input_chars,
        "output_chars": output_chars,
        "duplicate_lines_collapsed": duplicate_lines_collapsed,
        "compacted": True,
    }
