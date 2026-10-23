"""Offline provenance for a staged runtime, including generated config/launchers.

An explicit reviewed snapshot is required. Verification never repairs drift or
starts services. Hashes attest bytes, not the safety of a configuration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


class PreflightError(RuntimeError):
    pass


def record(path):
    path = Path(path).absolute()
    if path.is_symlink() or not path.is_file():
        raise PreflightError("missing or symlinked artifact: " + str(path))
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "mode": path.stat().st_mode & 0o777}


def plugin_files(root):
    root = Path(root).absolute()
    if root.is_symlink() or not root.is_dir():
        raise PreflightError("plugin directory unavailable")
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise PreflightError("symlink in staged plugin tree")
        if path.is_file() and path.suffix == ".mjs":
            files.append(path)
    if not files:
        raise PreflightError("empty plugin inventory")
    return files


def snapshot(plugin_root, artifacts, entries, node):
    node = Path(node).absolute()
    # Installed toolkit manifests cover the whole payload, including validators,
    # Python helpers and launchers outside the plugin directory. Include those
    # bytes rather than attesting imports alone.
    manifest = Path(plugin_root).absolute().parent / "manifest.json"
    payload = []
    if manifest.is_file():
        for item in json.loads(manifest.read_text())["files"]:
            relative = Path(item["path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise PreflightError("unsafe payload manifest path")
            payload.append(manifest.parent / relative)
        payload.append(manifest)
    result = {"schema": 1, "plugin_root": str(Path(plugin_root).absolute()),
              "files": [record(p) for p in sorted(set(plugin_files(plugin_root) + payload +
                         [Path(p).absolute() for p in artifacts] + [node]))],
              "entries": [str(Path(p).absolute()) for p in entries], "node": str(node)}
    verify(result)
    return result


def verify(receipt):
    if receipt.get("schema") != 1 or not receipt.get("files") or not receipt.get("entries"):
        raise PreflightError("invalid provenance receipt")
    expected = {item["path"]: item for item in receipt["files"]}
    if len(expected) != len(receipt["files"]):
        raise PreflightError("duplicate provenance paths")
    for name, item in expected.items():
        if record(name) != item:
            raise PreflightError("artifact drift: " + name)
    actual_plugins = {str(p) for p in plugin_files(receipt["plugin_root"])}
    expected_plugins = {p for p in expected if Path(p).is_relative_to(receipt["plugin_root"]) and p.endswith(".mjs")}
    if actual_plugins != expected_plugins:
        raise PreflightError("plugin inventory drift")
    node = receipt["node"]
    if node not in expected or not os.access(node, os.X_OK):
        raise PreflightError("Node dependency unavailable")
    # Import exactly the staged generated entry points, without calling setup.
    # The minimal environment excludes provider keys and unrelated credentials.
    env = {"PATH": str(Path(node).parent) + os.pathsep + os.defpath,
           "LANG": "C", "HOME": str(Path(receipt["plugin_root"]).parent)}
    for entry in receipt["entries"]:
        if entry not in expected:
            raise PreflightError("entry point not in provenance")
        script = "import {pathToFileURL} from 'node:url'; await import(pathToFileURL(process.argv[1]).href)"
        try:
            run = subprocess.run([node, "--input-type=module", "-e", script, entry],
                                 env=env, capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            raise PreflightError("entry import unavailable: " + entry) from None
        if run.returncode:
            # Do not print dependency exceptions, source excerpts or environment.
            raise PreflightError("entry import failed (dependency or syntax): " + entry)
    return {"verified": True, "files": len(expected), "entries": len(receipt["entries"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["snapshot", "verify"])
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--plugins", type=Path)
    parser.add_argument("--artifact", type=Path, action="append", default=[])
    parser.add_argument("--entry", type=Path, action="append", default=[])
    parser.add_argument("--node", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "snapshot":
            if not args.plugins or not args.node or not args.entry:
                parser.error("snapshot requires --plugins, --node and --entry")
            if args.receipt.exists():
                raise PreflightError("refusing to replace reviewed provenance")
            result = snapshot(args.plugins, args.artifact, args.entry, args.node)
            fd = os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump(result, handle, indent=2)
                handle.write("\n")
            print("Staged provenance recorded; no activation performed.")
        else:
            print(json.dumps(verify(json.loads(args.receipt.read_text()))))
    except (PreflightError, OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, "Preflight failed: " + str(error) + "\n")


if __name__ == "__main__":
    main()
