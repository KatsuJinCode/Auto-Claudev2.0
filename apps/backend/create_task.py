#!/usr/bin/env python3
"""
Create Task - Mimics the UI Form

This creates a task the SAME way the UI does:
- Creates spec directory with minimal files
- Does NOT create spec.md (so spec pipeline will run when started)
- Does NOT create implementation plan phases (so planning will run)

When you start this task in the GUI, it triggers the FULL spec creation pipeline:
Discovery → Requirements → Context → Spec Writing → Planning → Validation

Usage:
    python create_task.py --project-dir /path/to/project --description "What to build"
    python create_task.py --project-dir /path/to/project --description "What to build" --title "Optional title"
    python create_task.py --project-dir /path/to/project --description "What to build" --category feature --priority high
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path


def slugify(text: str, max_length: int = 50) -> str:
    """Convert text to URL-friendly slug."""
    slug = text.lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug[:max_length]


def get_next_spec_number(specs_dir: Path) -> int:
    """Find the next available spec number."""
    if not specs_dir.exists():
        return 1

    existing_numbers = []
    for item in specs_dir.iterdir():
        if item.is_dir():
            match = re.match(r'^(\d+)', item.name)
            if match:
                existing_numbers.append(int(match.group(1)))

    return max(existing_numbers, default=0) + 1


def create_task(
    project_dir: str,
    description: str,
    title: str | None = None,
    category: str = "feature",
    priority: str | None = None,
    complexity: str | None = None,
    impact: str | None = None,
    depends_on: list[str] | None = None,
    auto_build_dir: str = ".auto-claude"
) -> str:
    """
    Create a task that will trigger the full spec pipeline when started.

    Returns the spec_id of the created task.
    """
    project_path = Path(project_dir).resolve()
    specs_dir = project_path / auto_build_dir / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)

    # Generate title if not provided (simple fallback - AI will do better in pipeline)
    if not title:
        title = description.split('\n')[0][:60]
        if len(description.split('\n')[0]) > 60:
            title += "..."

    # Generate spec ID
    spec_number = get_next_spec_number(specs_dir)
    slug = slugify(title)
    spec_id = f"{spec_number:03d}-{slug}"

    # Create spec directory
    spec_dir = specs_dir / spec_id
    spec_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.utcnow().isoformat() + "Z"

    # Create implementation_plan.json with EMPTY phases (triggers pipeline)
    implementation_plan = {
        "feature": title,
        "description": description,
        "created_at": now,
        "updated_at": now,
        "status": "pending",
        "phases": []  # EMPTY - this is key! Pipeline will fill this in.
    }

    plan_path = spec_dir / "implementation_plan.json"
    plan_path.write_text(json.dumps(implementation_plan, indent=2))

    # Create requirements.json
    requirements = {
        "task_description": description,
        "workflow_type": category
    }
    if depends_on:
        requirements["depends_on"] = depends_on

    req_path = spec_dir / "requirements.json"
    req_path.write_text(json.dumps(requirements, indent=2))

    # Create task_metadata.json
    metadata = {
        "sourceType": "cli",  # Mark as created via CLI
        "createdBy": "create_task.py"
    }
    if category:
        metadata["category"] = category
    if priority:
        metadata["priority"] = priority
    if complexity:
        metadata["complexity"] = complexity
    if impact:
        metadata["impact"] = impact

    metadata_path = spec_dir / "task_metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2))

    # DO NOT create spec.md - this ensures the spec pipeline runs!
    # DO NOT create context.json - pipeline creates this
    # DO NOT create review_state.json - pipeline creates this

    print(f"Created task: {spec_id}")
    print(f"  Directory: {spec_dir}")
    print(f"  Title: {title}")
    print(f"  Description: {description[:100]}{'...' if len(description) > 100 else ''}")
    print()
    print("Next steps:")
    print("  1. Refresh the Auto-Claude GUI")
    print("  2. Find the task in the 'Planning' column")
    print("  3. Click 'Start' to run the FULL spec creation pipeline")
    print()
    print("The pipeline will run: Discovery -> Requirements -> Context -> Spec Writing -> Planning")

    return spec_id


def main():
    parser = argparse.ArgumentParser(
        description="Create a task that triggers the full spec pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Simple task
  python create_task.py --project-dir /path/to/project \\
    --description "Add dark mode toggle to settings page"

  # With optional metadata
  python create_task.py --project-dir /path/to/project \\
    --description "Fix login timeout bug" \\
    --title "Login Timeout Fix" \\
    --category bug_fix \\
    --priority high

  # From a file
  python create_task.py --project-dir /path/to/project \\
    --description-file my_feature.txt
"""
    )

    parser.add_argument(
        "--project-dir",
        required=True,
        help="Path to the project directory"
    )

    desc_group = parser.add_mutually_exclusive_group(required=True)
    desc_group.add_argument(
        "--description",
        help="Task description (what to build)"
    )
    desc_group.add_argument(
        "--description-file",
        help="File containing the task description"
    )

    parser.add_argument(
        "--title",
        help="Optional task title (auto-generated if not provided)"
    )

    parser.add_argument(
        "--category",
        choices=["feature", "bug_fix", "refactoring", "documentation",
                 "security", "performance", "ui_ux", "infrastructure", "testing"],
        default="feature",
        help="Task category (default: feature)"
    )

    parser.add_argument(
        "--priority",
        choices=["low", "medium", "high", "urgent"],
        help="Task priority"
    )

    parser.add_argument(
        "--complexity",
        choices=["trivial", "small", "medium", "large", "complex"],
        help="Task complexity"
    )

    parser.add_argument(
        "--impact",
        choices=["low", "medium", "high", "critical"],
        help="Task impact"
    )

    parser.add_argument(
        "--depends-on",
        help="Comma-separated list of spec IDs this task depends on (e.g., '001-base,002-core')"
    )

    args = parser.parse_args()

    # Get description
    if args.description_file:
        desc_path = Path(args.description_file)
        if not desc_path.exists():
            print(f"Error: Description file not found: {args.description_file}", file=sys.stderr)
            sys.exit(1)
        description = desc_path.read_text().strip()
    else:
        description = args.description

    if not description:
        print("Error: Description cannot be empty", file=sys.stderr)
        sys.exit(1)

    # Validate project directory
    project_path = Path(args.project_dir)
    if not project_path.exists():
        print(f"Error: Project directory not found: {args.project_dir}", file=sys.stderr)
        sys.exit(1)

    # Parse depends-on
    depends_on = None
    if args.depends_on:
        depends_on = [d.strip() for d in args.depends_on.split(',') if d.strip()]

    # Create the task
    spec_id = create_task(
        project_dir=args.project_dir,
        description=description,
        title=args.title,
        category=args.category,
        priority=args.priority,
        complexity=args.complexity,
        impact=args.impact,
        depends_on=depends_on
    )

    return spec_id


if __name__ == "__main__":
    main()
