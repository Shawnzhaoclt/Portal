"""Command line interface for local Portal schema maintenance."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .catalog import register_business_schema
from .manager import SchemaManager


def _manager(args: argparse.Namespace) -> SchemaManager:
    return SchemaManager(args.system_database, args.business_database)


def main() -> None:
    parser = argparse.ArgumentParser(prog="portal-schema", description="Portal local schema maintenance")
    parser.add_argument("--system-database", type=Path, required=True)
    parser.add_argument("--business-database", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("catalog-register")
    commands.add_parser("status")
    commands.add_parser("initialize")
    validate = commands.add_parser("validate")
    validate.add_argument("--target-release")
    plan = commands.add_parser("plan")
    plan.add_argument("--target-release")
    migrate = commands.add_parser("migrate")
    migrate.add_argument("--target-release")
    migrate.add_argument("--confirm", action="store_true", help="Confirm local database replacement after validation.")
    rollback = commands.add_parser("rollback")
    rollback.add_argument("--confirm", action="store_true", help="Confirm restoration of the retained previous database.")
    args = parser.parse_args()

    if args.command == "catalog-register":
        result = register_business_schema(args.system_database, args.business_database)
    else:
        manager = _manager(args)
        if args.command == "status":
            result = manager.status()
        elif args.command == "initialize":
            result = manager.initialize()
        elif args.command == "validate":
            result = manager.validate(args.target_release)
        elif args.command == "plan":
            result = manager.plan(args.target_release)
        elif args.command == "migrate":
            if not args.confirm:
                parser.error("migrate requires --confirm")
            result = manager.migrate(args.target_release)
        else:
            if not args.confirm:
                parser.error("rollback requires --confirm")
            result = manager.rollback()
    print(json.dumps(result, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
