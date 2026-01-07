#!/usr/bin/env python3
"""
CLI tool to add specs to Auto-Claude GUI.

Creates all required spec files so the spec appears in the GUI.

Usage:
    # Simple single-phase spec:
    python add_spec.py --project-dir /path/to/project --name "feature-name" --description "What to build"

    # With more options:
    python add_spec.py --project-dir /path/to/project \
        --name "my-feature" \
        --description "Build the feature that does X" \
        --files-to-create "module.py,tests/test_module.py" \
        --files-to-modify "config.py" \
        --files-to-reference "docs/SPEC.md" \
        --workflow-type "feature" \
        --chunks "Create module structure,Implement core logic,Add tests"

    # Multi-phase spec with dependencies (from JSON file):
    python add_spec.py --project-dir /path/to/project --name "complex-feature" --from-json phases.json

phases.json format:
{
  "description": "What to build",
  "workflow_type": "feature",
  "phases": [
    {
      "name": "Phase 1 Name",
      "description": "What phase 1 does",
      "chunks": [
        {"description": "Task 1", "files": ["file1.py"], "verification": "How to verify"}
      ]
    },
    {
      "name": "Phase 2 Name",
      "depends_on": [1],
      "chunks": [
        {"description": "Task 2", "files": ["file2.py"]}
      ]
    }
  ]
}
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def get_next_spec_number(specs_dir: Path) -> int:
    """Find the next available spec number."""
    if not specs_dir.exists():
        return 1

    existing = []
    for item in specs_dir.iterdir():
        if item.is_dir() and item.name[:3].isdigit():
            try:
                num = int(item.name[:3])
                existing.append(num)
            except ValueError:
                pass

    if not existing:
        return 1
    return max(existing) + 1


def create_spec(
    project_dir: str,
    name: str,
    description: str,
    files_to_create: list[str] | None = None,
    files_to_modify: list[str] | None = None,
    files_to_reference: list[str] | None = None,
    workflow_type: str = "feature",
    chunks: list[str] | None = None,
) -> str:
    """Create all spec files and return the spec directory path."""

    project_path = Path(project_dir).resolve()
    specs_dir = project_path / ".auto-claude" / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)

    # Get next spec number
    spec_num = get_next_spec_number(specs_dir)
    spec_id = f"{spec_num:03d}-{name}"
    spec_dir = specs_dir / spec_id
    spec_dir.mkdir(exist_ok=True)

    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    files_to_create = files_to_create or []
    files_to_modify = files_to_modify or []
    files_to_reference = files_to_reference or []

    # Default chunks if none provided
    if not chunks:
        chunks = [f"Implement {name}"]

    # 1. requirements.json
    requirements = {
        "task_description": description,
        "workflow_type": workflow_type,
        "services_involved": [name.replace("-", "_")],
        "created_at": timestamp
    }
    (spec_dir / "requirements.json").write_text(json.dumps(requirements, indent=2))

    # 2. context.json
    context = {
        "task_description": description,
        "files_to_modify": files_to_modify,
        "files_to_create": files_to_create,
        "files_to_reference": files_to_reference,
        "scoped_services": [name.replace("-", "_")]
    }
    (spec_dir / "context.json").write_text(json.dumps(context, indent=2))

    # 3. spec.md
    spec_md = f"""# {name.replace("-", " ").title()}

## Overview
{description}

## Workflow Type
{workflow_type.title()} - New implementation

## Task Scope
- Implement {name.replace("-", " ")}

## Files to Create
{chr(10).join(f"- {f}" for f in files_to_create) if files_to_create else "- (none specified)"}

## Files to Modify
{chr(10).join(f"- {f}" for f in files_to_modify) if files_to_modify else "- (none specified)"}

## Files to Reference
{chr(10).join(f"- {f}" for f in files_to_reference) if files_to_reference else "- (none specified)"}

## Success Criteria
1. Implementation complete and functional
2. All tests pass
3. Code follows project conventions

