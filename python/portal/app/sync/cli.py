from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .coordinator import DataCoordinator, bootstrap_shared_store
from .errors import SyncError
from .models import Identity, Mutation


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="portal-data-coordinator",
        description="Portal LAN business-data synchronization coordinator",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    bootstrap = subparsers.add_parser("bootstrap", help="Initialize a new shared protocol root")
    bootstrap.add_argument("--network-root", type=Path, required=True)
    bootstrap.add_argument(
        "--member",
        action="append",
        required=True,
        metavar="USER_ID:EMPLOYEE_NUMBER[:EMAIL]",
    )

    for name in ("initialize", "status", "sync", "recover"):
        command = subparsers.add_parser(name)
        _identity_options(command)

    commit = subparsers.add_parser("commit", help="Commit mutations from a JSON file")
    _identity_options(commit)
    commit.add_argument("--mutations", type=Path, required=True)
    return parser


def _identity_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--network-root", type=Path, required=True)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--employee-number", required=True)
    parser.add_argument("--email", default="")


def _identity(value: argparse.Namespace) -> Identity:
    return Identity(value.user_id, value.employee_number, value.email)


def _coordinator(value: argparse.Namespace) -> DataCoordinator:
    return DataCoordinator(
        identity=_identity(value),
        database_path=value.database,
        network_root=value.network_root,
    )


def _members(values: list[str]) -> list[Identity]:
    result: list[Identity] = []
    for value in values:
        parts = value.split(":", 2)
        if len(parts) < 2:
            raise ValueError(f"Invalid member specification: {value}")
        result.append(Identity(parts[0], parts[1], parts[2] if len(parts) > 2 else ""))
    return result


def _mutations(path: Path) -> list[Mutation]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, list):
        raise ValueError("The mutations document must contain a JSON array.")
    return [Mutation(**item) for item in value]


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "bootstrap":
            result = bootstrap_shared_store(args.network_root, _members(args.member))
        else:
            coordinator = _coordinator(args)
            if args.command == "initialize":
                result = coordinator.initialize()
            else:
                coordinator.actor_id = str(coordinator.store.actor_row()["actor_id"])
                if args.command == "status":
                    result = coordinator.status()
                elif args.command == "sync":
                    result = coordinator.sync()
                elif args.command == "recover":
                    result = coordinator.recover()
                elif args.command == "commit":
                    result = vars(coordinator.commit(_mutations(args.mutations)))
                else:
                    raise ValueError(f"Unsupported command: {args.command}")
        print(json.dumps(result, indent=2, default=str))
        return 0
    except SyncError as error:
        print(
            json.dumps(
                {"error": error.code, "message": str(error), "details": error.details},
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"error": "INVALID_INPUT", "message": str(error)}, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
