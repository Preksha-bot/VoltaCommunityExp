"""Create deterministic, typed DEMO fixtures from the supplied workbook.

The source XLSX is read only. Documentation and reference outputs never become
operational founder data; public test passwords remain in a separate bundle.
"""
from __future__ import annotations

import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from openpyxl.utils.datetime import from_excel

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "fixtures/source/Volta_Pulse_V1_Fictional_Founders.xlsx"
OUTPUT = ROOT / "fixtures"
SEED_TABLES = ["Companies", "Founders", "Topics", "PulseEntries", "ConsentLog",
               "OutreachHistory", "Conversations", "InterestResponses", "TimeSlots",
               "Availability", "Feedback", "Stories", "StoryApprovals", "Settings"]
REFERENCE_TABLES = {"DemoLogins": "demo-logins.json", "ExpectedMatches": "expected-matches.json",
                    "TestCases": "test-cases.json"}
LIST_FIELDS = {"candidate_company_ids", "potential_company_ids", "required_approver_ids"}


def utc(value: datetime) -> str:
    # Excel stores no timezone; the specification explicitly declares UTC.
    return value.replace(tzinfo=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    workbook = openpyxl.load_workbook(SOURCE, data_only=True, read_only=False)
    tables: dict[str, list[dict]] = {}
    fields: dict[str, list[str]] = {}
    for name in SEED_TABLES + list(REFERENCE_TABLES):
        sheet = workbook[name]
        headers = [cell.value for cell in sheet[1]]
        fields[name] = headers
        rows = []
        for cells in sheet.iter_rows(min_row=2, values_only=True):
            if all(value is None for value in cells):
                continue
            row = {}
            for key, value in zip(headers, cells):
                if isinstance(value, datetime):
                    value = utc(value)
                elif key in LIST_FIELDS:
                    value = value.split("|") if isinstance(value, str) else []
                row[key] = value
            if name == "Settings" and row["setting_key"] == "fixture_now_utc":
                value = row["setting_value"]
                if isinstance(value, (int, float)):
                    row["setting_value"] = utc(from_excel(value, workbook.epoch))
            rows.append(row)
        tables[name] = rows

    # A confirmation stamp is distinct from an ordinary edit in runtime data.
    for entry in tables["PulseEntries"]:
        entry["confirmed_at_utc"] = entry["created_at_utc"]
        entry["confirmation_provenance"] = "SOURCE_FIXTURE_EXPLICIT_CONFIRMATION"
    for response in tables["InterestResponses"]:
        stamp = datetime.fromisoformat(response["responded_at_utc"].replace("Z", "+00:00"))
        from datetime import timedelta
        response["expires_at_utc"] = utc(stamp + timedelta(days=14))
    for approval in tables["StoryApprovals"]:
        story = next(row for row in tables["Stories"] if row["story_id"] == approval["story_id"])
        # Preserve the exact source wording/audience for the declared approval version.
        if approval["approved_version"] == story["version"]:
            approval["approved_text"] = story["approved_text"]
            approval["sharing_mode"] = story["sharing_mode"]

    OUTPUT.mkdir(parents=True, exist_ok=True)
    seed = {name: tables[name] for name in SEED_TABLES}
    write_json(OUTPUT / "seed.json", seed)
    for name, filename in REFERENCE_TABLES.items():
        write_json(OUTPUT / filename, tables[name])

    csv_dir = OUTPUT / "seed_csv"
    csv_dir.mkdir(exist_ok=True)
    # These CSVs contain domain fixtures only, never public demo passwords.
    for name in SEED_TABLES:
        headers = list(tables[name][0]) if tables[name] else fields[name]
        with (csv_dir / f"{name}.csv").open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=headers)
            writer.writeheader()
            for row in tables[name]:
                writer.writerow({key: "|".join(value) if isinstance(value, list) else
                                 "TRUE" if value is True else "FALSE" if value is False else
                                 "" if value is None else value for key, value in row.items()})

    write_json(OUTPUT / "fixture-manifest.json", {
        "schema_version": "1.0", "derived_from": SOURCE.name,
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "environment": "DEMO", "outreach_mode": "DRAFT_ONLY",
        "fixture_now_utc": "2026-10-13T12:00:00Z",
        "profiles": ["BASE", "RETRY_SENT", "GROUP_READY", "SAME_COMPANY_GUARD", "NO_COMMON_SLOT", "STORY_CASES"],
        "counts": {name: len(rows) for name, rows in tables.items()}, "source_fields": fields,
        "reference_only": list(REFERENCE_TABLES),
        "normalizations": ["All spreadsheet datetime columns interpreted as UTC.",
                           "Settings!B5 Excel serial converted explicitly to UTC ISO-8601.",
                           "Only declared ID-list columns split on pipes.",
                           "Entry confirmation stamp derived from source creation; updates never renew it.",
                           "Interest expiry initialized to explicit response plus fourteen days.",
                           "Story approvals bound to source exact text and sharing mode for their declared version."],
        "preserved_scenario_exceptions": [
            "G001/G002 seeded polls retain explicit four-day deadlines; new polls use five days.",
            "Scenario interest responses precede conversation creation; preserve source dates."],
        "application_tests": "NOT_RUN", "safety": "Never import demo credentials, synthetic identities or fake event IDs into LIVE."
    })
    print(f"Imported {len(SEED_TABLES)} domain tables; source SHA-256 recorded. No source modifications.")


if __name__ == "__main__":
    main()