## QA Acceptance Criteria
- [ ] Implementation matches spec
- [ ] Tests pass
- [ ] No regressions
"""
    (spec_dir / "spec.md").write_text(spec_md)

    # 4. implementation_plan.json
    phase_chunks = []
    for i, chunk_desc in enumerate(chunks, 1):
        phase_chunks.append({
            "id": f"1.{i}",
            "description": chunk_desc,
            "status": "pending",
            "files": files_to_create + files_to_modify if files_to_create or files_to_modify else [f"{name.replace('-', '_')}.py"]
        })

    implementation_plan = {
        "feature": name.replace("-", "_"),
        "workflow_type": workflow_type,
        "phases": [
            {
                "phase": 1,
                "name": "Core Implementation",
                "chunks": phase_chunks
            }
        ],
        "status": "approved",
        "planStatus": "approved",
        "updated_at": timestamp
    }
    (spec_dir / "implementation_plan.json").write_text(json.dumps(implementation_plan, indent=2))

    # 5. review_state.json (CRITICAL - makes spec buildable)
    review_state = {
        "approved": True,
        "approved_by": "cli",
        "approved_at": timestamp,
        "feedback": [],
        "spec_hash": "",
        "review_count": 1
    }
    (spec_dir / "review_state.json").write_text(json.dumps(review_state, indent=2))

    return str(spec_dir)


def create_spec_from_json(
    project_dir: str,
    name: str,
    json_path: str,
) -> str:
    """Create a multi-phase spec from a JSON definition file.

    The JSON file format:
    {
      "description": "Overall description",
      "workflow_type": "feature",
      "spec_content": "Optional full spec.md content",
      "phases": [
        {
          "name": "Phase Name",
          "description": "Phase description",
          "depends_on": [1],  # Optional: list of phase numbers this depends on
          "chunks": [
            {
              "description": "What to implement",
              "files": ["file1.py", "file2.py"],
              "verification": "How to verify (optional)"
            }
          ]
        }
      ]
    }
    """
    project_path = Path(project_dir).resolve()
    specs_dir = project_path / ".auto-claude" / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)

    # Load JSON definition
    with open(json_path, 'r') as f:
        spec_def = json.load(f)

    description = spec_def.get("description", f"Implement {name}")
    workflow_type = spec_def.get("workflow_type", "feature")
    phases_def = spec_def.get("phases", [])

    if not phases_def:
        raise ValueError("JSON must contain 'phases' array with at least one phase")

    # Get next spec number
    spec_num = get_next_spec_number(specs_dir)
    spec_id = f"{spec_num:03d}-{name}"
    spec_dir = specs_dir / spec_id
    spec_dir.mkdir(exist_ok=True)

    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    # 1. requirements.json
    requirements = {
        "task_description": description,
        "workflow_type": workflow_type,
        "services_involved": [name.replace("-", "_")],
        "created_at": timestamp
    }
    (spec_dir / "requirements.json").write_text(json.dumps(requirements, indent=2))

    # 2. context.json - collect all files from all phases
    all_files = []
    for phase in phases_def:
        for chunk in phase.get("chunks", []):
            all_files.extend(chunk.get("files", []))

    context = {
        "task_description": description,
        "files_to_modify": [],
        "files_to_create": list(set(all_files)),
        "files_to_reference": [],
        "scoped_services": [name.replace("-", "_")]
    }
    (spec_dir / "context.json").write_text(json.dumps(context, indent=2))

    # 3. spec.md - use custom content or generate
    if "spec_content" in spec_def:
        spec_md = spec_def["spec_content"]
    else:
        phase_descriptions = []
        for i, phase in enumerate(phases_def, 1):
            phase_name = phase.get("name", f"Phase {i}")
            phase_desc = phase.get("description", "")
            deps = phase.get("depends_on", [])
            dep_str = f" (depends on phases: {deps})" if deps else ""
            phase_descriptions.append(f"### Phase {i}: {phase_name}{dep_str}\n{phase_desc}")

        spec_md = f"""# {name.replace("-", " ").title()}

## Overview
{description}

## Workflow Type
{workflow_type.title()} - Implementation

## Phases

{chr(10).join(phase_descriptions)}

## Success Criteria
1. All phases complete successfully
2. All tests pass
3. Code follows project conventions

## QA Acceptance Criteria
- [ ] All implementation phases complete
- [ ] Tests pass
- [ ] No regressions
"""
    (spec_dir / "spec.md").write_text(spec_md)

    # 4. implementation_plan.json - with proper phases and chunks
    impl_phases = []
    for i, phase in enumerate(phases_def, 1):
        phase_chunks = []
        for j, chunk in enumerate(phase.get("chunks", []), 1):
            chunk_entry = {
                "id": f"{i}.{j}",
                "description": chunk.get("description", f"Implement chunk {j}"),
                "status": "pending",
                "files": chunk.get("files", [])
            }
            if "verification" in chunk:
                chunk_entry["verification"] = chunk["verification"]
            phase_chunks.append(chunk_entry)

        phase_entry = {
            "phase": i,
            "name": phase.get("name", f"Phase {i}"),
            "chunks": phase_chunks  # MUST be "chunks" not "subtasks"
        }
        if "description" in phase:
            phase_entry["description"] = phase["description"]
        if "depends_on" in phase:
            phase_entry["depends_on"] = phase["depends_on"]

        impl_phases.append(phase_entry)

    implementation_plan = {
        "feature": name.replace("-", "_"),
        "workflow_type": workflow_type,
        "phases": impl_phases,
        "status": "approved",
        "planStatus": "approved",
        "updated_at": timestamp
    }
    (spec_dir / "implementation_plan.json").write_text(json.dumps(implementation_plan, indent=2))

    # 5. review_state.json (CRITICAL - makes spec buildable)
    review_state = {
        "approved": True,
        "approved_by": "cli",
        "approved_at": timestamp,
        "feedback": [],
        "spec_hash": "",
        "review_count": 1
    }
    (spec_dir / "review_state.json").write_text(json.dumps(review_state, indent=2))

    return str(spec_dir)


def main():
    parser = argparse.ArgumentParser(
        description="Add a spec to Auto-Claude GUI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    parser.add_argument(
        "--project-dir", "-p",
        required=True,
        help="Path to the project directory"
    )
    parser.add_argument(
        "--name", "-n",
        required=True,
        help="Spec name (will be slugified, e.g., 'my-feature')"
    )
    parser.add_argument(
        "--description", "-d",
        required=True,
        help="Task description"
    )
    parser.add_argument(
        "--files-to-create", "-c",
        default="",
        help="Comma-separated list of files to create"
    )
    parser.add_argument(
        "--files-to-modify", "-m",
        default="",
        help="Comma-separated list of files to modify"
    )
    parser.add_argument(
        "--files-to-reference", "-r",
        default="",
        help="Comma-separated list of reference files"
    )
    parser.add_argument(
        "--workflow-type", "-w",
        default="feature",
        choices=["feature", "bugfix", "refactor", "docs"],
        help="Type of workflow (default: feature)"
    )
    parser.add_argument(
        "--chunks",
        default="",
        help="Comma-separated list of implementation chunks/subtasks"
    )

    args = parser.parse_args()

    # Parse comma-separated lists
    files_to_create = [f.strip() for f in args.files_to_create.split(",") if f.strip()]
    files_to_modify = [f.strip() for f in args.files_to_modify.split(",") if f.strip()]
    files_to_reference = [f.strip() for f in args.files_to_reference.split(",") if f.strip()]
    chunks = [c.strip() for c in args.chunks.split(",") if c.strip()]

    try:
        spec_dir = create_spec(
            project_dir=args.project_dir,
            name=args.name,
            description=args.description,
            files_to_create=files_to_create,
            files_to_modify=files_to_modify,
            files_to_reference=files_to_reference,
            workflow_type=args.workflow_type,
            chunks=chunks or None,
        )
        print(f"Created spec: {spec_dir}")
        print("Refresh the GUI to see the new spec.")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
